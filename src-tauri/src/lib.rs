pub mod error;
pub mod jenkins;
pub mod manager;
pub mod mcp_bridge;
pub mod mcp_integration;
pub mod models;
pub mod preferences;
pub mod process_guardian;
pub mod runtime;
pub mod server;
pub mod shell_environment;
pub mod store;
pub mod system;
pub mod update;
pub mod update_helper;

use std::{
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    sync::Arc,
};

use manager::ServiceManager;
use runtime::{RuntimeConnection, remove_runtime, runtime_path, write_runtime};
use server::{Controller, random_token, start_controller_with_update_exit};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Mutex;

struct DesktopState {
    manager: Mutex<Option<Arc<ServiceManager>>>,
    controller: Mutex<Option<Controller>>,
    connection: Mutex<Option<RuntimeConnection>>,
    runtime_file: PathBuf,
}

fn default_data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".service-console")
}

fn source_static_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("static")
}

pub fn run_desktop() {
    let data_dir = std::env::var_os("SERVICE_CONSOLE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(default_data_dir);
    let runtime_file = std::env::var_os("SERVICE_CONSOLE_RUNTIME_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_path(&data_dir));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(DesktopState {
            manager: Mutex::new(None),
            controller: Mutex::new(None),
            connection: Mutex::new(None),
            runtime_file: runtime_file.clone(),
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let data_dir = data_dir.clone();
            let static_dir = app
                .path()
                .resource_dir()
                .ok()
                .map(|directory| directory.join("static"))
                .filter(|directory| directory.join("index.html").is_file())
                .unwrap_or_else(source_static_dir);
            tauri::async_runtime::spawn(async move {
                let startup = async {
                    let manager = ServiceManager::new(&data_dir)?;
                    let token = random_token();
                    let exit_handle = handle.clone();
                    let controller = start_controller_with_update_exit(
                        Arc::clone(&manager),
                        IpAddr::V4(Ipv4Addr::LOCALHOST),
                        0,
                        Some(token.clone()),
                        static_dir,
                        Some(Arc::new(move || exit_handle.exit(0))),
                    )
                    .await?;
                    let connection = RuntimeConnection::new(controller.base_url(), token);
                    let state = handle.state::<DesktopState>();
                    write_runtime(&state.runtime_file, &connection)?;
                    let url = format!("{}?token={}", connection.base_url, connection.token)
                        .parse()
                        .map_err(|error| anyhow::anyhow!("invalid desktop URL: {error}"))?;
                    WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                        .title("Service Console")
                        .inner_size(1360.0, 860.0)
                        .min_inner_size(960.0, 640.0)
                        .build()?;
                    crate::update_helper::write_ready_marker_from_env()?;
                    *state.manager.lock().await = Some(manager);
                    *state.controller.lock().await = Some(controller);
                    *state.connection.lock().await = Some(connection);
                    anyhow::Ok(())
                }
                .await;
                if let Err(error) = startup {
                    eprintln!("desktop startup failed: {error:#}");
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Service Console desktop application");

    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = handle.state::<DesktopState>();
            tauri::async_runtime::block_on(async {
                if let Some(manager) = state.manager.lock().await.take() {
                    manager.shutdown().await;
                }
                if let Some(controller) = state.controller.lock().await.take() {
                    controller.shutdown().await;
                }
                if let Some(connection) = state.connection.lock().await.take() {
                    let _ = remove_runtime(&state.runtime_file, &connection.instance_id);
                }
            });
        }
    });
}
