use std::{
    collections::BTreeMap,
    ffi::OsStr,
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
    shell_environment::resolve_desktop_service_environment,
};

const SERVER_NAME: &str = "service-console";

pub struct McpIntegration {
    data_dir: PathBuf,
    runtime_file: PathBuf,
    bridge: Option<PathBuf>,
    codex: Option<PathBuf>,
    command_environment: BTreeMap<String, String>,
    last_test: RwLock<Option<Value>>,
}

impl McpIntegration {
    pub fn new(data_dir: impl AsRef<Path>) -> Arc<Self> {
        let data_dir = expand_home(data_dir);
        let command_environment = resolve_desktop_service_environment();
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
            .or_else(|| {
                find_on_path(
                    "service-console-mcp",
                    command_environment.get("PATH").map(OsStr::new),
                )
            });
        Self::with_paths_and_environment(
            data_dir.clone(),
            runtime_path(&data_dir),
            bridge,
            find_on_path("codex", command_environment.get("PATH").map(OsStr::new)),
            command_environment,
        )
    }

    pub fn with_paths(
        data_dir: PathBuf,
        runtime_file: PathBuf,
        bridge: Option<PathBuf>,
        codex: Option<PathBuf>,
    ) -> Arc<Self> {
        Self::with_paths_and_environment(
            data_dir,
            runtime_file,
            bridge,
            codex,
            std::env::vars().collect(),
        )
    }

    fn with_paths_and_environment(
        data_dir: PathBuf,
        runtime_file: PathBuf,
        bridge: Option<PathBuf>,
        codex: Option<PathBuf>,
        command_environment: BTreeMap<String, String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            data_dir,
            runtime_file,
            bridge,
            codex,
            command_environment,
            last_test: RwLock::new(None),
        })
    }

    fn command(&self, executable: &Path) -> Command {
        let mut command = Command::new(executable);
        command.envs(&self.command_environment);
        command
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
        let output = self
            .command(codex)
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
                self.record_bridge_test().await?;
                return Ok(self.status().await);
            }
            self.remove_registration(codex).await?;
        }
        let output = self
            .command(codex)
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
        if let Err(error) = self.record_bridge_test().await {
            let _ = self.remove_registration(codex).await;
            return Err(AppError::conflict(format!(
                "Codex MCP registration was rolled back because verification failed: {error}"
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
            self.remove_registration(codex).await?;
        }
        *self.last_test.write().await = None;
        Ok(self.status().await)
    }

    pub async fn test(&self) -> Value {
        let _ = self.record_bridge_test().await;
        self.status().await
    }

    async fn record_bridge_test(&self) -> AppResult<()> {
        let tested_at = Utc::now().to_rfc3339();
        let result = self.test_bridge().await;
        *self.last_test.write().await = Some(match &result {
            Ok(()) => json!({"ok":true,"tested_at":tested_at,"error":null}),
            Err(error) => json!({"ok":false,"tested_at":tested_at,"error":error.to_string()}),
        });
        result
    }

    async fn remove_registration(&self, codex: &Path) -> AppResult<()> {
        let output = self
            .command(codex)
            .args(["mcp", "remove", SERVER_NAME])
            .output()
            .await?;
        if !output.status.success() {
            return Err(AppError::conflict(command_error(
                &output,
                "Codex MCP removal failed",
            )));
        }
        Ok(())
    }

    async fn test_bridge(&self) -> AppResult<()> {
        let bridge = self
            .bridge
            .as_ref()
            .ok_or_else(|| AppError::conflict("Service Console MCP bridge was not found"))?;
        let mut command = self.command(bridge);
        command
            .args(self.bridge_args())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
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
        if !missing.is_empty() {
            return Err(AppError::conflict(format!(
                "MCP bridge is missing tools: {}",
                missing.join(", ")
            )));
        }
        for (id, tool, result_key) in [
            (3_u64, "service_list", "services"),
            (4, "service_group_list", "groups"),
            (5, "jenkins_instance_list", "instances"),
        ] {
            let request = json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": {"name": tool, "arguments": {}},
            });
            stdin.write_all(format!("{request}\n").as_bytes()).await?;
            let called = timeout(Duration::from_secs(10), lines.next_line())
                .await
                .map_err(|_| AppError::conflict(format!("MCP {tool} call timed out")))??
                .ok_or_else(|| AppError::conflict(format!("MCP bridge exited during {tool}")))?;
            let payload: Value = serde_json::from_str(&called)?;
            if payload["id"] != id
                || payload["result"]["isError"].as_bool().unwrap_or(true)
                || !payload["result"]["structuredContent"][result_key].is_array()
            {
                return Err(AppError::conflict(format!(
                    "MCP {tool} call failed: {}",
                    payload.get("error").unwrap_or(&payload["result"])
                )));
            }
        }
        let _ = child.kill().await;
        Ok(())
    }
}

