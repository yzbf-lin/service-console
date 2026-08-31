use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use chrono::Utc;
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
    models::{LogEntry, ManagedService, ServiceDefinition, ServiceSnapshot, ServiceState},
    process_guardian::{MANAGED_PROCESS_ID_ENV, ProcessGuardian, ProcessLease},
    store::DefinitionStore,
};

const LOG_BUFFER_SIZE: usize = 1_000;

pub struct ServiceManager {
    store: DefinitionStore,
    services: RwLock<BTreeMap<String, ManagedService>>,
    child_environment: BTreeMap<String, String>,
    guardian: Mutex<ProcessGuardian>,
    events: broadcast::Sender<Value>,
    initialized: AtomicBool,
}

impl ServiceManager {
    pub fn new(data_dir: impl AsRef<Path>) -> AppResult<Arc<Self>> {
        let store = DefinitionStore::new(data_dir)?;
        let definitions = store.load()?;
        let mut services = BTreeMap::new();
        for (name, definition) in definitions {
            let logs = store.load_logs(&name, LOG_BUFFER_SIZE)?;
            services.insert(name, ManagedService::new(definition, logs));
        }
        let (events, _) = broadcast::channel(1_024);
        let guardian = ProcessGuardian::new(store.data_dir());
        Ok(Arc::new(Self {
            store,
            services: RwLock::new(services),
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
            eprintln!("process guardian shutdown failed: {error}");
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
        self.emit_status(&service.snapshot());
    }

    async fn set_failure(&self, name: &str, message: String) {
        let mut services = self.services.write().await;
        if let Some(service) = services.get_mut(name) {
            service.state = ServiceState::Failed;
            service.pid = None;
            service.started_instant = None;
            service.last_error = Some(message);
            self.emit_status(&service.snapshot());
        }
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
