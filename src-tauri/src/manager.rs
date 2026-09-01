use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use chrono::Utc;
use futures_util::future::join_all;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    process::Command,
    sync::{Mutex, RwLock, broadcast},
    time::{Instant, sleep},
};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{
        LogEntry, ManagedService, ServiceDefinition, ServiceSnapshot, ServiceState,
        normalize_group_name,
    },
    process_guardian::{MANAGED_PROCESS_ID_ENV, ProcessGuardian, ProcessLease},
    runtime_log,
    store::DefinitionStore,
};

const LOG_BUFFER_SIZE: usize = 1_000;

#[derive(Debug, Clone, Serialize)]
pub struct GroupActionError {
    pub service: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupActionResult {
    pub group: String,
    pub action: String,
    pub services: Vec<ServiceSnapshot>,
    pub errors: Vec<GroupActionError>,
}

#[derive(Clone, Copy)]
enum GroupAction {
    Start,
    Stop,
}

impl GroupAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
        }
    }
}

pub struct ServiceManager {
    store: DefinitionStore,
    services: RwLock<BTreeMap<String, ManagedService>>,
    groups: RwLock<BTreeSet<String>>,
    child_environment: BTreeMap<String, String>,
    guardian: Mutex<ProcessGuardian>,
    events: broadcast::Sender<Value>,
    initialized: AtomicBool,
}

impl ServiceManager {
    pub fn new(data_dir: impl AsRef<Path>) -> AppResult<Arc<Self>> {
        let store = DefinitionStore::new(data_dir)?;
        let definitions = store.load()?;
        let mut groups = store.load_groups()?;
        let mut services = BTreeMap::new();
        for (name, definition) in definitions {
            if let Some(group) = definition.group.as_ref() {
                groups.insert(group.clone());
            }
            let logs = store.load_logs(&name, LOG_BUFFER_SIZE)?;
            services.insert(name, ManagedService::new(definition, logs));
        }
        store.save_groups(&groups)?;
        let (events, _) = broadcast::channel(1_024);
        let guardian = ProcessGuardian::new(store.data_dir());
        Ok(Arc::new(Self {
            store,
            services: RwLock::new(services),
            groups: RwLock::new(groups),
            child_environment: crate::shell_environment::resolve_desktop_service_environment(),
            guardian: Mutex::new(guardian),
            events,
            initialized: AtomicBool::new(false),
        }))
    }

    pub fn data_dir(&self) -> &Path {
        self.store.data_dir()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub async fn initialize(self: &Arc<Self>) -> AppResult<()> {
        if self.initialized.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        if let Err(error) = self.guardian.lock().await.ensure_started().await {
            self.initialized.store(false, Ordering::Release);
            return Err(error);
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            while let Some(manager) = weak.upgrade() {
                manager.refresh_metrics().await;
                sleep(Duration::from_secs(1)).await;
            }
        });
        let names: Vec<String> = self
            .services
            .read()
            .await
            .values()
            .filter(|service| service.definition.auto_start)
            .map(|service| service.definition.name.clone())
            .collect();
        runtime_log::info(
            "services.initialized",
            format_args!(
                "registered={} auto_start={}",
                self.services.read().await.len(),
                names.len()
            ),
        );
        for name in names {
            if let Err(error) = self.start(&name).await {
                self.set_failure(&name, error.to_string()).await;
            }
        }
        Ok(())
    }

    pub async fn shutdown(self: &Arc<Self>) {
        let names: Vec<String> = self
            .services
            .read()
            .await
            .iter()
            .filter(|(_, service)| service.pid.is_some())
            .map(|(name, _)| name.clone())
            .collect();
        for name in names {
            let _ = self.stop(&name).await;
        }
        if let Err(error) = self.guardian.lock().await.shutdown().await {
            runtime_log::warn("guardian.shutdown_failed", error);
        }
    }

