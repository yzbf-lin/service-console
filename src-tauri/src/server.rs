use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{
        Path as AxumPath, Query, Request, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::StatusCode,
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{delete, get, post, put},
};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, sync::oneshot};
use tower_http::services::ServeDir;

use crate::{
    error::{AppError, AppResult},
    jenkins::{JenkinsInstanceInput, JenkinsService},
    manager::ServiceManager,
    mcp_integration::McpIntegration,
    models::ServiceDefinition,
    preferences::UiPreferencesStore,
    runtime_log, system,
    update::UpdateManager,
};

const CONTROLLER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone)]
pub struct AppState {
    pub manager: Arc<ServiceManager>,
    pub token: Option<String>,
    pub static_dir: PathBuf,
    pub preferences: UiPreferencesStore,
    pub jenkins: Arc<JenkinsService>,
    pub mcp: Arc<McpIntegration>,
    pub update: Arc<UpdateManager>,
    pub update_exit: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[derive(Debug, Deserialize)]
struct ServiceUpdateRequest {
    #[serde(default)]
    group: Option<String>,
    command: String,
    cwd: String,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    auto_start: bool,
    #[serde(default = "default_stop_timeout")]
    stop_timeout: f64,
}

#[derive(Debug, Deserialize)]
struct ServiceGroupRequest {
    group: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GroupCreateRequest {
    name: String,
}

fn default_stop_timeout() -> f64 {
    5.0
}

#[derive(Debug, Deserialize)]
struct TailQuery {
    #[serde(default = "default_tail")]
    tail: usize,
}
fn default_tail() -> usize {
    500
}

#[derive(Debug, Deserialize)]
struct PortQuery {
    port: Option<u16>,
}

#[derive(Debug, Deserialize)]
struct ProcessQuery {
    query: Option<String>,
    #[serde(default = "default_process_limit")]
    limit: usize,
}
fn default_process_limit() -> usize {
    100
}

#[derive(Debug, Deserialize)]
struct TerminateRequest {
    expected_port: Option<u16>,
    #[serde(default)]
    force: bool,
    #[serde(default = "default_terminate_timeout")]
    timeout: f64,
}
fn default_terminate_timeout() -> f64 {
    3.0
}

#[derive(Debug, Deserialize)]
struct ThemeRequest {
    theme: String,
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JenkinsJobsQuery {
    #[serde(default)]
    folder: String,
    query: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JenkinsJobQuery {
    job: String,
    #[serde(default)]
    include_parameter_options: bool,
}

#[derive(Debug, Deserialize)]
struct JenkinsBuildsQuery {
    job: String,
    #[serde(default = "default_build_limit")]
    limit: usize,
}
fn default_build_limit() -> usize {
    30
}

#[derive(Debug, Deserialize)]
struct JenkinsBuildQuery {
    job: String,
}

#[derive(Debug, Deserialize)]
struct JenkinsLogQuery {
    job: String,
    #[serde(default)]
    start: usize,
}

#[derive(Debug, Deserialize)]
struct JenkinsBuildRequest {
    #[serde(default)]
    parameters: BTreeMap<String, Value>,
}

pub struct Controller {
    pub address: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
    update: Arc<UpdateManager>,
    shutdown_timeout: Duration,
}

impl Controller {
    pub fn base_url(&self) -> String {
        format!("http://{}/", self.address)
    }

    pub fn request_shutdown(&self) {
        self.update.request_shutdown();
    }

    pub async fn shutdown(mut self) {
        self.request_shutdown();
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if tokio::time::timeout(self.shutdown_timeout, &mut self.task)
            .await
            .is_err()
        {
            runtime_log::warn(
                "controller.shutdown_timeout",
                "aborting local controller after graceful shutdown timeout",
            );
            self.task.abort();
            let _ = self.task.await;
        }
    }
}

pub async fn start_controller(
    manager: Arc<ServiceManager>,
    host: IpAddr,
    port: u16,
    token: Option<String>,
    static_dir: impl AsRef<Path>,
) -> AppResult<Controller> {
    start_controller_with_update_exit(manager, host, port, token, static_dir, None).await
}

pub async fn start_controller_with_update_exit(
    manager: Arc<ServiceManager>,
    host: IpAddr,
    port: u16,
    token: Option<String>,
    static_dir: impl AsRef<Path>,
    update_exit: Option<Arc<dyn Fn() + Send + Sync>>,
) -> AppResult<Controller> {
    if !host.is_loopback() && token.as_deref().is_none_or(str::is_empty) {
        return Err(AppError::bad_request(
            "A token is required when serving on a non-loopback address",
        ));
    }
    manager.initialize().await?;
    let jenkins = JenkinsService::new(manager.data_dir())?;
    let mcp = McpIntegration::new(manager.data_dir());
    let static_dir = static_dir.as_ref().to_path_buf();
    let public_key = static_dir
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("update_public_key.pem");
    let update = UpdateManager::new(manager.data_dir(), public_key);
    let controller_update = Arc::clone(&update);
    let state = AppState {
        preferences: UiPreferencesStore::new(manager.data_dir()),
        manager,
        token,
        static_dir,
        jenkins,
        mcp,
        update,
        update_exit,
    };
    let app = router(state);
    let listener = TcpListener::bind(SocketAddr::new(host, port)).await?;
    let address = listener.local_addr()?;
    runtime_log::info("controller.started", format_args!("listening on {address}"));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        let result = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
        if let Err(error) = result {
            runtime_log::error("controller.failed", error);
        }
    });
    Ok(Controller {
        address,
        shutdown: Some(shutdown_tx),
        task,
        update: controller_update,
        shutdown_timeout: CONTROLLER_SHUTDOWN_TIMEOUT,
    })
}

pub fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn router(state: AppState) -> Router {
    let token_state = state.token.clone();
    let api = Router::new()
        .route("/health", get(health))
        .route("/ui-preferences", put(update_preferences))
        .route("/app-update", get(update_status))
        .route("/app-update/check", post(check_update))
        .route("/app-update/download", post(download_update))
        .route("/app-update/install", post(install_update))
        .route("/mcp-integration", get(mcp_status).delete(remove_mcp))
        .route("/mcp-integration/install", post(install_mcp))
        .route("/mcp-integration/test", post(test_mcp))
        .route(
            "/jenkins/instances",
            get(jenkins_instances).post(create_jenkins_instance),
        )
        .route(
            "/jenkins/instances/{id}",
            put(update_jenkins_instance).delete(delete_jenkins_instance),
        )
        .route("/jenkins/instances/{id}/test", post(test_jenkins_instance))
        .route("/jenkins/instances/{id}/jobs", get(jenkins_jobs))
        .route("/jenkins/instances/{id}/job", get(jenkins_job))
        .route(
            "/jenkins/instances/{id}/job/parameters",
            post(jenkins_job_parameters),
        )
        .route(
            "/jenkins/instances/{id}/builds",
            get(jenkins_builds).post(trigger_jenkins_build),
        )
        .route(
            "/jenkins/instances/{id}/builds/{number}",
            get(jenkins_build),
        )
        .route(
            "/jenkins/instances/{id}/builds/{number}/stop",
            post(stop_jenkins_build),
        )
        .route(
            "/jenkins/instances/{id}/builds/{number}/log",
            get(jenkins_build_log),
        )
        .route("/jenkins/instances/{id}/queue", get(jenkins_queue))
        .route(
            "/jenkins/instances/{id}/queue/{queue_id}/cancel",
            post(cancel_jenkins_queue),
        )
        .route("/services", get(list_services).post(add_service))
        .route(
            "/service-groups",
            get(list_service_groups).post(create_service_group),
        )
        .route("/service-groups/{name}", delete(delete_service_group))
        .route("/service-groups/{name}/start", post(start_service_group))
        .route("/service-groups/{name}/stop", post(stop_service_group))
        .route(
            "/services/{name}",
            put(update_service).delete(delete_service),
        )
        .route("/services/{name}/group", put(assign_service_group))
        .route("/services/{name}/start", post(start_service))
        .route("/services/{name}/stop", post(stop_service))
        .route("/services/{name}/restart", post(restart_service))
        .route("/services/{name}/logs", get(service_logs))
        .route("/ports", get(list_ports))
        .route("/processes", get(list_processes))
        .route("/processes/{pid}", get(get_process))
        .route("/processes/{pid}/terminate", post(terminate_process))
        .layer(middleware::from_fn_with_state(token_state, require_token));

    let static_service = ServeDir::new(&state.static_dir);
    Router::new()
        .nest("/api", api)
        .route("/ws/events", get(websocket_events))
        .route("/", get(index))
        .nest_service("/static", static_service.clone())
        .fallback_service(static_service)
        .with_state(state)
}

async fn require_token(
    State(expected): State<Option<String>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(expected) = expected else {
        return next.run(request).await;
    };
    let supplied = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, credentials)| credentials);
    if !supplied.is_some_and(|value| constant_eq(value, &expected)) {
        return (
            StatusCode::UNAUTHORIZED,
            [("www-authenticate", "Bearer")],
            Json(json!({"detail": "Invalid or missing bearer token"})),
        )
            .into_response();
    }
    next.run(request).await
}

