use std::{
    collections::{BTreeMap, VecDeque},
    path::Path,
    sync::Arc,
    time::Instant,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

fn default_cwd() -> String {
    ".".into()
}

fn default_stop_timeout() -> f64 {
    5.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServiceDefinition {
    pub name: String,
    #[serde(default)]
    pub group: Option<String>,
    pub command: String,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "default_stop_timeout")]
    pub stop_timeout: f64,
}

impl ServiceDefinition {
    pub fn normalize(mut self) -> AppResult<Self> {
        self.name = self.name.trim().to_owned();
        self.group = self
            .group
            .take()
            .map(|group| group.trim().to_owned())
            .filter(|group| !group.is_empty());
        self.command = self.command.trim().to_owned();
        self.cwd = normalize_cwd(&self.cwd);
        if self.name.is_empty() {
            return Err(AppError::bad_request("service name must not be empty"));
        }
        if self.name.contains('\0') {
            return Err(AppError::bad_request(
                "service name must not contain a null byte",
            ));
        }
        if let Some(group) = self.group.as_deref() {
            validate_group_name(group)?;
        }
        if self.command.is_empty() {
            return Err(AppError::bad_request("service command must not be empty"));
        }
        if self.cwd.is_empty() {
            return Err(AppError::bad_request("service cwd must not be empty"));
        }
        if !self.stop_timeout.is_finite() || self.stop_timeout < 0.0 {
            return Err(AppError::bad_request(
                "stop_timeout must be greater than or equal to zero",
            ));
        }
        Ok(self)
    }
}

pub fn normalize_group_name(value: &str) -> AppResult<String> {
    let group = value.trim();
    validate_group_name(group)?;
    Ok(group.to_owned())
}

fn validate_group_name(group: &str) -> AppResult<()> {
    if group.is_empty() {
        return Err(AppError::bad_request("group name must not be empty"));
    }
    if group.chars().count() > 80 {
        return Err(AppError::bad_request(
            "group name must not exceed 80 characters",
        ));
    }
    if matches!(group, "." | "..") {
        return Err(AppError::bad_request(
            "group name must not be a relative path segment",
        ));
    }
    if group.chars().any(char::is_control) {
        return Err(AppError::bad_request(
            "group name must not contain control characters",
        ));
    }
    Ok(())
}

fn normalize_cwd(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        let quote = bytes[0];
        if (quote == b'\'' || quote == b'"') && bytes[trimmed.len() - 1] == quote {
            return trimmed[1..trimmed.len() - 1].trim().to_owned();
        }
    }
    trimmed.to_owned()
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum ServiceState {
    #[default]
    Stopped,
    Starting,
    Running,
    Stopping,
    Exited,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LogEntry {
    pub timestamp: String,
    pub stream: String,
    pub message: String,
}

impl LogEntry {
    pub fn new(stream: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            timestamp: Utc::now().to_rfc3339(),
            stream: stream.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug)]
pub struct ManagedService {
    pub definition: ServiceDefinition,
    pub state: ServiceState,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub started_at: Option<DateTime<Utc>>,
    pub stopped_at: Option<DateTime<Utc>>,
    pub started_instant: Option<Instant>,
    pub cpu_percent: f32,
    pub memory_rss: u64,
    pub restart_count: u64,
    pub successful_starts: u64,
    pub last_error: Option<String>,
    pub generation: u64,
    pub guardian_registration_id: Option<String>,
    pub lifecycle_lock: Arc<tokio::sync::Mutex<()>>,
    pub logs: VecDeque<LogEntry>,
}

impl ManagedService {
    pub fn new(definition: ServiceDefinition, logs: Vec<LogEntry>) -> Self {
        Self {
            definition,
            state: ServiceState::Stopped,
            pid: None,
            exit_code: None,
            started_at: None,
            stopped_at: None,
            started_instant: None,
            cpu_percent: 0.0,
            memory_rss: 0,
            restart_count: 0,
            successful_starts: 0,
            last_error: None,
            generation: 0,
            guardian_registration_id: None,
            lifecycle_lock: Arc::new(tokio::sync::Mutex::new(())),
            logs: logs.into(),
        }
    }

    pub fn snapshot(&self) -> ServiceSnapshot {
        ServiceSnapshot {
            name: self.definition.name.clone(),
            group: self.definition.group.clone(),
            command: self.definition.command.clone(),
            cwd: self.definition.cwd.clone(),
            env: self.definition.env.clone(),
            auto_start: self.definition.auto_start,
            stop_timeout: self.definition.stop_timeout,
            state: self.state,
            pid: self.pid,
            exit_code: self.exit_code,
            started_at: self.started_at.map(|value| value.to_rfc3339()),
            stopped_at: self.stopped_at.map(|value| value.to_rfc3339()),
            cpu_percent: self.cpu_percent,
            memory_rss: self.memory_rss,
            uptime_seconds: self
                .started_instant
                .map(|value| value.elapsed().as_secs_f64())
                .unwrap_or(0.0),
            restart_count: self.restart_count,
            last_error: self.last_error.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServiceSnapshot {
    pub name: String,
    pub group: Option<String>,
    pub command: String,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub auto_start: bool,
    pub stop_timeout: f64,
    pub state: ServiceState,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub started_at: Option<String>,
    pub stopped_at: Option<String>,
    pub cpu_percent: f32,
    pub memory_rss: u64,
    pub uptime_seconds: f64,
    pub restart_count: u64,
    pub last_error: Option<String>,
}

pub fn expand_home(path: impl AsRef<Path>) -> std::path::PathBuf {
    let path = path.as_ref();
    let text = path.to_string_lossy();
    if text == "~" {
        return dirs::home_dir().unwrap_or_else(|| path.to_path_buf());
    }
    if let Some(rest) = text.strip_prefix("~/")
        && let Some(home) = dirs::home_dir()
    {
        return home.join(rest);
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition(cwd: &str) -> ServiceDefinition {
        ServiceDefinition {
            name: " demo ".into(),
            group: None,
            command: " echo ok ".into(),
            cwd: cwd.into(),
            env: BTreeMap::new(),
            auto_start: false,
            stop_timeout: 5.0,
        }
    }

    #[test]
    fn normalizes_wrapped_working_directory_without_losing_spaces() {
        let value = definition("'/tmp/path with spaces'").normalize().unwrap();
        assert_eq!(value.name, "demo");
        assert_eq!(value.command, "echo ok");
        assert_eq!(value.cwd, "/tmp/path with spaces");
    }

    #[test]
    fn rejects_invalid_definition() {
        let mut value = definition(".");
        value.stop_timeout = -1.0;
        assert!(value.normalize().is_err());
    }

    #[test]
    fn normalizes_and_validates_group_names() {
        let mut value = definition(".");
        value.group = Some("  Backend  ".into());
        assert_eq!(value.normalize().unwrap().group.as_deref(), Some("Backend"));

        let mut empty = definition(".");
        empty.group = Some("   ".into());
        assert_eq!(empty.normalize().unwrap().group, None);

        assert!(normalize_group_name("line\nbreak").is_err());
        assert!(normalize_group_name("..").is_err());
        assert!(normalize_group_name(&"x".repeat(81)).is_err());
    }
}