    pub async fn list_services(&self) -> Vec<ServiceSnapshot> {
        self.services
            .read()
            .await
            .values()
            .map(ManagedService::snapshot)
            .collect()
    }

    pub async fn list_groups(&self) -> Vec<String> {
        self.groups.read().await.iter().cloned().collect()
    }

    pub async fn create_group(&self, name: &str) -> AppResult<String> {
        let name = normalize_group_name(name)?;
        let mut groups = self.groups.write().await;
        if !groups.insert(name.clone()) {
            return Err(AppError::conflict(format!(
                "service group already exists: {name}"
            )));
        }
        if let Err(error) = self.store.save_groups(&groups) {
            groups.remove(&name);
            return Err(error);
        }
        runtime_log::info("group.created", format_args!("name={name}"));
        Ok(name)
    }

    pub async fn delete_group(&self, name: &str) -> AppResult<Vec<ServiceSnapshot>> {
        let name = normalize_group_name(name)?;
        let mut groups = self.groups.write().await;
        if !groups.remove(&name) {
            return Err(AppError::not_found(format!("service group: {name}")));
        }
        let mut services = self.services.write().await;
        let affected: Vec<String> = services
            .iter()
            .filter(|(_, service)| service.definition.group.as_deref() == Some(name.as_str()))
            .map(|(service_name, _)| service_name.clone())
            .collect();
        for service_name in &affected {
            services
                .get_mut(service_name)
                .expect("affected service remains present")
                .definition
                .group = None;
        }
        let persist_result = self
            .persist_locked(&services)
            .and_then(|_| self.store.save_groups(&groups));
        if let Err(error) = persist_result {
            groups.insert(name.clone());
            for service_name in &affected {
                services
                    .get_mut(service_name)
                    .expect("affected service remains present while rolling back")
                    .definition
                    .group = Some(name.clone());
            }
            let _ = self.persist_locked(&services);
            let _ = self.store.save_groups(&groups);
            return Err(error);
        }
        let snapshots: Vec<_> = affected
            .iter()
            .filter_map(|service_name| services.get(service_name).map(ManagedService::snapshot))
            .collect();
        drop(services);
        drop(groups);
        for snapshot in &snapshots {
            self.emit_status(snapshot);
        }
        runtime_log::info(
            "group.deleted",
            format_args!("name={name} ungrouped_services={}", snapshots.len()),
        );
        Ok(snapshots)
    }

    pub async fn assign_group(
        &self,
        service_name: &str,
        group: Option<String>,
    ) -> AppResult<ServiceSnapshot> {
        let group = match group {
            Some(group) if !group.trim().is_empty() => Some(normalize_group_name(&group)?),
            _ => None,
        };
        let lifecycle = self.lifecycle_lock(service_name).await?;
        let _lifecycle = lifecycle.lock().await;
        let groups = self.groups.read().await;
        if let Some(group) = group.as_deref()
            && !groups.contains(group)
        {
            return Err(AppError::not_found(format!("service group: {group}")));
        }
        let snapshot = {
            let mut services = self.services.write().await;
            let service = services
                .get_mut(service_name)
                .ok_or_else(|| AppError::not_found(service_name.to_owned()))?;
            let previous = service.definition.group.clone();
            service.definition.group = group.clone();
            let snapshot = service.snapshot();
            if let Err(error) = self.persist_locked(&services) {
                services
                    .get_mut(service_name)
                    .expect("service remains present while rolling back group assignment")
                    .definition
                    .group = previous;
                return Err(error);
            }
            snapshot
        };
        drop(groups);
        self.emit_status(&snapshot);
        runtime_log::info(
            "service.group_changed",
            format_args!(
                "name={service_name} group={}",
                snapshot.group.as_deref().unwrap_or("ungrouped")
            ),
        );
        Ok(snapshot)
    }

    pub async fn start_group(self: &Arc<Self>, group: &str) -> AppResult<GroupActionResult> {
        self.run_group_action(group, GroupAction::Start).await
    }

