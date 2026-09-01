use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::{Instant, sleep},
};

use crate::{
    models::expand_home,
    runtime::{RuntimeConnection, load_runtime},
};

pub const TOOL_NAMES: &[&str] = &[
    "project_apply_config",
    "service_list",
    "service_status",
    "service_upsert",
    "service_group_list",
    "service_group_create",
    "service_group_delete",
    "service_group_assign",
    "service_group_start",
    "service_group_stop",
    "service_start",
    "service_stop",
    "service_restart",
    "service_logs",
    "port_list",
    "process_list",
    "process_import",
    "process_terminate",
    "jenkins_instance_list",
    "jenkins_job_list",
    "jenkins_job_status",
    "jenkins_build_list",
    "jenkins_build_status",
    "jenkins_build_logs",
    "jenkins_queue_list",
    "jenkins_build_trigger",
    "jenkins_build_stop",
    "jenkins_queue_cancel",
];

struct ControllerClient {
    runtime_file: PathBuf,
    data_dir: PathBuf,
    http: Client,
}

impl ControllerClient {
    fn new(runtime_file: PathBuf, data_dir: PathBuf) -> Self {
        Self {
            runtime_file: expand_home(runtime_file),
            data_dir: expand_home(data_dir),
            http: Client::new(),
        }
    }

    async fn ensure(&self) -> Result<RuntimeConnection> {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut launched = false;
        loop {
            let connection = load_runtime(&self.runtime_file)?;
            if let Some(connection) = connection.as_ref()
                && self.healthy(connection).await
            {
                return Ok(connection.clone());
            }
            if connection.is_none() && !launched {
                self.launch_desktop()?;
                launched = true;
            }
            if Instant::now() >= deadline {
                if let Some(connection) = connection {
                    bail!(
                        "Service Console controller at {} did not become healthy in time",
                        connection.base_url
                    );
                }
                bail!("Service Console desktop did not publish a healthy controller in time");
            }
            sleep(Duration::from_millis(100)).await;
        }
    }

    async fn healthy(&self, connection: &RuntimeConnection) -> bool {
        self.http
            .get(format!("{}api/health", connection.base_url))
            .bearer_auth(&connection.token)
            .timeout(Duration::from_millis(1500))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
    }

    fn launch_desktop(&self) -> Result<()> {
        let current = std::env::current_exe()?;
        let names: &[&str] = if cfg!(windows) {
            &["service-console-desktop.exe", "Service Console.exe"]
        } else {
            &["service-console-desktop", "Service Console"]
        };
        let executable = names
            .iter()
            .map(|name| current.with_file_name(name))
            .find(|path| path.is_file())
            .or_else(|| find_on_path("service-console-desktop"))
            .ok_or_else(|| anyhow!("Service Console desktop executable was not found"))?;
        Command::new(executable)
            .env("SERVICE_CONSOLE_DATA_DIR", &self.data_dir)
            .env("SERVICE_CONSOLE_RUNTIME_FILE", &self.runtime_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(())
    }

    async fn request(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut connection = self.ensure().await?;
        for attempt in 0..2 {
            let mut request = self
                .http
                .request(
                    method.clone(),
                    format!("{}{}", connection.base_url, path.trim_start_matches('/')),
                )
                .bearer_auth(&connection.token)
                .timeout(Duration::from_secs(60));
            if let Some(body) = &body {
                request = request.json(body);
            }
            let response = request
                .send()
                .await
                .context("Service Console controller request failed")?;
            if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                connection = load_runtime(&self.runtime_file)?
                    .ok_or_else(|| anyhow!("controller descriptor disappeared"))?;
                continue;
            }
            let status = response.status();
            let bytes = response.bytes().await?;
            let payload: Value = if bytes.is_empty() {
                json!({})
            } else {
                serde_json::from_slice(&bytes)
                    .unwrap_or_else(|_| json!({"detail":String::from_utf8_lossy(&bytes)}))
            };
            if !status.is_success() {
                bail!(
                    "HTTP {}: {}",
                    status.as_u16(),
                    payload.get("detail").unwrap_or(&payload)
                );
            }
            return Ok(payload);
        }
        bail!("controller rejected the refreshed runtime token")
    }
}

