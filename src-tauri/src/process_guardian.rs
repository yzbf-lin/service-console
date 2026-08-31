use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader as StdBufReader, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate, System};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::expand_home,
};

pub const MANAGED_PROCESS_ID_ENV: &str = "SERVICE_CONSOLE_MANAGED_PROCESS_ID";
pub const STATE_FILENAME: &str = "managed-processes.json";
const LOCK_FILENAME: &str = "managed-processes.lock";
const PROTOCOL_VERSION: u32 = 1;
const MAX_MESSAGE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProcessLease {
    pub registration_id: String,
    pub service: String,
    pub pid: u32,
    #[serde(default)]
    pub start_time: Option<u64>,
    #[serde(default)]
    pub create_time: Option<f64>,
    pub pgid: Option<u32>,
    pub stop_timeout: f64,
}

impl ProcessLease {
    pub fn new(
        registration_id: String,
        service: String,
        pid: u32,
        pgid: Option<u32>,
        stop_timeout: f64,
    ) -> Self {
        Self {
            registration_id,
            service,
            pid,
            start_time: None,
            create_time: None,
            pgid,
            stop_timeout,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.registration_id.is_empty()
            || self.registration_id.len() > 4_096
            || self.service.is_empty()
            || self.service.len() > 4_096
            || self.pid == 0
            || !self.stop_timeout.is_finite()
            || !(0.0..=300.0).contains(&self.stop_timeout)
        {
            return Err("invalid managed-process lease".into());
        }
        #[cfg(unix)]
        if self.pgid.is_none_or(|pgid| pgid == 0) {
            return Err("POSIX managed-process leases require a process group".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct ProcessOwner {
    pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    start_time: Option<u64>,
    // Kept for compatibility with state written by the Python guardian.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    create_time: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct GuardianState {
    version: u32,
    owner: ProcessOwner,
    leases: Vec<ProcessLease>,
}

pub struct ProcessGuardian {
    data_dir: PathBuf,
    worker: Option<Child>,
    input: Option<ChildStdin>,
    output: Option<BufReader<ChildStdout>>,
    tracked: BTreeMap<String, f64>,
}

impl ProcessGuardian {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self {
            data_dir: expand_home(data_dir),
            worker: None,
            input: None,
            output: None,
            tracked: BTreeMap::new(),
        }
    }

    pub async fn ensure_started(&mut self) -> AppResult<()> {
        if let Some(worker) = self.worker.as_mut()
            && worker.try_wait()?.is_none()
        {
            return Ok(());
        }
        self.disconnect();
        fs::create_dir_all(&self.data_dir)?;
        let owner = process_owner(std::process::id())?;
        let executable = guardian_executable()?;
        let mut command = Command::new(executable);
        command
            .arg("--process-guardian")
            .arg("--data-dir")
            .arg(&self.data_dir)
            .arg("--owner-pid")
            .arg(owner.pid.to_string())
            .arg("--owner-start-time")
            .arg(owner.start_time.unwrap_or_default().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        configure_guardian_process(&mut command);
        let mut worker = command.spawn()?;
        let input = worker
            .stdin
            .take()
            .ok_or_else(|| AppError::Internal("guardian stdin was not created".into()))?;
        let output = worker
            .stdout
            .take()
            .ok_or_else(|| AppError::Internal("guardian stdout was not created".into()))?;
        self.worker = Some(worker);
        self.input = Some(input);
        self.output = Some(BufReader::new(output));

        let hello = timeout(Duration::from_secs(8), self.read_response())
            .await
            .map_err(|_| AppError::Internal("process guardian startup timed out".into()))??;
        if hello.get("type") != Some(&Value::String("hello".into()))
            || hello.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION.into())
            || hello.get("ok").and_then(Value::as_bool) != Some(true)
        {
            let detail = hello
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("invalid guardian handshake");
            self.disconnect();
            return Err(AppError::Internal(detail.into()));
        }
        Ok(())
    }

    pub async fn track(&mut self, lease: ProcessLease) -> AppResult<()> {
        lease.validate().map_err(AppError::bad_request)?;
        self.ensure_started().await?;
        let response = self
            .request(json!({"action": "track", "lease": lease}))
            .await?;
        response_ok(&response)?;
        self.tracked
            .insert(lease.registration_id.clone(), lease.stop_timeout);
        Ok(())
    }

    pub async fn release(&mut self, registration_id: &str) -> AppResult<()> {
        if self.worker.is_none() {
            return Err(AppError::Internal("process guardian is not running".into()));
        }
        let wait = self.tracked.get(registration_id).copied().unwrap_or(0.0) + 5.0;
        let response = timeout(
            Duration::from_secs_f64(wait.max(5.0)),
            self.request(json!({
                "action": "release",
                "registration_id": registration_id,
            })),
        )
        .await
        .map_err(|_| AppError::Internal("process guardian release timed out".into()))??;
        response_ok(&response)?;
        self.tracked.remove(registration_id);
        Ok(())
    }

    pub async fn shutdown(&mut self) -> AppResult<()> {
        if self.worker.is_none() {
            return Ok(());
        }
        let wait = self.tracked.values().copied().sum::<f64>() + 8.0;
        let response = timeout(
            Duration::from_secs_f64(wait.max(8.0)),
            self.request(json!({"action": "shutdown"})),
        )
        .await
        .map_err(|_| AppError::Internal("process guardian shutdown timed out".into()))??;
        response_ok(&response)?;
        if let Some(mut worker) = self.worker.take() {
            let _ = timeout(Duration::from_secs(2), worker.wait()).await;
        }
        self.input = None;
        self.output = None;
        self.tracked.clear();
        Ok(())
    }

    async fn request(&mut self, mut payload: Value) -> AppResult<Value> {
        let request_id = Uuid::new_v4().to_string();
        payload["id"] = Value::String(request_id.clone());
        let mut encoded = serde_json::to_vec(&payload)?;
        encoded.push(b'\n');
        if encoded.len() > MAX_MESSAGE_BYTES {
            return Err(AppError::bad_request("guardian request is too large"));
        }
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| AppError::Internal("process guardian is disconnected".into()))?;
        if let Err(error) = input.write_all(&encoded).await {
            self.disconnect();
            return Err(error.into());
        }
        input.flush().await?;
        let response = self.read_response().await?;
        if response.get("id").and_then(Value::as_str) != Some(&request_id) {
            return Err(AppError::Internal(
                "process guardian response id did not match".into(),
            ));
        }
        Ok(response)
    }

    async fn read_response(&mut self) -> AppResult<Value> {
        let output = self
            .output
            .as_mut()
            .ok_or_else(|| AppError::Internal("process guardian is disconnected".into()))?;
        let mut line = Vec::new();
        let length = output.read_until(b'\n', &mut line).await?;
        if length == 0 {
            self.disconnect();
            return Err(AppError::Internal(
                "process guardian closed its response pipe".into(),
            ));
        }
        if line.len() > MAX_MESSAGE_BYTES || !line.ends_with(b"\n") {
            return Err(AppError::Internal(
                "process guardian returned an invalid response".into(),
            ));
        }
        Ok(serde_json::from_slice(&line)?)
    }

    fn disconnect(&mut self) {
        self.input = None;
        self.output = None;
        self.worker = None;
    }
}

fn response_ok(response: &Value) -> AppResult<()> {
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    Err(AppError::Internal(
        response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("process guardian rejected the request")
            .into(),
    ))
}

fn guardian_executable() -> AppResult<PathBuf> {
    if let Some(path) = std::env::var_os("SERVICE_CONSOLE_GUARDIAN_EXE") {
        return Ok(PathBuf::from(path));
    }
    let current = std::env::current_exe()?;
    let stem = current
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or_default();
    if matches!(stem, "service-console" | "service-console-desktop") {
        return Ok(current);
    }
    let file_name = if cfg!(windows) {
        "service-console-guardian.exe"
    } else {
        "service-console-guardian"
    };
    let mut candidates = vec![current.with_file_name(file_name)];
    if let Some(debug_dir) = current.parent().and_then(Path::parent) {
        candidates.push(debug_dir.join(file_name));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            AppError::Internal("service-console guardian executable was not found".into())
        })
}

fn process_owner(pid: u32) -> AppResult<ProcessOwner> {
    let mut system = System::new();
    let sys_pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[sys_pid]), true);
    let process = system
        .process(sys_pid)
        .ok_or_else(|| AppError::Internal("controller process identity was not found".into()))?;
    Ok(ProcessOwner {
        pid,
        start_time: Some(process.start_time()),
        create_time: None,
    })
}

