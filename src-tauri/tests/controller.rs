use std::{
    collections::BTreeMap,
    fs,
    net::{IpAddr, Ipv4Addr},
    time::Duration,
};

use reqwest::StatusCode;
use serde_json::{Value, json};
use service_console::{
    manager::ServiceManager,
    models::{ServiceDefinition, ServiceState},
    server::start_controller,
};
use tempfile::tempdir;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::test]
async fn authenticated_controller_runs_a_service_and_persists_logs() {
    let directory = tempdir().unwrap();
    let static_dir = directory.path().join("static");
    fs::create_dir_all(&static_dir).unwrap();
    fs::write(
        static_dir.join("index.html"),
        "<html>__SERVICE_CONSOLE_THEME__</html>",
    )
    .unwrap();

    let manager = ServiceManager::new(directory.path()).unwrap();
    let controller = start_controller(
        manager.clone(),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        0,
        Some("test-token".into()),
        static_dir,
    )
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let base = controller.base_url();

    let denied = client
        .get(format!("{base}api/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

    let lowercase_scheme = client
        .get(format!("{base}api/health"))
        .header("authorization", "bearer test-token")
        .send()
        .await
        .unwrap();
    assert_eq!(lowercase_scheme.status(), StatusCode::OK);

    let health: Value = client
        .get(format!("{base}api/health"))
        .bearer_auth("test-token")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health, json!({"status": "ok"}));

    let command = if cfg!(windows) {
        "echo rust-controller-ok"
    } else {
        "printf 'rust-controller-ok\\n'"
    };
    let created: Value = client
        .post(format!("{base}api/services"))
        .bearer_auth("test-token")
        .json(&json!({
            "name": "echo",
            "command": command,
            "cwd": directory.path(),
            "env": {},
            "auto_start": false,
            "stop_timeout": 1
        }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(created["service"]["state"], "STOPPED");

    client
        .post(format!("{base}api/services/echo/start"))
        .bearer_auth("test-token")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let mut found = false;
    for _ in 0..40 {
        let logs: Value = client
            .get(format!("{base}api/services/echo/logs?tail=10"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if logs["logs"].as_array().is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| entry["message"] == "rust-controller-ok")
        }) {
            found = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(found, "expected service output in the persisted log stream");

    manager.shutdown().await;
    controller.shutdown().await;
}

#[tokio::test]
async fn core_http_contract_enforces_statuses_validation_and_theme_persistence() {
    let directory = tempdir().unwrap();
    let static_dir = directory.path().join("static");
    fs::create_dir_all(&static_dir).unwrap();
    fs::write(
        static_dir.join("index.html"),
        r#"<html data-theme-preference="system">__SERVICE_CONSOLE_THEME__</html>"#,
    )
    .unwrap();
    let manager = ServiceManager::new(directory.path()).unwrap();
    let controller = start_controller(
        manager.clone(),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        0,
        Some("contract-token".into()),
        static_dir,
    )
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let base = controller.base_url();

    let created = client
        .post(format!("{base}api/services"))
        .bearer_auth("contract-token")
        .json(&json!({
            "name": "contract",
            "command": "echo contract",
            "cwd": directory.path()
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let created: Value = created.json().await.unwrap();
    assert_eq!(created["service"]["name"], "contract");
    assert_eq!(created["service"]["state"], "STOPPED");
    assert!(created["service"]["pid"].is_null());

    let duplicate = client
        .post(format!("{base}api/services"))
        .bearer_auth("contract-token")
        .json(&json!({
            "name": "contract",
            "command": "echo contract",
            "cwd": directory.path()
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    assert!(duplicate.json::<Value>().await.unwrap()["detail"].is_string());

    let invalid_theme = client
        .put(format!("{base}api/ui-preferences"))
        .bearer_auth("contract-token")
        .json(&json!({"theme": "sepia"}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_theme.status(), StatusCode::BAD_REQUEST);

    let theme = client
        .put(format!("{base}api/ui-preferences"))
        .bearer_auth("contract-token")
        .json(&json!({"theme": "dark"}))
        .send()
        .await
        .unwrap();
    assert_eq!(theme.status(), StatusCode::OK);
    let index_response = client.get(&base).send().await.unwrap();
    assert_eq!(
        index_response
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    let index = index_response.text().await.unwrap();
    assert!(index.contains("data-theme-preference=\"dark\""));

    let long_query = "x".repeat(201);
    let invalid_process_query = client
        .get(format!("{base}api/processes?query={long_query}"))
        .bearer_auth("contract-token")
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_process_query.status(), StatusCode::BAD_REQUEST);

    let empty_logs: Value = client
        .get(format!("{base}api/services/contract/logs?tail=0"))
        .bearer_auth("contract-token")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(empty_logs, json!({"service": "contract", "logs": []}));

    let deleted: Value = client
        .delete(format!("{base}api/services/contract"))
        .bearer_auth("contract-token")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(deleted, json!({"deleted": "contract"}));

    manager.shutdown().await;
    controller.shutdown().await;
}

#[tokio::test]
async fn websocket_contract_closes_invalid_tokens_and_reports_invalid_commands() {
    use futures_util::{SinkExt, StreamExt};

    let directory = tempdir().unwrap();
    let static_dir = directory.path().join("static");
    fs::create_dir_all(&static_dir).unwrap();
    fs::write(static_dir.join("index.html"), "<html></html>").unwrap();
    let manager = ServiceManager::new(directory.path()).unwrap();
    manager
        .add_service(definition("socket", "echo socket", directory.path()))
        .await
        .unwrap();
    let controller = start_controller(
        manager.clone(),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        0,
        Some("socket-token".into()),
        static_dir,
    )
    .await
    .unwrap();
    let address = controller.address;

    let (mut denied, _) = connect_async(format!("ws://{address}/ws/events?token=wrong-token"))
        .await
        .unwrap();
    let closed = denied.next().await.unwrap().unwrap();
    let Message::Close(Some(frame)) = closed else {
        panic!("expected a policy close frame, got {closed:?}");
    };
    assert_eq!(u16::from(frame.code), 1008);

    let (mut socket, _) = connect_async(format!("ws://{address}/ws/events?token=socket-token"))
        .await
        .unwrap();
    let initial: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(initial["type"], "status");
    assert_eq!(initial["service"], "socket");

    socket.send(Message::Text("[]".into())).await.unwrap();
    let invalid: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(invalid["type"], "command_result");
    assert_eq!(invalid["ok"], false);
    assert_eq!(invalid["error"], "Command must be a JSON object");

    socket
        .send(Message::Text(
            r#"{"id":7,"action":"launch","service":"socket"}"#.into(),
        ))
        .await
        .unwrap();
    let unsupported: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(unsupported["id"], 7);
    assert_eq!(unsupported["action"], "launch");
    assert_eq!(unsupported["service"], "socket");
    assert_eq!(unsupported["ok"], false);

    socket.close(None).await.unwrap();
    manager.shutdown().await;
    controller.shutdown().await;
}

fn definition(name: &str, command: impl Into<String>, cwd: &std::path::Path) -> ServiceDefinition {
    ServiceDefinition {
        name: name.into(),
        command: command.into(),
        cwd: cwd.to_string_lossy().into_owned(),
        env: BTreeMap::new(),
        auto_start: false,
        stop_timeout: 0.5,
    }
}

async fn wait_for_log(manager: &ServiceManager, service: &str, needle: &str) {
    for _ in 0..100 {
        if manager
            .get_logs(service, 2_000)
            .await
            .unwrap()
            .iter()
            .any(|entry| entry.message.contains(needle))
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("expected {service} logs to contain {needle:?}");
}

#[tokio::test]
async fn manager_serializes_lifecycle_updates_and_delete_stops_the_process() {
    let directory = tempdir().unwrap();
    let manager = ServiceManager::new(directory.path()).unwrap();
    manager.initialize().await.unwrap();

    let command = if cfg!(windows) {
        "echo %SERVICE_TEST_VALUE% & ping -n 30 127.0.0.1 >NUL"
    } else {
        "printf '%s\\n' \"$SERVICE_TEST_VALUE\"; sleep 30"
    };
    let mut service = definition("lifecycle", command, directory.path());
    service
        .env
        .insert("SERVICE_TEST_VALUE".into(), "first".into());
    manager.add_service(service.clone()).await.unwrap();

    let (first, second) = tokio::join!(manager.start("lifecycle"), manager.start("lifecycle"));
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.pid, second.pid);
    assert_eq!(first.restart_count, 0);
    wait_for_log(&manager, "lifecycle", "first").await;

    service.command = command.replace("30", "29");
    service
        .env
        .insert("SERVICE_TEST_VALUE".into(), "second".into());
    let updated = manager.update_service("lifecycle", service).await.unwrap();
    assert_eq!(updated.pid, first.pid);
    assert!(updated.command.contains("29"));

    let restarted = manager.restart("lifecycle").await.unwrap();
    assert_eq!(restarted.state, ServiceState::Running);
    assert_eq!(restarted.restart_count, 1);
    wait_for_log(&manager, "lifecycle", "second").await;
    let running_pid = restarted.pid.unwrap();

    manager.delete_service("lifecycle").await.unwrap();
    assert!(manager.get_service("lifecycle").await.is_err());
    for _ in 0..40 {
        let mut system = sysinfo::System::new();
        let pid = sysinfo::Pid::from_u32(running_pid);
        system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        if system.process(pid).is_none() {
            manager.shutdown().await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    manager.shutdown().await;
    panic!("deleted service process {running_pid} is still running");
}

#[tokio::test]
async fn logs_larger_than_the_live_buffer_are_loaded_from_persistent_storage() {
    let directory = tempdir().unwrap();
    let manager = ServiceManager::new(directory.path()).unwrap();
    manager.initialize().await.unwrap();
    let command = if cfg!(windows) {
        "for /L %i in (1,1,1050) do @echo line-%i"
    } else {
        "i=1; while [ $i -le 1050 ]; do echo line-$i; i=$((i+1)); done"
    };
    manager
        .add_service(definition("many-logs", command, directory.path()))
        .await
        .unwrap();
    manager.start("many-logs").await.unwrap();
    wait_for_log(&manager, "many-logs", "line-1050").await;

    let logs = manager.get_logs("many-logs", 1_050).await.unwrap();
    assert_eq!(logs.len(), 1_050);
    assert_eq!(logs.first().unwrap().message, "line-1");
    assert_eq!(logs.last().unwrap().message, "line-1050");
    manager.shutdown().await;
}