pub async fn run(runtime_file: PathBuf, data_dir: PathBuf) -> Result<()> {
    let client = ControllerClient::new(runtime_file, data_dir);
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                write_message(&mut stdout, json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":error.to_string()}})).await?;
                continue;
            }
        };
        let Some(id) = request.get("id").cloned() else {
            continue;
        };
        let response = dispatch(&client, &request).await;
        let message = match response {
            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(error) => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":error.to_string()}})
            }
        };
        write_message(&mut stdout, message).await?;
    }
    Ok(())
}

async fn write_message(stdout: &mut tokio::io::Stdout, message: Value) -> Result<()> {
    stdout
        .write_all(serde_json::to_string(&message)?.as_bytes())
        .await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}

async fn dispatch(client: &ControllerClient, request: &Value) -> Result<Value> {
    match request["method"].as_str().unwrap_or_default() {
        "initialize" => Ok(json!({
            "protocolVersion": request["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name":"service-console","version":env!("CARGO_PKG_VERSION")},
            "instructions":"Use these MCP tools directly to manage Service Console services, groups, processes, ports, and Jenkins. The runtime is Rust-native: do not invoke the removed Python module service_console.cli. If a repository contains .service-console.json, call project_apply_config with its absolute path before lifecycle operations, then verify changes with service_status and service_logs."
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools()})),
        "tools/call" => {
            let name = request["params"]["name"]
                .as_str()
                .ok_or_else(|| anyhow!("tool name is required"))?;
            let arguments = request["params"]
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match call_tool(client, name, &arguments).await {
                Ok(value) => Ok(
                    json!({"content":[{"type":"text","text":serde_json::to_string_pretty(&value)?}],"structuredContent":value,"isError":false}),
                ),
                Err(error) => {
                    Ok(json!({"content":[{"type":"text","text":error.to_string()}],"isError":true}))
                }
            }
        }
        method => bail!("Method not found: {method}"),
    }
}