#[cfg(unix)]
fn configure_guardian_process(command: &mut Command) {
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
fn configure_guardian_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

struct StateLock(File);

impl StateLock {
    fn acquire(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
        let path = data_dir.join(LOCK_FILENAME);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)
            .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                data_dir.join(LOCK_FILENAME),
                fs::Permissions::from_mode(0o600),
            )
            .map_err(|error| error.to_string())?;
        }
        file.try_lock_exclusive()
            .map_err(|_| "another process guardian is already active".to_owned())?;
        Ok(Self(file))
    }
}

impl Drop for StateLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

struct GuardianWorker {
    data_dir: PathBuf,
    owner: ProcessOwner,
    leases: BTreeMap<String, ProcessLease>,
    _lock: StateLock,
    #[cfg(windows)]
    jobs: BTreeMap<String, WindowsJob>,
}

impl GuardianWorker {
    fn initialize(data_dir: PathBuf, owner: ProcessOwner) -> Result<Self, String> {
        let state_path = data_dir.join(STATE_FILENAME);
        let lock = StateLock::acquire(&data_dir)?;
        if let Some(previous) = load_state(&state_path)? {
            if owner_is_live(&previous.owner) && previous.owner != owner {
                return Err("the previous process guardian owner is still active".into());
            }
            for lease in previous.leases {
                recover_lease(&lease)?;
            }
        }
        let worker = Self {
            data_dir,
            owner,
            leases: BTreeMap::new(),
            _lock: lock,
            #[cfg(windows)]
            jobs: BTreeMap::new(),
        };
        worker.save()?;
        Ok(worker)
    }