    pub async fn stop_group(self: &Arc<Self>, group: &str) -> AppResult<GroupActionResult> {
        self.run_group_action(group, GroupAction::Stop).await
    }

    async fn run_group_action(
        self: &Arc<Self>,
        group: &str,
        action: GroupAction,
    ) -> AppResult<GroupActionResult> {
        let group = normalize_group_name(group)?;
        if !self.groups.read().await.contains(&group) {
            return Err(AppError::not_found(format!("service group: {group}")));
        }
        let names: Vec<_> = self
            .services
            .read()
            .await
            .iter()
            .filter(|(_, service)| service.definition.group.as_deref() == Some(group.as_str()))
            .map(|(name, _)| name.clone())
            .collect();
        let operations = names.into_iter().map(|name| {
            let manager = Arc::clone(self);
            async move {
                let result = match action {
                    GroupAction::Start => manager.start(&name).await,
                    GroupAction::Stop => manager.stop(&name).await,
                };
                (name, result)
            }
        });
        let mut services = Vec::new();
        let mut errors = Vec::new();
        for (service, result) in join_all(operations).await {
            match result {
                Ok(snapshot) => services.push(snapshot),
                Err(error) => errors.push(GroupActionError {
                    service,
                    error: error.to_string(),
                }),
            }
        }
        runtime_log::info(
            "group.action_completed",
            format_args!(
                "name={group} action={} succeeded={} failed={}",
                action.as_str(),
                services.len(),
                errors.len()
            ),
        );
        Ok(GroupActionResult {
            group,
            action: action.as_str().into(),
            services,
            errors,
        })
    }

    pub async fn get_service(&self, name: &str) -> AppResult<ServiceSnapshot> {
        self.services
            .read()
            .await
            .get(name)
            .map(ManagedService::snapshot)
            .ok_or_else(|| AppError::not_found(name.to_owned()))
    }

    pub async fn managed_pids(&self) -> HashMap<u32, String> {
        self.services
            .read()
            .await
            .values()
            .filter_map(|service| {
                service
                    .pid
                    .map(|pid| (pid, service.definition.name.clone()))
            })
            .collect()
    }

    pub async fn add_service(&self, definition: ServiceDefinition) -> AppResult<ServiceSnapshot> {
        let definition = definition.normalize()?;
        let groups = self.groups.read().await;
        if let Some(group) = definition.group.as_deref()
            && !groups.contains(group)
        {
            return Err(AppError::not_found(format!("service group: {group}")));
        }
        let name = definition.name.clone();
        let snapshot = {
            let mut services = self.services.write().await;
            if services.contains_key(&name) {
                return Err(AppError::conflict(format!(
                    "service already exists: {name}"
                )));
            }
            let service = ManagedService::new(definition, Vec::new());
            let snapshot = service.snapshot();
            services.insert(name.clone(), service);
            if let Err(error) = self.persist_locked(&services) {
                services.remove(&name);
                return Err(error);
            }
            snapshot
        };
        drop(groups);
        self.emit_status(&snapshot);
        Ok(snapshot)
    }

    pub async fn update_service(
        &self,
        name: &str,
        mut definition: ServiceDefinition,
    ) -> AppResult<ServiceSnapshot> {
        definition.name = name.to_owned();
        let definition = definition.normalize()?;
        let lifecycle = self.lifecycle_lock(name).await?;
        let _lifecycle = lifecycle.lock().await;
        let groups = self.groups.read().await;
        if let Some(group) = definition.group.as_deref()
            && !groups.contains(group)
        {
            return Err(AppError::not_found(format!("service group: {group}")));
        }
        let snapshot = {
            let mut services = self.services.write().await;
            let service = services
                .get_mut(name)
                .ok_or_else(|| AppError::not_found(name.to_owned()))?;
            let previous = service.definition.clone();
            service.definition = definition;
            let snapshot = service.snapshot();
            if let Err(error) = self.persist_locked(&services) {
                services
                    .get_mut(name)
                    .expect("service remains present while rolling back")
                    .definition = previous;
                return Err(error);
            }
            snapshot
        };
        drop(groups);
        self.emit_status(&snapshot);
        Ok(snapshot)
    }