fn tools() -> Vec<Value> {
    TOOL_NAMES.iter().map(|name| {
        let (description, schema, destructive, read_only) = tool_metadata(name);
        json!({"name":name,"description":description,"inputSchema":schema,"annotations":{"readOnlyHint":read_only,"destructiveHint":destructive,"openWorldHint":false}})
    }).collect()
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

fn tool_metadata(name: &str) -> (&'static str, Value, bool, bool) {
    let string = || json!({"type":"string","minLength":1});
    let optional_string = || json!({"anyOf":[{"type":"string","minLength":1},{"type":"null"}]});
    match name {
        "service_list" => (
            "List registered services and runtime state.",
            object_schema(json!({}), &[]),
            false,
            true,
        ),
        "service_status" => (
            "Get one registered service.",
            object_schema(json!({"name":string()}), &["name"]),
            false,
            true,
        ),
        "service_upsert" => (
            "Create or update a service definition. Omit group to preserve the current group; pass null to ungroup it.",
            object_schema(
                json!({"name":string(),"group":optional_string(),"command":string(),"cwd":string(),"env":{"type":"object","additionalProperties":{"type":"string"}},"auto_start":{"type":"boolean"},"stop_timeout":{"type":"number","minimum":0}}),
                &["name", "command", "cwd"],
            ),
            false,
            false,
        ),
        "service_group_list" => (
            "List persistent service groups.",
            object_schema(json!({}), &[]),
            false,
            true,
        ),
        "service_group_create" => (
            "Create a persistent service group.",
            object_schema(json!({"group":string()}), &["group"]),
            false,
            false,
        ),
        "service_group_delete" => (
            "Delete a service group and move its members to the ungrouped area without stopping them.",
            object_schema(json!({"group":string()}), &["group"]),
            true,
            false,
        ),
        "service_group_assign" => (
            "Move a service to a group, or omit/pass null for group to ungroup it.",
            object_schema(
                json!({"name":string(),"group":optional_string()}),
                &["name"],
            ),
            false,
            false,
        ),
        "service_group_start" | "service_group_stop" => (
            "Start or stop every service in a group and return per-service failures.",
            object_schema(json!({"group":string()}), &["group"]),
            name == "service_group_stop",
            false,
        ),
        "service_start" | "service_stop" | "service_restart" => (
            "Change one service lifecycle state.",
            object_schema(json!({"name":string()}), &["name"]),
            matches!(name, "service_stop" | "service_restart"),
            false,
        ),
        "service_logs" => (
            "Read recent persisted service logs.",
            object_schema(
                json!({"name":string(),"tail":{"type":"integer","minimum":0,"maximum":5000}}),
                &["name"],
            ),
            false,
            true,
        ),
        "port_list" => (
            "List listening local ports and owners.",
            object_schema(
                json!({"port":{"type":"integer","minimum":1,"maximum":65535}}),
                &[],
            ),
            false,
            true,
        ),
        "process_list" => (
            "Discover local processes that can be imported.",
            object_schema(
                json!({"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":500}}),
                &[],
            ),
            false,
            true,
        ),
        "process_import" => (
            "Import a discovered process as a managed service.",
            object_schema(
                json!({"pid":{"type":"integer","minimum":2},"name":string(),"group":optional_string(),"auto_start":{"type":"boolean"},"stop_timeout":{"type":"number","minimum":0}}),
                &["pid"],
            ),
            false,
            false,
        ),
        "process_terminate" => (
            "Terminate one local process after optional port verification.",
            object_schema(
                json!({"pid":{"type":"integer","minimum":2},"expected_port":{"type":"integer","minimum":1,"maximum":65535},"force":{"type":"boolean"},"timeout":{"type":"number","exclusiveMinimum":0}}),
                &["pid"],
            ),
            true,
            false,
        ),
        "project_apply_config" => (
            "Apply service definitions from a project JSON configuration.",
            object_schema(
                json!({"config_path":string(),"start":{"type":"boolean"}}),
                &["config_path"],
            ),
            false,
            false,
        ),
        "jenkins_instance_list" => (
            "List configured Jenkins instances without credentials.",
            object_schema(json!({}), &[]),
            false,
            true,
        ),
        "jenkins_job_list" => (
            "List Jenkins jobs.",
            object_schema(
                json!({"instance_id":string(),"folder":{"type":"string"},"query":{"type":"string"}}),
                &["instance_id"],
            ),
            false,
            true,
        ),
        "jenkins_job_status" => (
            "Get Jenkins job details. Set include_parameter_options to resolve dynamic choices, or pass current parameters to resolve cascaded choices.",
            object_schema(
                json!({"instance_id":string(),"job":string(),"include_parameter_options":{"type":"boolean"},"parameters":{"type":"object","additionalProperties":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"array","items":{"type":"string"}}]}}}),
                &["instance_id", "job"],
            ),
            false,
            true,
        ),
        "jenkins_build_list" => (
            "List recent Jenkins builds.",
            object_schema(
                json!({"instance_id":string(),"job":string(),"limit":{"type":"integer","minimum":1,"maximum":100}}),
                &["instance_id", "job"],
            ),
            false,
            true,
        ),
        "jenkins_build_status" => (
            "Get one Jenkins build.",
            object_schema(
                json!({"instance_id":string(),"job":string(),"number":{"type":"integer","minimum":1}}),
                &["instance_id", "job", "number"],
            ),
            false,
            true,
        ),
        "jenkins_build_logs" => (
            "Read a bounded Jenkins progressive log chunk.",
            object_schema(
                json!({"instance_id":string(),"job":string(),"number":{"type":"integer","minimum":1},"start":{"type":"integer","minimum":0},"max_bytes":{"type":"integer","minimum":4,"maximum":1048576}}),
                &["instance_id", "job", "number"],
            ),
            false,
            true,
        ),
        "jenkins_queue_list" => (
            "List the Jenkins build queue.",
            object_schema(json!({"instance_id":string()}), &["instance_id"]),
            false,
            true,
        ),
        "jenkins_build_trigger" => (
            "Trigger a Jenkins build.",
            object_schema(
                json!({"instance_id":string(),"job":string(),"parameters":{"type":"object"}}),
                &["instance_id", "job"],
            ),
            false,
            false,
        ),
        "jenkins_build_stop" => (
            "Stop a Jenkins build.",
            object_schema(
                json!({"instance_id":string(),"job":string(),"number":{"type":"integer","minimum":1}}),
                &["instance_id", "job", "number"],
            ),
            true,
            false,
        ),
        "jenkins_queue_cancel" => (
            "Cancel a Jenkins queue item.",
            object_schema(
                json!({"instance_id":string(),"queue_id":{"type":"integer","minimum":1}}),
                &["instance_id", "queue_id"],
            ),
            true,
            false,
        ),
        _ => unreachable!("tool metadata is missing for {name}"),
    }
}