fn find_on_path(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    path.and_then(|paths| {
        std::env::split_paths(paths)
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};
    use tempfile::tempdir;

    fn executable(path: &Path, source: &str) {
        fs::write(path, source).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[tokio::test]
    async fn install_replaces_stale_python_registration_and_verifies_core_tool_calls() {
        let directory = tempdir().unwrap();
        let bridge = directory.path().join("service-console-mcp");
        let codex = directory.path().join("codex");
        let state = directory.path().join("registration-state");
        fs::write(&state, "stale").unwrap();

        let listed_tools = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "tools": TOOL_NAMES.iter().map(|name| json!({"name": name})).collect::<Vec<_>>()
            }
        });
        executable(
            &bridge,
            &format!(
                "#!/bin/sh\nwhile IFS= read -r line; do\ncase \"$line\" in\n  *'\"id\":1'*) printf '%s\\n' '{}' ;;\n  *'\"id\":2'*) printf '%s\\n' '{}' ;;\n  *'\"id\":3'*) printf '%s\\n' '{}' ;;\n  *'\"id\":4'*) printf '%s\\n' '{}' ;;\n  *'\"id\":5'*) printf '%s\\n' '{}' ;;\nesac\ndone\n",
                json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"service-console","version":"test"}}}),
                listed_tools,
                json!({"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"services\":[]}"}],"structuredContent":{"services":[]},"isError":false}}),
                json!({"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"{\"groups\":[]}"}],"structuredContent":{"groups":[]},"isError":false}}),
                json!({"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"{\"instances\":[]}"}],"structuredContent":{"instances":[]},"isError":false}}),
            ),
        );
        executable(
            &codex,
            "#!/bin/sh\ncase \"$1:$2\" in\n  mcp:get)\n    if [ \"$(cat \"$FAKE_MCP_STATE\")\" = current ]; then printf '%s\\n' \"$FAKE_CURRENT_JSON\"; else printf '%s\\n' \"$FAKE_STALE_JSON\"; fi ;;\n  mcp:remove) printf '%s' removed > \"$FAKE_MCP_STATE\" ;;\n  mcp:add) printf '%s' current > \"$FAKE_MCP_STATE\" ;;\n  *) exit 2 ;;\nesac\n",
        );

        let data_dir = directory.path().join("data");
        let runtime_file = data_dir.join("controller.json");
        let args = vec![
            "--runtime-file".to_owned(),
            runtime_file.to_string_lossy().into_owned(),
            "--data-dir".to_owned(),
            data_dir.to_string_lossy().into_owned(),
        ];
        let current = json!({
            "enabled": true,
            "transport": {"type":"stdio","command":bridge,"args":args},
        });
        let stale = json!({
            "enabled": true,
            "transport": {"type":"stdio","command":"python","args":["-m","service_console.cli"]},
        });
        let mut environment: BTreeMap<String, String> = std::env::vars().collect();
        environment.insert(
            "FAKE_MCP_STATE".into(),
            state.to_string_lossy().into_owned(),
        );
        environment.insert("FAKE_CURRENT_JSON".into(), current.to_string());
        environment.insert("FAKE_STALE_JSON".into(), stale.to_string());
        let integration = McpIntegration::with_paths_and_environment(
            data_dir,
            runtime_file,
            Some(bridge),
            Some(codex),
            environment,
        );

        assert_eq!(integration.status().await["state"], "conflict");
        let installed = integration.install().await.unwrap();
        assert_eq!(installed["state"], "installed");
        assert_eq!(installed["last_test"]["ok"], true);
        assert_eq!(fs::read_to_string(state).unwrap(), "current");
    }
}