    fn track(&mut self, mut lease: ProcessLease) -> Result<(), String> {
        lease.validate()?;
        if let Some(current) = self.leases.get(&lease.registration_id) {
            return if current == &lease {
                Ok(())
            } else {
                Err("registration id is already in use".into())
            };
        }
        validate_live_lease(&lease)?;
        lease.start_time = process_start_time(lease.pid);
        #[cfg(windows)]
        {
            let job = WindowsJob::new()?;
            job.assign(lease.pid)?;
            self.jobs.insert(lease.registration_id.clone(), job);
        }
        self.leases
            .insert(lease.registration_id.clone(), lease.clone());
        if let Err(error) = self.save() {
            self.leases.remove(&lease.registration_id);
            #[cfg(windows)]
            self.jobs.remove(&lease.registration_id);
            return Err(error);
        }
        Ok(())
    }

    fn release(&mut self, registration_id: &str) -> Result<(), String> {
        let Some(lease) = self.leases.get(registration_id).cloned() else {
            return Ok(());
        };
        #[cfg(unix)]
        terminate_posix_group(&lease, true)?;
        #[cfg(windows)]
        {
            if let Some(job) = self.jobs.get(registration_id) {
                job.terminate()?;
            } else {
                terminate_marked_windows_processes(&lease)?;
            }
            self.jobs.remove(registration_id);
        }
        self.leases.remove(registration_id);
        if let Err(error) = self.save() {
            self.leases.insert(registration_id.to_owned(), lease);
            return Err(error);
        }
        Ok(())
    }

    fn close(&mut self) -> Result<(), String> {
        let registrations: Vec<String> = self.leases.keys().cloned().collect();
        let mut errors = Vec::new();
        for registration in registrations {
            if let Err(error) = self.release(&registration) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            let path = self.data_dir.join(STATE_FILENAME);
            if path.exists() {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    fn save(&self) -> Result<(), String> {
        let state = GuardianState {
            version: PROTOCOL_VERSION,
            owner: self.owner.clone(),
            leases: self.leases.values().cloned().collect(),
        };
        save_state(&self.data_dir.join(STATE_FILENAME), &state)
    }
}

fn load_state(path: &Path) -> Result<Option<GuardianState>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_file() {
        return Err("guardian state must be a regular file".into());
    }
    let state: GuardianState =
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("invalid guardian state: {error}"))?;
    if state.version != PROTOCOL_VERSION {
        return Err("unsupported guardian state version".into());
    }
    Ok(Some(state))
}

fn save_state(path: &Path, state: &GuardianState) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid guardian state path".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".managed-processes-{}.tmp", Uuid::new_v4()));
    let mut encoded = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    encoded.push(b'\n');
    fs::write(&temporary, encoded).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn owner_is_live(owner: &ProcessOwner) -> bool {
    let Ok(current) = process_owner(owner.pid) else {
        return false;
    };
    if let Some(expected) = owner.start_time {
        return current.start_time == Some(expected);
    }
    owner.create_time.is_none_or(|expected| {
        current
            .start_time
            .is_some_and(|actual| (actual as f64 - expected).abs() <= 2.0)
    })
}

fn process_start_time(pid: u32) -> Option<u64> {
    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).map(sysinfo::Process::start_time)
}

