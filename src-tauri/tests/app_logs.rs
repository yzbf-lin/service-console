use std::{
    fs,
    net::{IpAddr, Ipv4Addr},
};

use reqwest::StatusCode;
use serde_json::{Value, json};
use service_console::{manager::ServiceManager, runtime_log, server::start_controller};
use tempfile::tempdir;

#[tokio::test]
async fn application_logs_are_authenticated_bounded_and_capture_operation_failures() {
    let directory = tempdir().unwrap();
    runtime_log::init(directory.path()).unwrap();
    let manager = ServiceManager::new(directory.path()).unwrap();
    let controller = start_controller(
        manager.clone(),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        0,
        Some("diagnostic-token".into()),
        directory.path(),
    )
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let base = controller.base_url();
    let url = format!("{base}api/app-logs");
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(&url)
            .json(&json!({"event":"ui.error", "message":"no auth"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .get(format!("{url}?limit=1001"))
            .bearer_auth("diagnostic-token")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .get(format!("{url}?limit=0"))
            .bearer_auth("diagnostic-token")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .post(&url)
            .bearer_auth("diagnostic-token")
            .json(&json!({"event":"arbitrary\ninjected", "message":"invalid"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );

    for _ in 0..2 {
        assert_eq!(client.post(&url).bearer_auth("diagnostic-token").json(&json!({"event":"ui.error", "message":"failure diagnostic-token password=credential-value"})).send().await.unwrap().status(), StatusCode::NO_CONTENT);
        assert_eq!(
            client
                .post(format!(
                    "{base}api/services/missing/start?secret=do-not-log-query"
                ))
                .bearer_auth("diagnostic-token")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    let result: Value = client
        .get(&url)
        .bearer_auth("diagnostic-token")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let logs = result["logs"].as_array().unwrap();
    assert_eq!(
        logs.iter()
            .filter(|entry| entry["event"] == "ui.error")
            .count(),
        1
    );
    let failures: Vec<_> = logs
        .iter()
        .filter(|entry| entry["event"] == "api.rejected")
        .collect();
    assert_eq!(failures.len(), 1);
    assert!(
        failures[0]["message"]
            .as_str()
            .unwrap()
            .contains("/services/{name}/start")
    );
    assert_eq!(result["max_file_bytes"], 1024 * 1024);
    assert_eq!(result["retained_files"], 3);
    let persisted = fs::read_to_string(directory.path().join("logs/service-console.log")).unwrap();
    for secret in [
        "diagnostic-token",
        "credential-value",
        "do-not-log-query",
        "no auth",
        "injected",
    ] {
        assert!(!persisted.contains(secret), "unexpected secret: {secret}");
    }
    let tail: Value = client
        .get(format!("{url}?limit=1"))
        .bearer_auth("diagnostic-token")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(tail["logs"].as_array().unwrap().len(), 1);
    manager.shutdown().await;
    controller.shutdown().await;
}