async fn call_tool(client: &ControllerClient, name: &str, args: &Value) -> Result<Value> {
    match name {
        "service_list" => client.request(Method::GET, "/api/services", None).await,
        "service_status" => {
            let name = required_str(args, "name")?;
            let payload = client.request(Method::GET, "/api/services", None).await?;
            payload["services"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|service| service["name"] == name)
                .cloned()
                .map(|service| json!({"service":service}))
                .ok_or_else(|| anyhow!("Service not found: {name}"))
        }
        "service_upsert" => upsert_service(client, args).await,
        "service_group_list" => {
            client
                .request(Method::GET, "/api/service-groups", None)
                .await
        }
        "service_group_create" => {
            client
                .request(
                    Method::POST,
                    "/api/service-groups",
                    Some(json!({"name":required_str(args, "group")?})),
                )
                .await
        }
        "service_group_delete" => {
            let group = encoded(required_str(args, "group")?);
            client
                .request(
                    Method::DELETE,
                    &format!("/api/service-groups/{group}"),
                    None,
                )
                .await
        }
        "service_group_assign" => {
            let service = encoded(required_str(args, "name")?);
            client
                .request(
                    Method::PUT,
                    &format!("/api/services/{service}/group"),
                    Some(json!({"group":args.get("group").cloned().unwrap_or(Value::Null)})),
                )
                .await
        }
        "service_group_start" | "service_group_stop" => {
            let group = encoded(required_str(args, "group")?);
            let action = name.trim_start_matches("service_group_");
            client
                .request(
                    Method::POST,
                    &format!("/api/service-groups/{group}/{action}"),
                    None,
                )
                .await
        }
        "service_start" | "service_stop" | "service_restart" => {
            let service = encoded(required_str(args, "name")?);
            let action = name.trim_start_matches("service_");
            client
                .request(
                    Method::POST,
                    &format!("/api/services/{service}/{action}"),
                    None,
                )
                .await
        }
        "service_logs" => {
            let service = encoded(required_str(args, "name")?);
            let tail = args["tail"].as_u64().unwrap_or(500).min(5000);
            client
                .request(
                    Method::GET,
                    &format!("/api/services/{service}/logs?tail={tail}"),
                    None,
                )
                .await
        }
        "port_list" => {
            let suffix = args["port"]
                .as_u64()
                .map(|port| format!("?port={port}"))
                .unwrap_or_default();
            client
                .request(Method::GET, &format!("/api/ports{suffix}"), None)
                .await
        }
        "process_list" => {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            if let Some(value) = args["query"].as_str() {
                query.append_pair("query", value);
            }
            query.append_pair(
                "limit",
                &args["limit"].as_u64().unwrap_or(100).min(500).to_string(),
            );
            client
                .request(
                    Method::GET,
                    &format!("/api/processes?{}", query.finish()),
                    None,
                )
                .await
        }
        "process_import" => import_process(client, args).await,
        "process_terminate" => {
            let pid = required_u64(args, "pid")?;
            client.request(Method::POST, &format!("/api/processes/{pid}/terminate"), Some(json!({"expected_port":args.get("expected_port"),"force":args["force"].as_bool().unwrap_or(false),"timeout":args["timeout"].as_f64().unwrap_or(3.0)}))).await
        }
        "project_apply_config" => apply_project(client, args).await,
        "jenkins_instance_list" => {
            client
                .request(Method::GET, "/api/jenkins/instances", None)
                .await
        }
        "jenkins_job_list" => {
            let id = encoded(required_str(args, "instance_id")?);
            let query = pairs(&[
                ("folder", args["folder"].as_str()),
                ("query", args["query"].as_str()),
            ]);
            client
                .request(
                    Method::GET,
                    &format!("/api/jenkins/instances/{id}/jobs{query}"),
                    None,
                )
                .await
        }
        "jenkins_job_status" => {
            let id = encoded(required_str(args, "instance_id")?);
            let job = required_str(args, "job")?;
            if let Some(parameters) = args.get("parameters") {
                client
                    .request(
                        Method::POST,
                        &format!(
                            "/api/jenkins/instances/{id}/job/parameters?{}",
                            pairs_raw(&[("job", job)])
                        ),
                        Some(json!({"parameters":parameters})),
                    )
                    .await
            } else {
                let include_options = args["include_parameter_options"].as_bool().unwrap_or(false);
                let include_options = include_options.then_some("true");
                let query = pairs(&[
                    ("job", Some(job)),
                    ("include_parameter_options", include_options),
                ]);
                client
                    .request(
                        Method::GET,
                        &format!("/api/jenkins/instances/{id}/job{query}"),
                        None,
                    )
                    .await
            }
        }
        "jenkins_build_list" => {
            jenkins_get(
                client,
                args,
                "builds",
                Some(("limit", args["limit"].as_u64().unwrap_or(30))),
            )
            .await
        }
        "jenkins_build_status" => {
            let id = encoded(required_str(args, "instance_id")?);
            let job = required_str(args, "job")?;
            let number = required_u64(args, "number")?;
            client
                .request(
                    Method::GET,
                    &format!(
                        "/api/jenkins/instances/{id}/builds/{number}?{}",
                        pairs_raw(&[("job", job)])
                    ),
                    None,
                )
                .await
        }
        "jenkins_build_logs" => {
            let id = encoded(required_str(args, "instance_id")?);
            let job = required_str(args, "job")?;
            let number = required_u64(args, "number")?;
            let start = args["start"].as_u64().unwrap_or(0);
            let payload = client
                .request(
                    Method::GET,
                    &format!(
                        "/api/jenkins/instances/{id}/builds/{number}/log?{}",
                        pairs_raw(&[("job", job), ("start", &start.to_string())])
                    ),
                    None,
                )
                .await?;
            bounded_jenkins_log(
                payload,
                args["max_bytes"]
                    .as_u64()
                    .unwrap_or(65_536)
                    .clamp(4, 1_048_576) as usize,
            )
        }
        "jenkins_queue_list" => {
            let id = encoded(required_str(args, "instance_id")?);
            client
                .request(
                    Method::GET,
                    &format!("/api/jenkins/instances/{id}/queue"),
                    None,
                )
                .await
        }
        "jenkins_build_trigger" => {
            let id = encoded(required_str(args, "instance_id")?);
            let job = required_str(args, "job")?;
            client.request(Method::POST,&format!("/api/jenkins/instances/{id}/builds?{}",pairs_raw(&[("job",job)])),Some(json!({"parameters":args.get("parameters").cloned().unwrap_or_else(||json!({}))}))).await
        }
        "jenkins_build_stop" => {
            let id = encoded(required_str(args, "instance_id")?);
            let job = required_str(args, "job")?;
            let number = required_u64(args, "number")?;
            client
                .request(
                    Method::POST,
                    &format!(
                        "/api/jenkins/instances/{id}/builds/{number}/stop?{}",
                        pairs_raw(&[("job", job)])
                    ),
                    None,
                )
                .await
        }
        "jenkins_queue_cancel" => {
            let id = encoded(required_str(args, "instance_id")?);
            let queue = required_u64(args, "queue_id")?;
            client
                .request(
                    Method::POST,
                    &format!("/api/jenkins/instances/{id}/queue/{queue}/cancel"),
                    None,
                )
                .await
        }
        _ => bail!("Unknown tool: {name}"),
    }
}

