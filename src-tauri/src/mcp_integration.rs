use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use chrono::Utc;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::RwLock,
    time::timeout,
};

use crate::{
    error::{AppError, AppResult},
    mcp_bridge::TOOL_NAMES,
    models::expand_home,
    runtime::{load_runtime, runtime_path},
};

const SERVER_NAME: &str = "service-console";

pub struct McpIntegration {
    data_dir: PathBuf,
    runtime_file: PathBuf,
    bridge: Option<PathBuf>,
    codex: Option<PathBuf>,
    last_test: RwLock<Option<Value>>,
}

impl McpIntegration {
    pub fn new(data_dir: impl AsRef<Path>) -> Arc<Self> {
        let data_dir = expand_home(data_dir);
        let current = std::env::current_exe().ok();
        let bridge_names: &[&str] = if cfg!(windows) {
            &["service-console-mcp.exe", "Service Console MCP.exe"]
        } else {
            &["service-console-mcp", "Service Console MCP"]
        };
        let bridge = current
            .as_ref()
            .and_then(|current| {
                bridge_names
                    .iter()
                    .map(|name| current.with_file_name(name))
                    .find(|path| path.is_file())
            })
            .or_else(|| find_on_path("service-console-mcp"));
        Self::with_paths(
            data_dir.clone(),
            runtime_path(&data_dir),
            bridge,
            find_on_path("codex"),
        )
    }

    pub fn with_paths(
        data_dir: PathBuf,
        runtime_file: PathBuf,
        bridge: Option<PathBuf>,
        codex: Option<PathBuf>,
    ) -> Arc<Self> {
        Arc::new(Self {
            data_dir,
            runtime_file,
            bridge,
            codex,
            last_test: RwLock::new(None),
        })
    }

    fn bridge_args(&self) -> Vec<String> {
        vec![
            "--runtime-file".into(),
            self.runtime_file.to_string_lossy().into_owned(),
            "--data-dir".into(),
            self.data_dir.to_string_lossy().into_owned(),
        ]
    }

    async fn registration(&self) -> AppResult<Option<Value>> {
        let Some(codex) = &self.codex else {
            return Ok(None);
        };
        let output = Command::new(codex)
            .args(["mcp", "get", SERVER_NAME, "--json"])
            .output()
            .await?;
        if !output.status.success() {
            return Ok(None);
        }
        serde_json::from_slice(&output.stdout)
            .map(Some)
            .map_err(AppError::from)
    }

    fn registration_is_current(&self, value: &Value) -> bool {
        let Some(bridge) = &self.bridge else {
            return false;
        };
        value["enabled"].as_bool().unwrap_or(false)
            && value["transport"]["type"] == "stdio"
            && value["transport"]["command"].as_str() == Some(bridge.to_string_lossy().as_ref())
            && value["transport"]["args"].as_array().is_some_and(|args| {
                args.iter()
                    .filter_map(Value::as_str)
                    .eq(self.bridge_args().iter().map(String::as_str))
            })
    }

    async fn controller_ready(&self) -> bool {
        let Ok(Some(connection)) = load_runtime(&self.runtime_file) else {
            return false;
        };
        reqwest::Client::new()
            .get(format!("{}api/health", connection.base_url))
            .bearer_auth(connection.token)
            .timeout(Duration::from_millis(1500))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
    }

    pub async fn status(&self) -> Value {
        let registration = self.registration().await;
        let error = registration.as_ref().err().map(ToString::to_string);
        let registered = registration
            .as_ref()
            .ok()
            .and_then(|value| value.as_ref())
            .is_some();
        let current = registration
            .as_ref()
            .ok()
            .and_then(|value| value.as_ref())
            .is_some_and(|value| self.registration_is_current(value));
        let bridge_available = self.bridge.is_some();
        let state = if error.is_some() {
            "error"
        } else if registered && !current {
            "conflict"
        } else if !bridge_available {
            "unavailable"
        } else if current {
            "installed"
        } else {
            "not_installed"
        };
        let args = self.bridge_args();
        let command = self
            .bridge
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        let snippet = command.as_ref().map(|command| {
            format!(
                "codex mcp add {SERVER_NAME} -- {}",
                shell_join(
                    std::iter::once(command.as_str()).chain(args.iter().map(String::as_str))
                )
            )
        });
        json!({"state":state,"transport":"stdio","controller_ready":self.controller_ready().await,"bridge_available":bridge_available,"codex_cli_available":self.codex.is_some(),"codex_registered":registered,"server_name":SERVER_NAME,"bridge_command":command,"bridge_args":args,"config_snippet":snippet,"tools":TOOL_NAMES,"last_test":self.last_test.read().await.clone(),"error":error})
    }