fn constant_eq(left: &str, right: &str) -> bool {
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

async fn health() -> Json<Value> {
    Json(json!({"status": "ok"}))
}

async fn index(
    State(state): State<AppState>,
) -> AppResult<([(&'static str, &'static str); 1], Html<String>)> {
    let mut html = tokio::fs::read_to_string(state.static_dir.join("index.html")).await?;
    let theme = state.preferences.load_theme();
    html = html.replace("__SERVICE_CONSOLE_THEME__", &theme);
    html = html.replace(
        "data-theme-preference=\"system\"",
        &format!("data-theme-preference=\"{theme}\""),
    );
    if !html.contains("data-theme-preference=") {
        html = html.replacen(
            "<html",
            &format!("<html data-theme-preference=\"{theme}\""),
            1,
        );
    }
    Ok(([("cache-control", "no-store")], Html(html)))
}

async fn update_preferences(
    State(state): State<AppState>,
    Json(body): Json<ThemeRequest>,
) -> AppResult<Json<Value>> {
    state.preferences.save_theme(&body.theme)?;
    Ok(Json(json!({"theme": body.theme})))
}

async fn update_status(State(state): State<AppState>) -> Json<Value> {
    Json(json!({"update": state.update.status().await}))
}

async fn check_update(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(json!({"update": state.update.check().await?})))
}

