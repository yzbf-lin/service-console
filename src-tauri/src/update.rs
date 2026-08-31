use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, VerifyingKey, pkcs8::DecodePublicKey};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    fs::File,
    io::AsyncWriteExt,
    sync::{Mutex, RwLock},
};

use crate::{
    error::{AppError, AppResult},
    models::expand_home,
    update_helper::{installed_application, launch_helper, prepare_archive},
};

const MANIFEST_URL: &str =
    "https://github.com/yzbf-lin/service-console/releases/latest/download/latest-update.json";
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_SIGNATURE_BYTES: usize = 8 * 1024;
const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseAsset {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseManifest {
    pub schema: u32,
    pub version: String,
    pub release_url: String,
    pub published_at: String,
    pub notes: String,
    pub platforms: BTreeMap<String, ReleaseAsset>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    pub state: String,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_url: Option<String>,
    pub published_at: Option<String>,
    pub notes: Option<String>,
    pub platform: String,
    pub platform_supported: bool,
    pub can_install: bool,
    pub reason: Option<String>,
    pub error: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub download_progress: Option<f64>,
    pub downloaded: bool,
    pub restart_required: bool,
    #[serde(skip)]
    pub asset: Option<ReleaseAsset>,
    #[serde(skip)]
    pub package_path: Option<PathBuf>,
}

pub struct UpdateManager {
    data_dir: PathBuf,
    manifest_url: String,
    public_key: PathBuf,
    http: reqwest::Client,
    status: RwLock<UpdateStatus>,
    operation: Mutex<()>,
}

impl UpdateManager {
    pub fn new(data_dir: impl AsRef<Path>, public_key: impl AsRef<Path>) -> Arc<Self> {
        let platform = detect_platform();
        Arc::new(Self {
            data_dir: expand_home(data_dir),
            manifest_url: MANIFEST_URL.into(),
            public_key: public_key.as_ref().to_path_buf(),
            http: reqwest::Client::new(),
            operation: Mutex::new(()),
            status: RwLock::new(UpdateStatus {
                state: "idle".into(),
                current_version: env!("CARGO_PKG_VERSION").into(),
                latest_version: None,
                release_url: None,
                published_at: None,
                notes: None,
                platform,
                platform_supported: false,
                can_install: false,
                reason: None,
                error: None,
                downloaded_bytes: 0,
                total_bytes: None,
                download_progress: None,
                downloaded: false,
                restart_required: false,
                asset: None,
                package_path: None,
            }),
        })
    }

    pub async fn status(&self) -> UpdateStatus {
        self.status.read().await.clone()
    }

    pub async fn check(&self) -> AppResult<UpdateStatus> {
        let _operation = self.operation.lock().await;
        {
            let mut status = self.status.write().await;
            status.state = "checking".into();
            status.error = None;
        }
        let result = self.check_inner().await;
        if let Err(error) = &result {
            let mut status = self.status.write().await;
            status.state = "error".into();
            status.error = Some(error.to_string());
        }
        result
    }

    async fn check_inner(&self) -> AppResult<UpdateStatus> {
        let manifest_bytes = self
            .fetch_bounded(&self.manifest_url, MAX_MANIFEST_BYTES)
            .await?;
        let signature_bytes = self
            .fetch_bounded(&format!("{}.sig", self.manifest_url), MAX_SIGNATURE_BYTES)
            .await?;
        verify_signature(&manifest_bytes, &signature_bytes, &self.public_key)?;
        let manifest = parse_manifest(&manifest_bytes)?;
        let mut status = self.status.write().await;
        status.latest_version = Some(manifest.version.clone());
        status.release_url = Some(manifest.release_url.clone());
        status.published_at = Some(manifest.published_at.clone());
        status.notes = Some(manifest.notes.clone());
        status.downloaded = false;
        status.downloaded_bytes = 0;
        status.restart_required = false;
        status.package_path = None;
        status.can_install = false;
        if parse_semver(&manifest.version)? <= parse_semver(&status.current_version)? {
            status.state = "up_to_date".into();
            status.platform_supported = manifest.platforms.contains_key(&status.platform);
            status.reason = None;
            status.asset = None;
            status.total_bytes = None;
            status.download_progress = None;
            return Ok(status.clone());
        }
        let Some(asset) = manifest.platforms.get(&status.platform).cloned() else {
            status.state = "unsupported".into();
            status.platform_supported = false;
            status.reason = Some("No signed update package is published for this platform".into());
            status.asset = None;
            status.total_bytes = None;
            status.download_progress = None;
            return Ok(status.clone());
        };
        validate_asset(&manifest.version, &status.platform, &asset)?;
        status.state = "available".into();
        status.platform_supported = true;
        match installed_application() {
            Ok(_) => {
                status.can_install = true;
                status.reason = None;
            }
            Err(error) => {
                status.can_install = false;
                status.reason = Some(error.to_string());
            }
        }
        status.total_bytes = Some(asset.size);
        status.download_progress = Some(0.0);
        status.asset = Some(asset);
        Ok(status.clone())
    }

    pub async fn download(&self) -> AppResult<UpdateStatus> {
        let _operation = self.operation.lock().await;
        let result = self.download_inner().await;
        if let Err(error) = &result {
            let mut status = self.status.write().await;
            status.state = "error".into();
            status.error = Some(error.to_string());
        }
        result
    }

    async fn download_inner(&self) -> AppResult<UpdateStatus> {
        let (asset, version) = {
            let mut status = self.status.write().await;
            let asset = status.asset.clone().ok_or_else(|| {
                AppError::conflict("Check for an available update before downloading")
            })?;
            let version = status
                .latest_version
                .clone()
                .ok_or_else(|| AppError::conflict("Update version is missing"))?;
            status.state = "downloading".into();
            status.error = None;
            (asset, version)
        };
        let directory = self.data_dir.join("updates").join(format!("v{version}"));
        tokio::fs::create_dir_all(&directory).await?;
        let package = directory.join(&asset.filename);
        let part = package.with_extension(format!(
            "{}part",
            package
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| format!("{value}."))
                .unwrap_or_default()
        ));
        let response = self
            .http
            .get(&asset.url)
            .send()
            .await
            .map_err(|error| AppError::conflict(format!("update package request failed: {error}")))?
            .error_for_status()
            .map_err(|error| {
                AppError::conflict(format!("update package request failed: {error}"))
            })?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_PACKAGE_BYTES || size != asset.size)
        {
            return Err(AppError::conflict(
                "update package size does not match the signed manifest",
            ));
        }
        let mut file = File::create(&part).await?;
        let mut hash = Sha256::new();
        let mut downloaded = 0_u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| AppError::conflict(error.to_string()))?;
            downloaded += chunk.len() as u64;
            if downloaded > MAX_PACKAGE_BYTES || downloaded > asset.size {
                let _ = tokio::fs::remove_file(&part).await;
                return Err(AppError::conflict(
                    "update package exceeded the signed size",
                ));
            }
            hash.update(&chunk);
            file.write_all(&chunk).await?;
            let mut status = self.status.write().await;
            status.downloaded_bytes = downloaded;
            status.download_progress = Some(downloaded as f64 * 100.0 / asset.size as f64);
        }
        file.sync_all().await?;
        drop(file);
        if downloaded != asset.size || hex::encode(hash.finalize()) != asset.sha256 {
            let _ = tokio::fs::remove_file(&part).await;
            let mut status = self.status.write().await;
            status.state = "error".into();
            status.error = Some("update package integrity verification failed".into());
            return Err(AppError::conflict(
                "update package integrity verification failed",
            ));
        }
        tokio::fs::rename(&part, &package).await?;
        let mut status = self.status.write().await;
        status.state = "downloaded".into();
        status.downloaded = true;
        status.download_progress = Some(100.0);
        status.package_path = Some(package);
        Ok(status.clone())
    }

    pub async fn install(&self) -> AppResult<UpdateStatus> {
        let _operation = self.operation.lock().await;
        let result = self.install_inner().await;
        if let Err(error) = &result {
            let mut status = self.status.write().await;
            status.state = "error".into();
            status.error = Some(error.to_string());
        }
        result
    }

    async fn install_inner(&self) -> AppResult<UpdateStatus> {
        let (package, version, platform, asset) = {
            let mut status = self.status.write().await;
            let package = status
                .package_path
                .clone()
                .filter(|path| path.is_file())
                .ok_or_else(|| AppError::conflict("Download the update before installing it"))?;
            let version = status
                .latest_version
                .clone()
                .ok_or_else(|| AppError::conflict("Update version is missing"))?;
            let asset = status
                .asset
                .clone()
                .ok_or_else(|| AppError::conflict("Update asset is missing"))?;
            status.state = "installing".into();
            status.error = None;
            (package, version, status.platform.clone(), asset)
        };
        let installed = installed_application()?;
        let prepared_dir = package
            .parent()
            .ok_or_else(|| AppError::Internal("update package has no parent directory".into()))?
            .join("prepared-rust");
        let package_for_prepare = package.clone();
        let platform_for_prepare = platform.clone();
        let version_for_prepare = version.clone();
        let installed_for_prepare = installed.clone();
        let prepared = tokio::task::spawn_blocking(move || {
            verify_downloaded_package(&package_for_prepare, &asset)?;
            prepare_archive(
                &package_for_prepare,
                &prepared_dir,
                &platform_for_prepare,
                &installed_for_prepare,
                &version_for_prepare,
            )
        })
        .await
        .map_err(|error| {
            AppError::Internal(format!("update preparation task failed: {error}"))
        })??;
        let helper_dir = package
            .parent()
            .ok_or_else(|| AppError::Internal("update package has no parent directory".into()))?;
        launch_helper(&prepared, &installed, helper_dir).await?;

        let mut status = self.status.write().await;
        status.state = "restarting".into();
        status.restart_required = true;
        status.can_install = false;
        status.reason = Some("The desktop application is restarting to finish the update".into());
        Ok(status.clone())
    }

    async fn fetch_bounded(&self, url: &str, limit: usize) -> AppResult<Vec<u8>> {
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|error| {
                AppError::conflict(format!("update metadata request failed: {error}"))
            })?
            .error_for_status()
            .map_err(|error| {
                AppError::conflict(format!(
                    "update metadata request failed: HTTP {}",
                    error.status().map(|value| value.as_u16()).unwrap_or(0)
                ))
            })?;
        if response
            .content_length()
            .is_some_and(|size| size > limit as u64)
        {
            return Err(AppError::conflict(
                "update metadata exceeded its size limit",
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| AppError::conflict(error.to_string()))?;
        if bytes.len() > limit {
            return Err(AppError::conflict(
                "update metadata exceeded its size limit",
            ));
        }
        Ok(bytes.to_vec())
    }
}