async fn upsert_service(client: &ControllerClient, args: &Value) -> Result<Value> {
    let name = required_str(args, "name")?;
    let services = client.request(Method::GET, "/api/services", None).await?;
    let existing = services["services"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|service| service["name"] == name);
    let group = args
        .get("group")
        .cloned()
        .or_else(|| existing.map(|service| service["group"].clone()))
        .unwrap_or(Value::Null);
    let payload = json!({"name":name,"group":group,"command":required_str(args,"command")?,"cwd":required_str(args,"cwd")?,"env":args.get("env").cloned().unwrap_or_else(||json!({})),"auto_start":args["auto_start"].as_bool().unwrap_or(false),"stop_timeout":args["stop_timeout"].as_f64().unwrap_or(5.0)});
    if existing.is_some() {
        let mut body = payload.clone();
        if let Some(object) = body.as_object_mut() {
            object.remove("name");
        }
        client
            .request(
                Method::PUT,
                &format!("/api/services/{}", encoded(name)),
                Some(body),
            )
            .await
    } else {
        client
            .request(Method::POST, "/api/services", Some(payload))
            .await
    }
}

async fn import_process(client: &ControllerClient, args: &Value) -> Result<Value> {
    let pid = required_u64(args, "pid")?;
    let process = client
        .request(Method::GET, &format!("/api/processes/{pid}"), None)
        .await?;
    let row = &process["process"];
    if !row["restorable"].as_bool().unwrap_or(false) {
        bail!("Process {pid} does not expose a restorable command and working directory");
    }
    let name = args["name"]
        .as_str()
        .or_else(|| row["suggested_name"].as_str())
        .ok_or_else(|| anyhow!("service name is unavailable"))?;
    let mut definition = json!({"name":name,"command":row["command"],"cwd":row["cwd"],"env":row["safe_env"],"auto_start":args["auto_start"].as_bool().unwrap_or(false),"stop_timeout":args["stop_timeout"].as_f64().unwrap_or(5.0)});
    if let Some(group) = args.get("group") {
        definition["group"] = group.clone();
    }
    upsert_service(client, &definition).await
}