async fn download_update(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(json!({"update": state.update.download().await?})))
}

async fn install_update(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let update = state.update.install().await?;
    if update.restart_required
        && let Some(exit) = state.update_exit
    {
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            exit();
        });
    }
    Ok(Json(json!({"update": update})))
}

async fn mcp_status(State(state): State<AppState>) -> Json<Value> {
    Json(json!({"mcp": state.mcp.status().await}))
}

async fn install_mcp(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(json!({"mcp": state.mcp.install().await?})))
}

async fn test_mcp(State(state): State<AppState>) -> Json<Value> {
    Json(json!({"mcp": state.mcp.test().await}))
}

async fn remove_mcp(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(json!({"mcp": state.mcp.remove().await?})))
}

async fn jenkins_instances(State(state): State<AppState>) -> Json<Value> {
    Json(json!({"instances": state.jenkins.list_instances().await}))
}

async fn create_jenkins_instance(
    State(state): State<AppState>,
    Json(body): Json<JenkinsInstanceInput>,
) -> AppResult<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::CREATED,
        Json(json!({"instance": state.jenkins.create_instance(body).await?})),
    ))
}

async fn update_jenkins_instance(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<JenkinsInstanceInput>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        json!({"instance": state.jenkins.update_instance(&id, body).await?}),
    ))
}