#[cfg(unix)]
fn validate_live_lease(lease: &ProcessLease) -> Result<(), String> {
    let pgid = lease
        .pgid
        .ok_or_else(|| "missing process group".to_owned())?;
    if pgid != lease.pid || pgid > i32::MAX as u32 {
        return Err("managed process group identity is invalid".into());
    }
    let actual = unsafe { libc::getpgid(lease.pid as i32) };
    if actual != pgid as i32 {
        return Err("managed process is not the expected process-group leader".into());
    }
    Ok(())
}

#[cfg(windows)]
fn validate_live_lease(lease: &ProcessLease) -> Result<(), String> {
    let mut system = System::new();
    let pid = Pid::from_u32(lease.pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system
        .process(pid)
        .map(|_| ())
        .ok_or_else(|| "managed process identity was not found".into())
}

#[cfg(unix)]
fn recover_lease(lease: &ProcessLease) -> Result<(), String> {
    lease.validate()?;
    let pgid = lease
        .pgid
        .ok_or_else(|| "missing process group".to_owned())?;
    if !posix_group_exists(pgid) {
        return if marked_processes_exist(lease) {
            terminate_posix_group(lease, false)
        } else {
            Ok(())
        };
    }
    let mut system = System::new_all();
    system.refresh_all();
    let members: Vec<_> = system
        .processes()
        .values()
        .filter(|process| process.session_id().is_some_and(|id| id.as_u32() == pgid))
        .filter(|process| {
            !matches!(
                process.status(),
                ProcessStatus::Zombie | ProcessStatus::Dead
            )
        })
        .collect();
    if members.is_empty()
        || members
            .iter()
            .any(|process| !has_marker(process, &lease.registration_id))
    {
        return Err(format!(
            "stale process group {pgid} could not be safely authenticated"
        ));
    }
    terminate_posix_group(lease, false)
}

#[cfg(windows)]
fn recover_lease(lease: &ProcessLease) -> Result<(), String> {
    lease.validate()?;
    terminate_marked_windows_processes(lease)
}

fn has_marker(process: &sysinfo::Process, registration_id: &str) -> bool {
    let expected = format!("{MANAGED_PROCESS_ID_ENV}={registration_id}");
    process
        .environ()
        .iter()
        .any(|entry| entry == OsStr::new(&expected))
}

#[cfg(unix)]
fn terminate_posix_group(lease: &ProcessLease, trusted: bool) -> Result<(), String> {
    let pgid = lease
        .pgid
        .ok_or_else(|| "missing process group".to_owned())?;
    if !posix_group_exists(pgid) && !marked_processes_exist(lease) {
        return Ok(());
    }
    if posix_group_exists(pgid) {
        if !posix_group_is_safe(lease, trusted) {
            return Err(format!(
                "process group {pgid} could not be safely authenticated"
            ));
        }
        signal_posix_group(pgid, libc::SIGTERM)?;
    }
    signal_marked_processes(lease, libc::SIGTERM)?;
    if wait_for_posix_lease(lease, Duration::from_secs_f64(lease.stop_timeout), trusted) {
        return Ok(());
    }
    if posix_group_exists(pgid) {
        if !posix_group_is_safe(lease, trusted) {
            return Err(format!(
                "process group {pgid} changed identity before forced cleanup"
            ));
        }
        signal_posix_group(pgid, libc::SIGKILL)?;
    }
    signal_marked_processes(lease, libc::SIGKILL)?;
    if wait_for_posix_lease(
        lease,
        Duration::from_secs_f64(lease.stop_timeout.clamp(1.0, 5.0)),
        trusted,
    ) {
        Ok(())
    } else {
        Err(format!("process group {pgid} did not exit"))
    }
}

#[cfg(unix)]
fn signal_posix_group(pgid: u32, signal: i32) -> Result<(), String> {
    let result = unsafe { libc::kill(-(pgid as i32), signal) };
    if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(unix)]
fn wait_for_posix_lease(lease: &ProcessLease, timeout: Duration, trusted: bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let pgid = lease.pgid.unwrap_or_default();
        let group_done =
            !posix_group_exists(pgid) || (trusted && !posix_group_has_live_members(pgid));
        if group_done && !marked_processes_exist(lease) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
fn posix_group_exists(pgid: u32) -> bool {
    if pgid == 0 || pgid > i32::MAX as u32 {
        return false;
    }
    let result = unsafe { libc::kill(-(pgid as i32), 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
fn posix_group_has_live_members(pgid: u32) -> bool {
    let mut system = System::new_all();
    system.refresh_all();
    system.processes().values().any(|process| {
        process.session_id().is_some_and(|id| id.as_u32() == pgid)
            && !matches!(
                process.status(),
                ProcessStatus::Zombie | ProcessStatus::Dead
            )
    })
}

#[cfg(unix)]
fn posix_group_is_safe(lease: &ProcessLease, trusted: bool) -> bool {
    let Some(pgid) = lease.pgid else {
        return false;
    };
    let mut system = System::new_all();
    system.refresh_all();
    if let Some(root) = system.process(Pid::from_u32(lease.pid)) {
        let start_matches = lease
            .start_time
            .is_none_or(|expected| root.start_time() == expected);
        let create_matches = lease
            .create_time
            .is_none_or(|expected| (root.start_time() as f64 - expected).abs() <= 2.0);
        if !start_matches || !create_matches {
            return false;
        }
        let actual = unsafe { libc::getpgid(lease.pid as i32) };
        return actual == pgid as i32;
    }
    let members: Vec<_> = system
        .processes()
        .values()
        .filter(|process| process.session_id().is_some_and(|id| id.as_u32() == pgid))
        .filter(|process| {
            !matches!(
                process.status(),
                ProcessStatus::Zombie | ProcessStatus::Dead
            )
        })
        .collect();
    !members.is_empty()
        && (trusted
            || members
                .iter()
                .all(|process| has_marker(process, &lease.registration_id)))
}

#[cfg(unix)]
fn marked_processes_exist(lease: &ProcessLease) -> bool {
    let mut system = System::new_all();
    system.refresh_all();
    system.processes().values().any(|process| {
        !matches!(
            process.status(),
            ProcessStatus::Zombie | ProcessStatus::Dead
        ) && has_marker(process, &lease.registration_id)
    })
}

#[cfg(unix)]
fn signal_marked_processes(lease: &ProcessLease, signal: i32) -> Result<(), String> {
    let mut system = System::new_all();
    system.refresh_all();
    for process in system.processes().values() {
        if !matches!(
            process.status(),
            ProcessStatus::Zombie | ProcessStatus::Dead
        ) && has_marker(process, &lease.registration_id)
        {
            let pid = process.pid().as_u32();
            if pid > i32::MAX as u32 {
                continue;
            }
            let result = unsafe { libc::kill(pid as i32, signal) };
            if result != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn terminate_marked_windows_processes(lease: &ProcessLease) -> Result<(), String> {
    use sysinfo::Signal;
    let mut system = System::new_all();
    system.refresh_all();
    let mut matched = false;
    for process in system.processes().values() {
        if has_marker(process, &lease.registration_id) {
            matched = true;
            if process.kill_with(Signal::Kill) == Some(false) {
                return Err(format!(
                    "failed to terminate managed process {}",
                    process.pid()
                ));
            }
        }
    }
    if !matched && system.process(Pid::from_u32(lease.pid)).is_some() {
        return Err("managed Windows process could not be authenticated".into());
    }
    Ok(())
}

#[cfg(windows)]
struct WindowsJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl WindowsJob {
    fn new() -> Result<Self, String> {
        use std::{ffi::c_void, mem::size_of, ptr};
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&raw const information).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(Self { handle })
    }

    fn assign(&self, pid: u32) -> Result<(), String> {
        use windows_sys::Win32::System::{
            JobObjects::AssignProcessToJobObject,
            Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
                PROCESS_TERMINATE,
            },
        };
        let process = unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        if process.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let assigned = unsafe { AssignProcessToJobObject(self.handle, process) };
        unsafe { windows_sys::Win32::Foundation::CloseHandle(process) };
        if assigned == 0 {
            Err(format!(
                "Windows Job Object assignment failed for PID {pid}: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }

    fn terminate(&self) -> Result<(), String> {
        let result =
            unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1) };
        if result == 0 {
            Err(std::io::Error::last_os_error().to_string())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

pub fn run_from_args() -> Option<i32> {
    let arguments: Vec<_> = std::env::args_os().collect();
    if arguments.get(1).and_then(|value| value.to_str()) != Some("--process-guardian") {
        return None;
    }
    Some(
        match parse_worker_args(&arguments[2..]).and_then(run_worker) {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("process guardian failed: {error}");
                1
            }
        },
    )
}

fn parse_worker_args(arguments: &[std::ffi::OsString]) -> Result<(PathBuf, ProcessOwner), String> {
    let mut data_dir = None;
    let mut owner_pid = None;
    let mut owner_start_time = None;
    let mut index = 0;
    while index < arguments.len() {
        let flag = arguments[index]
            .to_str()
            .ok_or_else(|| "guardian arguments must be UTF-8".to_owned())?;
        let value = arguments
            .get(index + 1)
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag {
            "--data-dir" => data_dir = Some(PathBuf::from(value)),
            "--owner-pid" => {
                owner_pid = Some(
                    value
                        .to_str()
                        .and_then(|value| value.parse::<u32>().ok())
                        .filter(|value| *value > 0)
                        .ok_or_else(|| "invalid guardian owner PID".to_owned())?,
                )
            }
            "--owner-start-time" => {
                owner_start_time = Some(
                    value
                        .to_str()
                        .and_then(|value| value.parse::<u64>().ok())
                        .filter(|value| *value > 0)
                        .ok_or_else(|| "invalid guardian owner start time".to_owned())?,
                )
            }
            _ => return Err(format!("unknown guardian argument: {flag}")),
        }
        index += 2;
    }
    Ok((
        data_dir.ok_or_else(|| "missing guardian data directory".to_owned())?,
        ProcessOwner {
            pid: owner_pid.ok_or_else(|| "missing guardian owner PID".to_owned())?,
            start_time: Some(
                owner_start_time.ok_or_else(|| "missing guardian owner start time".to_owned())?,
            ),
            create_time: None,
        },
    ))
}

fn run_worker((data_dir, owner): (PathBuf, ProcessOwner)) -> Result<(), String> {
    let mut worker = match GuardianWorker::initialize(expand_home(data_dir), owner) {
        Ok(worker) => {
            write_worker_message(&json!({
                "type": "hello",
                "version": PROTOCOL_VERSION,
                "ok": true,
                "pid": std::process::id(),
            }))?;
            worker
        }
        Err(error) => {
            let _ = write_worker_message(&json!({
                "type": "hello",
                "version": PROTOCOL_VERSION,
                "ok": false,
                "error": error,
            }));
            return Err(error);
        }
    };
    let stdin = std::io::stdin();
    let mut input = StdBufReader::new(stdin.lock());
    loop {
        let mut line = Vec::new();
        let length = input
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?;
        if length == 0 {
            return worker.close();
        }
        if line.len() > MAX_MESSAGE_BYTES || !line.ends_with(b"\n") {
            return worker.close().and(Err("invalid guardian request".into()));
        }
        let request: Value = serde_json::from_slice(&line).map_err(|error| error.to_string())?;
        let id = request
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let result = match request.get("action").and_then(Value::as_str) {
            Some("track") => serde_json::from_value::<ProcessLease>(
                request.get("lease").cloned().unwrap_or(Value::Null),
            )
            .map_err(|error| error.to_string())
            .and_then(|lease| worker.track(lease)),
            Some("release") => request
                .get("registration_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "missing guardian registration id".to_owned())
                .and_then(|registration| worker.release(registration)),
            Some("shutdown") => {
                let result = worker.close();
                write_result(&id, &result)?;
                return result;
            }
            _ => Err("unsupported guardian action".into()),
        };
        write_result(&id, &result)?;
    }
}

fn write_result(id: &str, result: &Result<(), String>) -> Result<(), String> {
    match result {
        Ok(()) => write_worker_message(&json!({"id": id, "ok": true})),
        Err(error) => write_worker_message(&json!({"id": id, "ok": false, "error": error})),
    }
}

fn write_worker_message(payload: &Value) -> Result<(), String> {
    let mut encoded = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
    encoded.push(b'\n');
    if encoded.len() > MAX_MESSAGE_BYTES {
        return Err("guardian response is too large".into());
    }
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    output
        .write_all(&encoded)
        .and_then(|_| output.flush())
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
pub fn resume_windows_process(pid: u32) -> AppResult<()> {
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut found = false;
    let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while has_entry {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread.is_null() {
                let result = unsafe { ResumeThread(thread) };
                unsafe { CloseHandle(thread) };
                if result == u32::MAX {
                    unsafe { CloseHandle(snapshot) };
                    return Err(std::io::Error::last_os_error().into());
                }
                found = true;
            }
        }
        has_entry = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    if found {
        Ok(())
    } else {
        Err(AppError::Internal(format!(
            "suspended process {pid} had no resumable thread"
        )))
    }
}