fn verify_downloaded_package(path: &Path, asset: &ReleaseAsset) -> AppResult<()> {
    use std::io::Read;
    let metadata = fs::metadata(path)?;
    if metadata.len() != asset.size {
        return Err(AppError::conflict(
            "The downloaded update size no longer matches the signed manifest",
        ));
    }
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        hash.update(&buffer[..length]);
    }
    if hex::encode(hash.finalize()) != asset.sha256 {
        return Err(AppError::conflict(
            "The downloaded update hash no longer matches the signed manifest",
        ));
    }
    Ok(())
}

pub fn detect_platform() -> String {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64".into(),
        ("macos", "x86_64") => "darwin-x86_64".into(),
        ("windows", "x86_64") => "windows-x86_64".into(),
        ("linux", "x86_64") => "linux-x86_64".into(),
        (os, arch) => format!("{os}-{arch}"),
    }
}
pub fn parse_semver(value: &str) -> AppResult<(u64, u64, u64)> {
    let parts: value_parser::Semver = value
        .parse()
        .map_err(|_| AppError::bad_request(format!("Invalid release version: {value:?}")))?;
    Ok((parts.0, parts.1, parts.2))
}

mod value_parser {
    pub struct Semver(pub u64, pub u64, pub u64);
    impl std::str::FromStr for Semver {
        type Err = ();
        fn from_str(value: &str) -> Result<Self, Self::Err> {
            let parts: Vec<_> = value.split('.').collect();
            if parts.len() != 3
                || parts.iter().any(|part| {
                    part.is_empty()
                        || (part.len() > 1 && part.starts_with('0'))
                        || !part.chars().all(|c| c.is_ascii_digit())
                })
            {
                return Err(());
            }
            Ok(Self(
                parts[0].parse().map_err(|_| ())?,
                parts[1].parse().map_err(|_| ())?,
                parts[2].parse().map_err(|_| ())?,
            ))
        }
    }
}