async fn delete_jenkins_instance(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Value>> {
    state.jenkins.delete_instance(&id).await?;
    Ok(Json(json!({"deleted": id})))
}

async fn test_jenkins_instance(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        json!({"connection": state.jenkins.test_connection(&id).await?}),
    ))
}

async fn jenkins_jobs(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<JenkinsJobsQuery>,
) -> AppResult<Json<Value>> {
    let folder = query.folder.trim().trim_matches('/').to_owned();
    Ok(Json(
        json!({"folder": folder, "jobs": state.jenkins.list_jobs(&id, &query.folder, query.query.as_deref()).await?}),
    ))
}

async fn jenkins_job(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<JenkinsJobQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        json!({"job": state.jenkins.get_job(&id, &query.job, query.include_parameter_options, None).await?}),
    ))
}

async fn jenkins_job_parameters(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<JenkinsJobQuery>,
    Json(body): Json<JenkinsBuildRequest>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        json!({"job": state.jenkins.get_job(&id, &query.job, true, Some(&body.parameters)).await?}),
    ))
}

async fn jenkins_builds(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<JenkinsBuildsQuery>,
) -> AppResult<Json<Value>> {
    if query.limit == 0 || query.limit > 100 {
        return Err(AppError::bad_request("limit must be between 1 and 100"));
    }
    Ok(Json(
        json!({"job": query.job, "builds": state.jenkins.list_builds(&id, &query.job, query.limit).await?}),
    ))
}

async fn jenkins_build(
    State(state): State<AppState>,
    AxumPath((id, number)): AxumPath<(String, u64)>,
    Query(query): Query<JenkinsBuildQuery>,
) -> AppResult<Json<Value>> {
    if number == 0 {
        return Err(AppError::bad_request("build number must be positive"));
    }
    Ok(Json(
        json!({"build": state.jenkins.get_build(&id, &query.job, number).await?}),
    ))
}

async fn trigger_jenkins_build(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<JenkinsBuildQuery>,
    Json(body): Json<JenkinsBuildRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::ACCEPTED,
        Json(
            json!({"queue": state.jenkins.trigger_build(&id, &query.job, &body.parameters).await?}),
        ),
    ))
}

async fn stop_jenkins_build(
    State(state): State<AppState>,
    AxumPath((id, number)): AxumPath<(String, u64)>,
    Query(query): Query<JenkinsBuildQuery>,
) -> AppResult<Json<Value>> {
    if number == 0 {
        return Err(AppError::bad_request("build number must be positive"));
    }
    state.jenkins.stop_build(&id, &query.job, number).await?;
    Ok(Json(
        json!({"build":{"job":query.job,"number":number,"stopped":true}}),
    ))
}

async fn jenkins_queue(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(json!({"queue": state.jenkins.list_queue(&id).await?})))
}

async fn cancel_jenkins_queue(
    State(state): State<AppState>,
    AxumPath((id, queue_id)): AxumPath<(String, u64)>,
) -> AppResult<Json<Value>> {
    if queue_id == 0 {
        return Err(AppError::bad_request("queue id must be positive"));
    }
    state.jenkins.cancel_queue(&id, queue_id).await?;
    Ok(Json(json!({"queue":{"id":queue_id,"cancelled":true}})))
}

async fn jenkins_build_log(
    State(state): State<AppState>,
    AxumPath((id, number)): AxumPath<(String, u64)>,
    Query(query): Query<JenkinsLogQuery>,
) -> AppResult<Json<Value>> {
    if number == 0 {
        return Err(AppError::bad_request("build number must be positive"));
    }
    let log = state
        .jenkins
        .progressive_log(&id, &query.job, number, query.start)
        .await?;
    Ok(Json(
        json!({"log":{"job":query.job,"number":number,"offset":log["offset"],"next_offset":log["next_offset"],"text":log["text"],"more":log["more"],"complete":log["complete"]}}),
    ))
}

async fn list_services(State(state): State<AppState>) -> Json<Value> {
    Json(json!({"services": state.manager.list_services().await}))
}

