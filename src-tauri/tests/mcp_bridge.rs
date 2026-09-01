use std::{
    fs,
    net::{IpAddr, Ipv4Addr},
};

use serde_json::{Value, json};
use service_console::{
    manager::ServiceManager,
    runtime::{RuntimeConnection, write_runtime},
    server::start_controller,
};
use tempfile::tempdir;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

async fn read_message(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
) -> Value {
    serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap()
}

async fn call_tool(
    stdin: &mut tokio::process::ChildStdin,
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
    name: &str,
    arguments: Value,
) -> Value {
    let request = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    });
    stdin
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    let response = read_message(lines).await;
    assert_eq!(response["id"], id);
    assert_eq!(response["result"]["isError"], false, "{response}");
    response["result"]["structuredContent"].clone()
}

#[tokio::test]
async fn stdio_agent_can_call_service_group_project_and_jenkins_tools() {
    let directory = tempdir().unwrap();
    let static_dir = directory.path().join("static");
    fs::create_dir_all(&static_dir).unwrap();
    fs::write(static_dir.join("index.html"), "<html></html>").unwrap();
    let manager = ServiceManager::new(directory.path()).unwrap();
    let token = "mcp-test-token".to_owned();
    let controller = start_controller(
        manager.clone(),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        0,
        Some(token.clone()),
        static_dir,
    )
    .await
    .unwrap();
    let runtime_file = directory.path().join("controller.json");
    write_runtime(
        &runtime_file,
        &RuntimeConnection::new(controller.base_url(), token),
    )
    .unwrap();

    let mut command = Command::new(env!("CARGO_BIN_EXE_service-console-mcp"));
    command
        .arg("--runtime-file")
        .arg(&runtime_file)
        .arg("--data-dir")
        .arg(directory.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

    stdin.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"integration-test\",\"version\":\"1\"}}}\n").await.unwrap();
    let initialized = read_message(&mut lines).await;
    assert_eq!(
        initialized["result"]["serverInfo"]["name"],
        "service-console"
    );
    assert!(
        initialized["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("do not invoke the removed Python module service_console.cli")
    );

    stdin
        .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}\n")
        .await
        .unwrap();
    let listed = read_message(&mut lines).await;
    let names: Vec<_> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert!(names.contains(&"service_list"));
    assert!(names.contains(&"service_group_create"));
    assert!(names.contains(&"service_group_start"));

    let created = call_tool(
        &mut stdin,
        &mut lines,
        3,
        "service_group_create",
        json!({"group": "backend"}),
    )
    .await;
    assert_eq!(created["group"], "backend");

    let service = call_tool(
        &mut stdin,
        &mut lines,
        4,
        "service_upsert",
        json!({
            "name": "api",
            "group": "backend",
            "command": "echo api",
            "cwd": directory.path(),
            "stop_timeout": 1,
        }),
    )
    .await;
    assert_eq!(service["service"]["name"], "api");
    assert_eq!(service["service"]["group"], "backend");

    let groups = call_tool(&mut stdin, &mut lines, 5, "service_group_list", json!({})).await;
    assert_eq!(groups["groups"], json!(["backend"]));

    let services = call_tool(&mut stdin, &mut lines, 6, "service_list", json!({})).await;
    assert_eq!(services["services"][0]["name"], "api");
    assert_eq!(services["services"][0]["group"], "backend");

    let project_dir = directory.path().join("project");
    fs::create_dir_all(&project_dir).unwrap();
    let project_config = project_dir.join(".service-console.json");
    fs::write(
        &project_config,
        serde_json::to_vec(&json!({
            "version": 1,
            "project": "mcp-integration",
            "groups": ["project-group"],
            "services": [{
                "name": "project-api",
                "group": "project-group",
                "command": "echo project-api",
                "cwd": "."
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let applied = call_tool(
        &mut stdin,
        &mut lines,
        7,
        "project_apply_config",
        json!({"config_path": project_config}),
    )
    .await;
    assert_eq!(applied["project"], "mcp-integration");
    assert_eq!(applied["groups"], json!(["project-group"]));
    assert_eq!(applied["services"][0]["service"]["name"], "project-api");
    let applied_cwd = applied["services"][0]["service"]["cwd"]
        .as_str()
        .map(std::path::PathBuf::from)
        .unwrap();
    assert_eq!(
        applied_cwd.canonicalize().unwrap(),
        project_dir.canonicalize().unwrap()
    );

    let jenkins = call_tool(
        &mut stdin,
        &mut lines,
        8,
        "jenkins_instance_list",
        json!({}),
    )
    .await;
    assert_eq!(jenkins["instances"], json!([]));

    let _ = child.kill().await;
    manager.shutdown().await;
    controller.shutdown().await;
}
