use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::expand_home,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeConnection {
    pub instance_id: String,
    pub pid: u32,
    pub base_url: String,
    pub token: String,
    pub started_at: String,
    #[serde(default = "runtime_version")]
    pub version: u32,
}

fn runtime_version() -> u32 {
    1
}

impl RuntimeConnection {
    pub fn new(base_url: String, token: String) -> Self {
        Self {
            instance_id: Uuid::new_v4().to_string(),
            pid: std::process::id(),
            base_url,
            token,
            started_at: Utc::now().to_rfc3339(),
            version: 1,
        }
    }

    pub fn validate(&self) -> AppResult<()> {
        if self.version != 1 {
            return Err(AppError::bad_request(format!(
                "unsupported desktop controller descriptor version: {}",
                self.version
            )));
        }
        if self.instance_id.is_empty() || self.token.is_empty() || self.started_at.is_empty() {
            return Err(AppError::bad_request(
                "desktop controller descriptor contains empty fields",
            ));
        }
        if self.pid == 0 {
            return Err(AppError::bad_request(
                "desktop controller PID must be positive",
            ));
        }
        let url = url::Url::parse(&self.base_url)
            .map_err(|_| AppError::bad_request("desktop controller URL is invalid"))?;
        let loopback = matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("::1")
        );
        if url.scheme() != "http" || !loopback || url.port().is_none() || url.path() != "/" {
            return Err(AppError::bad_request(
                "desktop controller URL must be an uncredentialed HTTP loopback URL",
            ));
        }
        Ok(())
    }
}

pub fn runtime_path(data_dir: impl AsRef<Path>) -> PathBuf {
    expand_home(data_dir).join("controller.json")
}

pub fn write_runtime(path: impl AsRef<Path>, connection: &RuntimeConnection) -> AppResult<()> {
    connection.validate()?;
    let path = expand_home(path);
    let parent = path
        .parent()
        .ok_or_else(|| AppError::bad_request("invalid runtime path"))?;
    fs::create_dir_all(parent)?;
    match load_runtime(&path)? {
        Some(current) if current.instance_id != connection.instance_id => {
            return Err(AppError::conflict(
                "another desktop controller is already active",
            ));
        }
        None if path.exists() => fs::remove_file(&path)?,
        _ => {}
    }
    let temporary = parent.join(format!(".controller-{}.tmp", Uuid::new_v4()));
    let mut encoded = serde_json::to_vec_pretty(connection)?;
    encoded.push(b'\n');
    fs::write(&temporary, encoded)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

pub fn load_runtime(path: impl AsRef<Path>) -> AppResult<Option<RuntimeConnection>> {
    let path = expand_home(path);
    if !path.exists() {
        return Ok(None);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(&path)?.permissions().mode() & 0o077 != 0 {
            return Err(AppError::bad_request(
                "desktop controller descriptor permissions must be 0600",
            ));
        }
    }
    let connection: RuntimeConnection = serde_json::from_slice(&fs::read(path)?)?;
    connection.validate()?;
    Ok(process_exists(connection.pid).then_some(connection))
}

pub fn remove_runtime(path: impl AsRef<Path>, instance_id: &str) -> AppResult<bool> {
    let path = expand_home(path);
    let Some(connection) = load_runtime(&path)? else {
        return Ok(false);
    };
    if connection.instance_id != instance_id {
        return Ok(false);
    }
    fs::remove_file(path)?;
    Ok(true)
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    if pid > i32::MAX as u32 {
        return false;
    }
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    system.process(Pid::from_u32(pid)).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn ignores_a_descriptor_owned_by_a_dead_process() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("controller.json");
        let connection = RuntimeConnection {
            instance_id: "dead".into(),
            pid: u32::MAX,
            base_url: "http://127.0.0.1:9876/".into(),
            token: "token".into(),
            started_at: "2026-01-01T00:00:00Z".into(),
            version: 1,
        };
        let mut encoded = serde_json::to_vec(&connection).unwrap();
        encoded.push(b'\n');
        fs::write(&path, encoded).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(load_runtime(path).unwrap().is_none());
    }

    #[test]
    fn replaces_a_descriptor_owned_by_a_dead_process() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("controller.json");
        let stale = RuntimeConnection {
            instance_id: "dead".into(),
            pid: u32::MAX,
            base_url: "http://127.0.0.1:9876/".into(),
            token: "stale-token".into(),
            started_at: "2026-01-01T00:00:00Z".into(),
            version: 1,
        };
        fs::write(&path, serde_json::to_vec(&stale).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }

        let current =
            RuntimeConnection::new("http://127.0.0.1:9877/".into(), "current-token".into());
        write_runtime(&path, &current).unwrap();
        assert_eq!(load_runtime(path).unwrap(), Some(current));
    }
}
