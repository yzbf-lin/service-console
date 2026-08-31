use std::{
    collections::BTreeMap,
    env, fs,
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use clap::Parser;
use ed25519_dalek::{
    Signer, SigningKey, VerifyingKey,
    pkcs8::{DecodePrivateKey, DecodePublicKey},
};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Parser)]
#[command(name = "service-console-release")]
struct Args {
    #[arg(long)]
    version: String,
    #[arg(long)]
    repository: String,
    #[arg(long, default_value = "release")]
    release_dir: PathBuf,
    #[arg(long, default_value = "release/latest-update.json")]
    output: PathBuf,
    #[arg(long, default_value = "release/latest-update.json.sig")]
    signature_output: PathBuf,
    #[arg(long, default_value = "src-tauri/resources/update_public_key.pem")]
    public_key: PathBuf,
    #[arg(long)]
    published_at: String,
}

#[derive(Serialize)]
struct Manifest {
    schema: u32,
    version: String,
    release_url: String,
    published_at: String,
    notes: String,
    platforms: BTreeMap<String, Asset>,
}

#[derive(Serialize)]
struct Asset {
    filename: String,
    url: String,
    sha256: String,
    size: u64,
}

fn main() -> Result<()> {
    let args = Args::parse();
    validate_version(&args.version)?;
    validate_repository(&args.repository)?;
    let private_key = signing_key()?;
    let public_pem = fs::read_to_string(&args.public_key)
        .with_context(|| format!("failed to read {}", args.public_key.display()))?;
    let expected_public = VerifyingKey::from_public_key_pem(&public_pem)
        .context("embedded update public key is invalid")?;
    if private_key.verifying_key() != expected_public {
        bail!("the signing key does not match the public key embedded in the app");
    }

    let tag = format!("v{}", args.version);
    let mut platforms = BTreeMap::new();
    for (platform, filename) in [
        (
            "darwin-arm64",
            format!("Service-Console-v{}-macOS-arm64.zip", args.version),
        ),
        (
            "windows-x86_64",
            format!("Service-Console-v{}-Windows-x64.zip", args.version),
        ),
    ] {
        let path = args.release_dir.join(&filename);
        let size = fs::metadata(&path)
            .with_context(|| format!("missing release artifact: {}", path.display()))?
            .len();
        if size == 0 {
            bail!("release artifact is empty: {}", path.display());
        }
        platforms.insert(
            platform.into(),
            Asset {
                url: format!(
                    "https://github.com/{}/releases/download/{tag}/{filename}",
                    args.repository
                ),
                sha256: sha256(&path)?,
                size,
                filename,
            },
        );
    }
    let manifest = Manifest {
        schema: 1,
        version: args.version,
        release_url: format!("https://github.com/{}/releases/tag/{tag}", args.repository),
        published_at: args.published_at,
        notes: String::new(),
        platforms,
    };
    let mut payload = serde_json::to_vec_pretty(&manifest)?;
    payload.push(b'\n');
    let signature = STANDARD.encode(private_key.sign(&payload).to_bytes());
    if let Some(parent) = args.output.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Some(parent) = args.signature_output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(args.output, payload)?;
    fs::write(args.signature_output, format!("{signature}\n"))?;
    Ok(())
}

fn signing_key() -> Result<SigningKey> {
    let value = env::var("UPDATE_PRIVATE_KEY_B64").context("UPDATE_PRIVATE_KEY_B64 is required")?;
    let pem = STANDARD
        .decode(value.trim())
        .context("UPDATE_PRIVATE_KEY_B64 is not valid base64")?;
    let pem = String::from_utf8(pem).context("the decoded signing key is not PEM text")?;
    SigningKey::from_pkcs8_pem(&pem).context("the signing key is not an Ed25519 PKCS#8 key")
}

fn validate_repository(value: &str) -> Result<()> {
    let parts: Vec<_> = value.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || !part
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
        })
    {
        bail!("repository must use OWNER/NAME format");
    }
    Ok(())
}

fn validate_version(value: &str) -> Result<()> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || (part.len() > 1 && part.starts_with('0'))
                || !part.chars().all(|character| character.is_ascii_digit())
        })
    {
        bail!("version must use strict X.Y.Z format");
    }
    Ok(())
}

fn sha256(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        hash.update(&buffer[..length]);
    }
    Ok(hex::encode(hash.finalize()))
}