    pub async fn install(&self) -> AppResult<Value> {
        let codex = self
            .codex
            .as_ref()
            .ok_or_else(|| AppError::conflict("Codex CLI was not found"))?;
        let bridge = self
            .bridge
            .as_ref()
            .ok_or_else(|| AppError::conflict("Service Console MCP bridge was not found"))?;
        if let Some(registration) = self.registration().await? {
            if self.registration_is_current(&registration) {
                return Ok(self.status().await);
            }
            return Err(AppError::conflict(
                "A different service-console MCP registration already exists; remove it explicitly before installing",
            ));
        }
        let output = Command::new(codex)
            .args(["mcp", "add", SERVER_NAME, "--"])
            .arg(bridge)
            .args(self.bridge_args())
            .output()
            .await?;
        if !output.status.success() {
            return Err(AppError::conflict(command_error(
                &output,
                "Codex MCP registration failed",
            )));
        }
        Ok(self.status().await)
    }

    pub async fn remove(&self) -> AppResult<Value> {
        if self.registration().await?.is_some() {
            let codex = self
                .codex
                .as_ref()
                .ok_or_else(|| AppError::conflict("Codex CLI was not found"))?;
            let output = Command::new(codex)
                .args(["mcp", "remove", SERVER_NAME])
                .output()
                .await?;
            if !output.status.success() {
                return Err(AppError::conflict(command_error(
                    &output,
                    "Codex MCP removal failed",
                )));
            }
        }
        *self.last_test.write().await = None;
        Ok(self.status().await)
    }

    pub async fn test(&self) -> Value {
        let tested_at = Utc::now().to_rfc3339();
        let result = self.test_bridge().await;
        *self.last_test.write().await = Some(match result {
            Ok(()) => json!({"ok":true,"tested_at":tested_at,"error":null}),
            Err(error) => json!({"ok":false,"tested_at":tested_at,"error":error.to_string()}),
        });
        self.status().await
    }

    async fn test_bridge(&self) -> AppResult<()> {
        let bridge = self
            .bridge
            .as_ref()
            .ok_or_else(|| AppError::conflict("Service Console MCP bridge was not found"))?;
        let mut child = Command::new(bridge)
            .args(self.bridge_args())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Internal("MCP stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Internal("MCP stdout unavailable".into()))?;
        let mut lines = BufReader::new(stdout).lines();
        stdin.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"service-console-self-test\",\"version\":\"1\"}}}\n").await?;
        let initialized = timeout(Duration::from_secs(10), lines.next_line())
            .await
            .map_err(|_| AppError::conflict("MCP initialize timed out"))??
            .ok_or_else(|| AppError::conflict("MCP bridge exited during initialize"))?;
        let payload: Value = serde_json::from_str(&initialized)?;
        if payload.get("error").is_some() {
            return Err(AppError::conflict(format!(
                "MCP initialize failed: {}",
                payload["error"]
            )));
        }
        stdin.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}\n").await?;
        let listed = timeout(Duration::from_secs(10), lines.next_line())
            .await
            .map_err(|_| AppError::conflict("MCP tools/list timed out"))??
            .ok_or_else(|| AppError::conflict("MCP bridge exited during tools/list"))?;
        let payload: Value = serde_json::from_str(&listed)?;
        let names: std::collections::HashSet<_> = payload["result"]["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        let missing: Vec<_> = TOOL_NAMES
            .iter()
            .copied()
            .filter(|name| !names.contains(name))
            .collect();
        let _ = child.kill().await;
        if !missing.is_empty() {
            return Err(AppError::conflict(format!(
                "MCP bridge is missing tools: {}",
                missing.join(", ")
            )));
        }
        Ok(())
    }
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|path| {
                path.join(if cfg!(windows) {
                    format!("{name}.exe")
                } else {
                    name.into()
                })
            })
            .find(|path| path.is_file())
    })
}
fn shell_join<'a>(values: impl Iterator<Item = &'a str>) -> String {
    values
        .map(|value| {
            if value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-._/\\:".contains(c))
            {
                value.into()
            } else {
                format!("'{}'", value.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
fn command_error(output: &std::process::Output, fallback: &str) -> String {
    let detail = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(500)
        .collect::<String>();
    if detail.is_empty() {
        fallback.into()
    } else {
        format!("{fallback}: {detail}")
    }
}