    pub async fn delete_service(self: &Arc<Self>, name: &str) -> AppResult<()> {
        let lifecycle = self.lifecycle_lock(name).await?;
        let _lifecycle = lifecycle.lock().await;
        self.stop_inner(name).await?;
        {
            let mut services = self.services.write().await;
            let removed = services
                .remove(name)
                .ok_or_else(|| AppError::not_found(name.to_owned()))?;
            if let Err(error) = self.persist_locked(&services) {
                services.insert(name.into(), removed);
                return Err(error);
            }
        }
        self.store.delete_logs(name)?;
        Ok(())
    }

    pub async fn start(self: &Arc<Self>, name: &str) -> AppResult<ServiceSnapshot> {
        let lifecycle = self.lifecycle_lock(name).await?;
        let _lifecycle = lifecycle.lock().await;
        self.start_inner(name).await
    }

    async fn start_inner(self: &Arc<Self>, name: &str) -> AppResult<ServiceSnapshot> {
        let (definition, generation) = {
            let mut services = self.services.write().await;
            let service = services
                .get_mut(name)
                .ok_or_else(|| AppError::not_found(name.to_owned()))?;
            if service.pid.is_some()
                || matches!(
                    service.state,
                    ServiceState::Starting | ServiceState::Running
                )
            {
                return Ok(service.snapshot());
            }
            if service.state == ServiceState::Stopping {
                return Err(AppError::conflict(format!("service is stopping: {name}")));
            }
            service.state = ServiceState::Starting;
            service.exit_code = None;
            service.last_error = None;
            service.stopped_at = None;
            service.generation += 1;
            let snapshot = service.snapshot();
            self.emit_status(&snapshot);
            (service.definition.clone(), service.generation)
        };

        let registration_id = Uuid::new_v4().to_string();
        let mut command = shell_command(&definition.command);
        command
            .current_dir(&definition.cwd)
            .env_clear()
            .envs(&self.child_environment)
            .envs(&definition.env)
            .env(MANAGED_PROCESS_ID_ENV, &registration_id)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut command);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.set_failure(name, error.to_string()).await;
                return Err(AppError::conflict(format!(
                    "failed to start service {name}: {error}"
                )));
            }
        };
        let pid = child
            .id()
            .ok_or_else(|| AppError::Internal("spawned process has no PID".into()))?;
        let lease = ProcessLease::new(
            registration_id.clone(),
            name.to_owned(),
            pid,
            if cfg!(unix) { Some(pid) } else { None },
            definition.stop_timeout,
        );
        if let Err(error) = self.guardian.lock().await.track(lease).await {
            let _ = terminate_group(pid, true);
            let _ = child.wait().await;
            self.set_failure(name, error.to_string()).await;
            return Err(AppError::conflict(format!(
                "failed to contain service {name}: {error}"
            )));
        }
        #[cfg(windows)]
        if let Err(error) = crate::process_guardian::resume_windows_process(pid) {
            let _ = self.guardian.lock().await.release(&registration_id).await;
            let _ = child.wait().await;
            self.set_failure(name, error.to_string()).await;
            return Err(AppError::conflict(format!(
                "failed to resume service {name}: {error}"
            )));
        }
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let snapshot = {
            let mut services = self.services.write().await;
            let service = services
                .get_mut(name)
                .ok_or_else(|| AppError::not_found(name.to_owned()))?;
            if service.generation != generation {
                terminate_group(pid, true)?;
                return Err(AppError::conflict(format!(
                    "service changed while starting: {name}"
                )));
            }
            service.state = ServiceState::Running;
            service.pid = Some(pid);
            service.guardian_registration_id = Some(registration_id);
            service.started_at = Some(Utc::now());
            service.started_instant = Some(std::time::Instant::now());
            service.restart_count = service.successful_starts;
            service.successful_starts += 1;
            let snapshot = service.snapshot();
            self.emit_status(&snapshot);
            snapshot
        };

        if let Some(stdout) = stdout {
            let manager = Arc::clone(self);
            let name = name.to_owned();
            tokio::spawn(async move { manager.read_stream(name, "stdout", stdout).await });
        }
        if let Some(stderr) = stderr {
            let manager = Arc::clone(self);
            let name = name.to_owned();
            tokio::spawn(async move { manager.read_stream(name, "stderr", stderr).await });
        }
        let manager = Arc::clone(self);
        let name = name.to_owned();
        tokio::spawn(async move {
            let result = child.wait().await;
            manager.process_exited(&name, generation, result).await;
        });
        runtime_log::info(
            "service.started",
            format_args!("name={} pid={pid}", snapshot.name),
        );
        Ok(snapshot)
    }

    pub async fn stop(self: &Arc<Self>, name: &str) -> AppResult<ServiceSnapshot> {
        let lifecycle = self.lifecycle_lock(name).await?;
        let _lifecycle = lifecycle.lock().await;
        self.stop_inner(name).await
    }

    async fn stop_inner(self: &Arc<Self>, name: &str) -> AppResult<ServiceSnapshot> {
        let (pid, registration_id, timeout) = {
            let mut services = self.services.write().await;
            let service = services
                .get_mut(name)
                .ok_or_else(|| AppError::not_found(name.to_owned()))?;
            if service.pid.is_none() && service.guardian_registration_id.is_none() {
                return Ok(service.snapshot());
            }
            service.state = ServiceState::Stopping;
            let snapshot = service.snapshot();
            self.emit_status(&snapshot);
            (
                service.pid,
                service.guardian_registration_id.clone(),
                Duration::from_secs_f64(service.definition.stop_timeout),
            )
        };

        if let Some(pid) = pid {
            #[cfg(unix)]
            terminate_group(pid, false)?;
            #[cfg(windows)]
            let _ = terminate_group(pid, false);
            let deadline = Instant::now() + timeout;
            while process_group_exists(pid) && Instant::now() < deadline {
                sleep(Duration::from_millis(50)).await;
            }
            if process_group_exists(pid) {
                terminate_group(pid, true)?;
                let hard_deadline = Instant::now() + Duration::from_secs(3);
                while process_group_exists(pid) && Instant::now() < hard_deadline {
                    sleep(Duration::from_millis(50)).await;
                }
            }
        }
        if let Some(registration_id) = registration_id.as_deref() {
            self.guardian.lock().await.release(registration_id).await?;
        }

        let snapshot = {
            let mut services = self.services.write().await;
            let service = services
                .get_mut(name)
                .ok_or_else(|| AppError::not_found(name.to_owned()))?;
            service.state = ServiceState::Stopped;
            service.pid = None;
            if service.guardian_registration_id == registration_id {
                service.guardian_registration_id = None;
            }
            service.stopped_at = Some(Utc::now());
            service.started_instant = None;
            service.cpu_percent = 0.0;
            service.memory_rss = 0;
            let snapshot = service.snapshot();
            self.emit_status(&snapshot);
            snapshot
        };
        runtime_log::info("service.stopped", format_args!("name={}", snapshot.name));
        Ok(snapshot)
    }

    pub async fn restart(self: &Arc<Self>, name: &str) -> AppResult<ServiceSnapshot> {
        let lifecycle = self.lifecycle_lock(name).await?;
        let _lifecycle = lifecycle.lock().await;
        self.stop_inner(name).await?;
        self.start_inner(name).await
    }

    pub async fn get_logs(&self, name: &str, tail: usize) -> AppResult<Vec<LogEntry>> {
        let services = self.services.read().await;
        let service = services
            .get(name)
            .ok_or_else(|| AppError::not_found(name.to_owned()))?;
        if tail == 0 {
            return Ok(Vec::new());
        }
        if tail > LOG_BUFFER_SIZE {
            drop(services);
            return self.store.load_logs(name, tail);
        }
        let start = service.logs.len().saturating_sub(tail);
        Ok(service.logs.iter().skip(start).cloned().collect())
    }

    async fn read_stream<R>(self: Arc<Self>, name: String, stream: &'static str, reader: R)
    where
        R: AsyncRead + Unpin,
    {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            self.record_log(&name, stream, line).await;
        }
    }

    async fn record_log(&self, name: &str, stream: &str, message: String) {
        let entry = LogEntry::new(stream, message);
        let _ = self.store.append_log(name, &entry);
        let mut services = self.services.write().await;
        let Some(service) = services.get_mut(name) else {
            return;
        };
        if service.logs.len() == LOG_BUFFER_SIZE {
            service.logs.pop_front();
        }
        service.logs.push_back(entry.clone());
        let _ = self.events.send(json!({
            "type": "log",
            "service": name,
            "data": entry,
        }));
    }

    async fn process_exited(
        &self,
        name: &str,
        generation: u64,
        result: std::io::Result<std::process::ExitStatus>,
    ) {
        let registration_id = self
            .services
            .read()
            .await
            .get(name)
            .filter(|service| service.generation == generation)
            .and_then(|service| service.guardian_registration_id.clone());
        let guardian_error = if let Some(registration_id) = registration_id.as_deref() {
            self.guardian
                .lock()
                .await
                .release(registration_id)
                .await
                .err()
                .map(|error| error.to_string())
        } else {
            None
        };
        let mut services = self.services.write().await;
        let Some(service) = services.get_mut(name) else {
            return;
        };
        if service.generation != generation {
            return;
        }
        let was_stopping = service.state == ServiceState::Stopping;
        service.pid = None;
        if service.guardian_registration_id == registration_id && guardian_error.is_none() {
            service.guardian_registration_id = None;
        }
        service.stopped_at = Some(Utc::now());
        service.started_instant = None;
        service.cpu_percent = 0.0;
        service.memory_rss = 0;
        if let Some(error) = guardian_error {
            service.state = ServiceState::Failed;
            service.last_error = Some(format!("process guardian cleanup failed: {error}"));
        } else {
            match result {
                Ok(status) => {
                    service.exit_code = status.code();
                    service.state = if was_stopping {
                        ServiceState::Stopped
                    } else if status.success() {
                        ServiceState::Exited
                    } else {
                        ServiceState::Failed
                    };
                    if !status.success() && !was_stopping {
                        service.last_error = Some(format!("process exited with {status}"));
                    }
                }
                Err(error) => {
                    service.state = ServiceState::Failed;
                    service.last_error = Some(error.to_string());
                }
            }
        }
        let snapshot = service.snapshot();
        self.emit_status(&snapshot);
        drop(services);
        if snapshot.state == ServiceState::Failed {
            runtime_log::warn(
                "service.failed",
                format_args!(
                    "name={} exit_code={:?} error={}",
                    snapshot.name,
                    snapshot.exit_code,
                    snapshot.last_error.as_deref().unwrap_or("unknown")
                ),
            );
        } else if snapshot.state != ServiceState::Stopped {
            runtime_log::info(
                "service.exited",
                format_args!(
                    "name={} state={:?} exit_code={:?}",
                    snapshot.name, snapshot.state, snapshot.exit_code
                ),
            );
        }
    }

    async fn set_failure(&self, name: &str, message: String) {
        let mut services = self.services.write().await;
        if let Some(service) = services.get_mut(name) {
            service.state = ServiceState::Failed;
            service.pid = None;
            service.started_instant = None;
            service.last_error = Some(message.clone());
            self.emit_status(&service.snapshot());
        }
        drop(services);
        runtime_log::warn(
            "service.start_failed",
            format_args!("name={name} error={message}"),
        );
    }

    async fn refresh_metrics(&self) {
        let pids: Vec<u32> = self
            .services
            .read()
            .await
            .values()
            .filter_map(|service| service.pid)
            .collect();
        if pids.is_empty() {
            return;
        }
        let sampled = tokio::task::spawn_blocking(move || crate::system::sample_metrics(&pids))
            .await
            .unwrap_or_default();
        let mut services = self.services.write().await;
        for service in services.values_mut() {
            let Some(pid) = service.pid else { continue };
            let Some(metrics) = sampled.get(&pid) else {
                continue;
            };
            let changed = (service.cpu_percent - metrics.cpu_percent).abs() >= 0.1
                || service.memory_rss != metrics.memory_rss;
            service.cpu_percent = metrics.cpu_percent;
            service.memory_rss = metrics.memory_rss;
            if changed {
                self.emit_status(&service.snapshot());
            }
        }
    }

    async fn lifecycle_lock(&self, name: &str) -> AppResult<Arc<Mutex<()>>> {
        self.services
            .read()
            .await
            .get(name)
            .map(|service| Arc::clone(&service.lifecycle_lock))
            .ok_or_else(|| AppError::not_found(name.to_owned()))
    }

    fn persist_locked(&self, services: &BTreeMap<String, ManagedService>) -> AppResult<()> {
        self.store
            .save(services.values().map(|service| &service.definition))
    }

    fn emit_status(&self, snapshot: &ServiceSnapshot) {
        let _ = self.events.send(json!({
            "type": "status",
            "service": snapshot.name,
            "data": snapshot,
        }));
    }
}