async fn list_service_groups(State(state): State<AppState>) -> Json<Value> {
    Json(json!({"groups": state.manager.list_groups().await}))
}

async fn create_service_group(
    State(state): State<AppState>,
    Json(body): Json<GroupCreateRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let group = state.manager.create_group(&body.name).await?;
    Ok((StatusCode::CREATED, Json(json!({"group": group}))))
}

async fn delete_service_group(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> AppResult<Json<Value>> {
    let services = state.manager.delete_group(&name).await?;
    Ok(Json(json!({"deleted": name, "services": services})))
}

async fn start_service_group(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        json!({"result": state.manager.start_group(&name).await?}),
    ))
}

async fn stop_service_group(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        json!({"result": state.manager.stop_group(&name).await?}),
    ))
}

async fn add_service(
    State(state): State<AppState>,
    Json(body): Json<ServiceDefinition>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let service = state.manager.add_service(body).await?;
    Ok((StatusCode::CREATED, Json(json!({"service": service}))))
}

async fn update_service(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<ServiceUpdateRequest>,
) -> AppResult<Json<Value>> {
    let definition = ServiceDefinition {
        name: name.clone(),
        group: body.group,
        command: body.command,
        cwd: body.cwd,
        env: body.env,
        auto_start: body.auto_start,
        stop_timeout: body.stop_timeout,
    };
    let service = state.manager.update_service(&name, definition).await?;
    Ok(Json(json!({"service": service})))
}

async fn assign_service_group(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<ServiceGroupRequest>,
) -> AppResult<Json<Value>> {
    let service = state.manager.assign_group(&name, body.group).await?;
    Ok(Json(json!({"service": service})))
}

async fn delete_service(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> AppResult<Json<Value>> {
    state.manager.delete_service(&name).await?;
    Ok(Json(json!({"deleted": name})))
}

async fn start_service(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(json!({"service": state.manager.start(&name).await?})))
}

async fn stop_service(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(json!({"service": state.manager.stop(&name).await?})))
}

async fn restart_service(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        json!({"service": state.manager.restart(&name).await?}),
    ))
}

async fn service_logs(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
    Query(query): Query<TailQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        json!({"service": name, "logs": state.manager.get_logs(&name, query.tail).await?}),
    ))
}

async fn list_ports(Query(query): Query<PortQuery>) -> AppResult<Json<Value>> {
    let rows = tokio::task::spawn_blocking(move || system::list_ports(query.port))
        .await
        .map_err(|error| AppError::Internal(error.to_string()))??;
    Ok(Json(json!({"ports": rows})))
}

async fn list_processes(
    State(state): State<AppState>,
    Query(query): Query<ProcessQuery>,
) -> AppResult<Json<Value>> {
    if query.limit == 0 || query.limit > 500 {
        return Err(AppError::bad_request("limit must be between 1 and 500"));
    }
    if query.query.as_ref().is_some_and(|value| value.len() > 200) {
        return Err(AppError::bad_request(
            "process query must not exceed 200 characters",
        ));
    }
    let managed = state.manager.managed_pids().await;
    let rows = tokio::task::spawn_blocking(move || {
        system::list_processes(query.query.as_deref(), query.limit, &managed)
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))??;
    Ok(Json(json!({"processes": rows})))
}

async fn get_process(
    State(state): State<AppState>,
    AxumPath(pid): AxumPath<u32>,
) -> AppResult<Json<Value>> {
    if pid <= 1 {
        return Err(AppError::bad_request("pid must be greater than 1"));
    }
    let managed = state.manager.managed_pids().await;
    let row = tokio::task::spawn_blocking(move || system::get_process(pid, &managed))
        .await
        .map_err(|error| AppError::Internal(error.to_string()))??;
    Ok(Json(json!({"process": row})))
}