async fn apply_project(client: &ControllerClient, args: &Value) -> Result<Value> {
    let requested_path = expand_home(required_str(args, "config_path")?);
    let path = tokio::fs::canonicalize(&requested_path)
        .await
        .with_context(|| {
            format!(
                "Unable to resolve project configuration {}",
                requested_path.display()
            )
        })?;
    let payload: Value = serde_json::from_slice(&tokio::fs::read(&path).await?)?;
    if payload["version"].as_u64() != Some(1) {
        bail!("project configuration version must be 1");
    }
    let services = payload
        .get("services")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("project configuration must contain a services array"))?;
    let mut seen = HashSet::new();
    let mut configured_groups = HashSet::new();
    if let Some(groups) = payload.get("groups") {
        let groups = groups
            .as_array()
            .ok_or_else(|| anyhow!("project configuration groups must be an array"))?;
        for group in groups {
            configured_groups.insert(required_value_str(group, "group name")?.to_owned());
        }
    }
    for service in services {
        let name = required_str(service, "name")?;
        if !seen.insert(name.to_owned()) {
            bail!("duplicate service definition: {name}");
        }
        if let Some(group) = service.get("group")
            && !group.is_null()
        {
            configured_groups.insert(required_value_str(group, "service group")?.to_owned());
        }
    }
    let existing_groups = client
        .request(Method::GET, "/api/service-groups", None)
        .await?;
    let mut existing_groups: HashSet<String> = existing_groups["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let mut groups: Vec<_> = configured_groups.into_iter().collect();
    groups.sort();
    for group in &groups {
        if existing_groups.insert(group.clone()) {
            client
                .request(
                    Method::POST,
                    "/api/service-groups",
                    Some(json!({"name":group})),
                )
                .await?;
        }
    }
    let mut results = Vec::new();
    for service in services {
        let mut service = service.clone();
        let cwd = expand_home(required_str(&service, "cwd")?);
        if cwd.is_relative() {
            let resolved = path.parent().unwrap_or_else(|| Path::new(".")).join(&cwd);
            service["cwd"] = Value::String(resolved.to_string_lossy().into_owned());
        } else {
            service["cwd"] = Value::String(cwd.to_string_lossy().into_owned());
        }
        let result = upsert_service(client, &service).await?;
        if args["start"].as_bool().unwrap_or(false) {
            let name = encoded(required_str(&service, "name")?);
            let _ = client
                .request(Method::POST, &format!("/api/services/{name}/start"), None)
                .await?;
        }
        results.push(result);
    }
    Ok(
        json!({"config_path":path,"project":payload.get("project").cloned().unwrap_or(Value::Null),"groups":groups,"services":results}),
    )
}