#[cfg(unix)]
fn shell_command(command: &str) -> Command {
    let mut result = Command::new("/bin/sh");
    result.args(["-lc", command]);
    result
}

#[cfg(windows)]
fn shell_command(command: &str) -> Command {
    let mut result = Command::new("cmd.exe");
    let command = prepare_windows_shell_command(command);
    result.args(["/D", "/S", "/C", &command]);
    result
}

#[cfg(windows)]
fn prepare_windows_shell_command(command: &str) -> String {
    if command.starts_with(['\'', '"'])
        || !(command.starts_with("\\\\")
            || command
                .as_bytes()
                .get(1)
                .is_some_and(|character| *character == b':'))
    {
        return command.into();
    }
    let lower = command.to_ascii_lowercase();
    for extension in [".exe", ".com", ".bat", ".cmd"] {
        let Some(position) = lower.find(extension) else {
            continue;
        };
        let end = position + extension.len();
        let executable = &command[..end];
        let arguments = &command[end..];
        if (arguments.is_empty() || arguments.chars().next().is_some_and(char::is_whitespace))
            && executable.chars().any(char::is_whitespace)
        {
            return format!("\"{executable}\"{arguments}");
        }
    }
    command.into()
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
fn configure_process_group(command: &mut Command) {
    use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED};
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
}

#[cfg(unix)]
fn terminate_group(pid: u32, force: bool) -> AppResult<()> {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    let result = unsafe { libc::kill(-(pid as i32), signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error.into())
    }
}

#[cfg(windows)]
fn terminate_group(pid: u32, force: bool) -> AppResult<()> {
    let mut command = std::process::Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/T"]);
    if force {
        command.arg("/F");
    }
    let status = command.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::conflict(format!("taskkill failed for PID {pid}")))
    }
}

#[cfg(unix)]
fn process_group_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(-(pid as i32), 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_group_exists(pid: u32) -> bool {
    let mut system = sysinfo::System::new_all();
    system.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
        true,
    );
    system.process(sysinfo::Pid::from_u32(pid)).is_some()
}