fn verify_signature(manifest: &[u8], signature: &[u8], public_key: &Path) -> AppResult<()> {
    let pem = fs::read_to_string(public_key)?;
    let key = VerifyingKey::from_public_key_pem(&pem)
        .map_err(|_| AppError::conflict("The update public key is invalid"))?;
    let decoded = STANDARD
        .decode(String::from_utf8_lossy(signature).trim())
        .map_err(|_| AppError::conflict("The update manifest signature encoding is invalid"))?;
    let signature = Signature::from_slice(&decoded)
        .map_err(|_| AppError::conflict("The update manifest signature is invalid"))?;
    key.verify_strict(manifest, &signature)
        .map_err(|_| AppError::conflict("The update manifest signature is invalid"))
}
fn parse_manifest(bytes: &[u8]) -> AppResult<ReleaseManifest> {
    let manifest: ReleaseManifest = serde_json::from_slice(bytes)?;
    if manifest.schema != 1 {
        return Err(AppError::conflict("Unsupported update manifest schema"));
    }
    parse_semver(&manifest.version)?;
    if !manifest
        .release_url
        .starts_with("https://github.com/yzbf-lin/service-console/releases/")
    {
        return Err(AppError::conflict("Update release URL is not trusted"));
    }
    Ok(manifest)
}
fn validate_asset(version: &str, platform: &str, asset: &ReleaseAsset) -> AppResult<()> {
    if asset.size == 0 || asset.size > MAX_PACKAGE_BYTES {
        return Err(AppError::conflict("Update package size is invalid"));
    }
    if asset.sha256.len() != 64
        || !asset
            .sha256
            .chars()
            .all(|c| c.is_ascii_hexdigit() && (!c.is_ascii_alphabetic() || c.is_ascii_lowercase()))
    {
        return Err(AppError::conflict("Update package SHA-256 is invalid"));
    }
    let expected = match platform {
        "darwin-arm64" => format!("Service-Console-v{version}-macOS-arm64.zip"),
        "windows-x86_64" => format!("Service-Console-v{version}-Windows-x64.zip"),
        _ => asset.filename.clone(),
    };
    if asset.filename != expected
        || !asset
            .url
            .starts_with("https://github.com/yzbf-lin/service-console/releases/download/")
        || !asset.url.ends_with(&format!("/{}", asset.filename))
    {
        return Err(AppError::conflict(format!(
            "Update package must be named {expected}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};
    use spki::der::pem::LineEnding;
    use tempfile::tempdir;

    #[test]
    fn semver_is_strict() {
        assert_eq!(parse_semver("12.3.45").unwrap(), (12, 3, 45));
        for value in ["v1.2.3", "1.2", "1.2.3-beta", "01.2.3"] {
            assert!(parse_semver(value).is_err());
        }
    }

    #[test]
    fn verifies_ed25519_manifest_signature() {
        let directory = tempdir().unwrap();
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let public_key = directory.path().join("key.pem");
        fs::write(
            &public_key,
            key.verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .unwrap(),
        )
        .unwrap();
        let manifest = b"{\"schema\":1}";
        let signature = STANDARD.encode(key.sign(manifest).to_bytes());
        verify_signature(manifest, signature.as_bytes(), &public_key).unwrap();
        assert!(verify_signature(b"changed", signature.as_bytes(), &public_key).is_err());
    }
}