async fn jenkins_get(
    client: &ControllerClient,
    args: &Value,
    suffix: &str,
    extra: Option<(&str, u64)>,
) -> Result<Value> {
    let id = encoded(required_str(args, "instance_id")?);
    let job = required_str(args, "job")?;
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("job", job);
    if let Some((key, value)) = extra {
        serializer.append_pair(key, &value.to_string());
    }
    client
        .request(
            Method::GET,
            &format!(
                "/api/jenkins/instances/{id}/{suffix}?{}",
                serializer.finish()
            ),
            None,
        )
        .await
}

fn bounded_jenkins_log(mut payload: Value, max_bytes: usize) -> Result<Value> {
    let log = payload
        .get_mut("log")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("Service Console response is missing the Jenkins log"))?;
    let text = log
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Service Console response is missing the Jenkins log text"))?
        .to_owned();
    if text.len() <= max_bytes {
        log.insert("returned_bytes".into(), json!(text.len()));
        log.insert("truncated".into(), Value::Bool(false));
        return Ok(payload);
    }
    let offset = log
        .get("offset")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("Service Console response is missing the Jenkins log offset"))?;
    let mut returned_bytes = max_bytes;
    while !text.is_char_boundary(returned_bytes) {
        returned_bytes -= 1;
    }
    let visible = text[..returned_bytes].to_owned();
    log.insert("text".into(), Value::String(visible));
    log.insert("next_offset".into(), json!(offset + returned_bytes as u64));
    log.insert("more".into(), Value::Bool(true));
    log.insert("complete".into(), Value::Bool(false));
    log.insert("returned_bytes".into(), json!(returned_bytes));
    log.insert("truncated".into(), Value::Bool(true));
    Ok(payload)
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("{key} is required"))
}
fn required_u64(value: &Value, key: &str) -> Result<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| anyhow!("{key} must be positive"))
}
fn required_value_str<'a>(value: &'a Value, label: &str) -> Result<&'a str> {
    value
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("{label} must be a non-empty string"))
}
fn encoded(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}
fn pairs(values: &[(&str, Option<&str>)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in values {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            serializer.append_pair(key, value);
        }
    }
    let value = serializer.finish();
    if value.is_empty() {
        String::new()
    } else {
        format!("?{value}")
    }
}
fn pairs_raw(values: &[(&str, &str)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in values {
        serializer.append_pair(key, value);
    }
    serializer.finish()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_complete_tool_surface() {
        let listed: HashSet<_> = tools()
            .into_iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
            .collect();
        assert_eq!(
            listed,
            TOOL_NAMES.iter().map(|name| name.to_string()).collect()
        );
    }

    #[test]
    fn bounds_jenkins_logs_at_utf8_boundaries_and_exposes_resume_offset() {
        let payload = json!({
            "log": {
                "offset": 10,
                "next_offset": 17,
                "text": "ab中cd",
                "more": false,
                "complete": true
            }
        });

        let bounded = bounded_jenkins_log(payload, 4).unwrap();
        assert_eq!(bounded["log"]["text"], "ab");
        assert_eq!(bounded["log"]["returned_bytes"], 2);
        assert_eq!(bounded["log"]["next_offset"], 12);
        assert_eq!(bounded["log"]["truncated"], true);
        assert_eq!(bounded["log"]["more"], true);
        assert_eq!(bounded["log"]["complete"], false);
    }

    #[test]
    fn leaves_small_jenkins_logs_complete() {
        let payload = json!({
            "log": {
                "offset": 3,
                "next_offset": 6,
                "text": "abc",
                "more": false,
                "complete": true
            }
        });

        let bounded = bounded_jenkins_log(payload, 64).unwrap();
        assert_eq!(bounded["log"]["text"], "abc");
        assert_eq!(bounded["log"]["returned_bytes"], 3);
        assert_eq!(bounded["log"]["next_offset"], 6);
        assert_eq!(bounded["log"]["truncated"], false);
        assert_eq!(bounded["log"]["more"], false);
        assert_eq!(bounded["log"]["complete"], true);
    }
}