async fn terminate_process(
    AxumPath(pid): AxumPath<u32>,
    Json(body): Json<TerminateRequest>,
) -> AppResult<Json<Value>> {
    if !body.timeout.is_finite() || body.timeout <= 0.0 {
        return Err(AppError::bad_request(
            "timeout must be a finite positive number",
        ));
    }
    let result = tokio::task::spawn_blocking(move || {
        system::terminate_process(pid, body.expected_port, body.force, body.timeout)
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))??;
    Ok(Json(json!({"result": result})))
}

async fn websocket_events(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if state.token.as_ref().is_some_and(|expected| {
        !query
            .token
            .as_deref()
            .is_some_and(|value| constant_eq(value, expected))
    }) {
        return upgrade
            .on_upgrade(|mut socket| async move {
                let _ = socket
                    .send(Message::Close(Some(CloseFrame {
                        code: 1008,
                        reason: "Invalid or missing token".into(),
                    })))
                    .await;
            })
            .into_response();
    }
    upgrade
        .on_upgrade(move |socket| handle_socket(socket, state.manager))
        .into_response()
}

async fn handle_socket(socket: WebSocket, manager: Arc<ServiceManager>) {
    let (mut sender, mut receiver) = socket.split();
    for service in manager.list_services().await {
        if sender
            .send(Message::Text(
                json!({"type": "status", "service": service.name, "data": service})
                    .to_string()
                    .into(),
            ))
            .await
            .is_err()
        {
            return;
        }
    }
    let mut events = manager.subscribe();
    loop {
        tokio::select! {
            received = receiver.next() => {
                let Some(Ok(message)) = received else { break; };
                if let Message::Text(text) = message {
                    let response = handle_socket_command(&manager, &text).await;
                    if sender.send(Message::Text(response.to_string().into())).await.is_err() { break; }
                }
            }
            event = events.recv() => {
                match event {
                    Ok(event) => if sender.send(Message::Text(event.to_string().into())).await.is_err() { break; },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
}

async fn handle_socket_command(manager: &Arc<ServiceManager>, text: &str) -> Value {
    let payload: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(error) => {
            return json!({"type": "command_result", "id": null, "ok": false, "error": format!("Invalid JSON command: {error}")});
        }
    };
    if !payload.is_object() {
        return json!({
            "type": "command_result",
            "id": null,
            "ok": false,
            "error": "Command must be a JSON object"
        });
    }
    let id = payload.get("id").cloned().unwrap_or(Value::Null);
    let action = payload.get("action").and_then(Value::as_str);
    let service = payload.get("service").and_then(Value::as_str);
    let Some(action) = action else {
        return json!({"type":"command_result","id":id,"action":null,"service":service,"ok":false,"error":"Unsupported action: null"});
    };
    if !matches!(action, "start" | "stop" | "restart") {
        return json!({"type":"command_result","id":id,"action":action,"service":service,"ok":false,"error":format!("Unsupported action: {action}")});
    }
    let Some(service) = service.filter(|value| !value.trim().is_empty()) else {
        return json!({"type":"command_result","id":id,"action":action,"service":service,"ok":false,"error":"Service must be a non-empty string"});
    };
    let result = match action {
        "start" => manager.start(service).await,
        "stop" => manager.stop(service).await,
        _ => manager.restart(service).await,
    };
    match result {
        Ok(data) => {
            json!({"type":"command_result","id":id,"action":action,"service":service,"ok":true,"data":data})
        }
        Err(error) => {
            json!({"type":"command_result","id":id,"action":action,"service":service,"ok":false,"error":error.to_string()})
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn controller_shutdown_aborts_a_stuck_server_after_the_deadline() {
        let directory = tempdir().unwrap();
        let controller = Controller {
            address: SocketAddr::from(([127, 0, 0, 1], 0)),
            shutdown: None,
            task: tokio::spawn(std::future::pending()),
            update: UpdateManager::new(directory.path(), directory.path().join("key.pem")),
            shutdown_timeout: Duration::from_millis(20),
        };

        tokio::time::timeout(Duration::from_secs(1), controller.shutdown())
            .await
            .expect("controller shutdown must have a hard deadline");
    }
}
