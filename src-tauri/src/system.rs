use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
    sync::LazyLock,
    thread,
    time::{Duration, Instant},
};

use netstat2::{AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState, get_sockets_info};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sysinfo::{
    Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System, Uid, UpdateKind, Users,
};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PortRow {
    pub protocol: String,
    pub local_address: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
    pub command: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProcessRow {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub create_time: Option<f64>,
    pub started_at: Option<String>,
    pub process_name: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub username: Option<String>,
    pub ports: Vec<u16>,
    pub suggested_name: Option<String>,
    pub safe_env: BTreeMap<String, String>,
    pub restorable: bool,
    pub warnings: Vec<String>,
    pub managed_service: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct ProcessMetrics {
    pub cpu_percent: f32,
    pub memory_rss: u64,
}

pub fn sample_metrics(pids: &[u32]) -> HashMap<u32, ProcessMetrics> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
    std::thread::sleep(Duration::from_millis(100));
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
    pids.iter()
        .copied()
        .filter(|pid| system.process(Pid::from_u32(*pid)).is_some())
        .map(|root| {
            let mut cpu_percent = 0.0;
            let mut memory_rss = 0;
            for (pid, process) in system.processes() {
                if pid.as_u32() == root || is_descendant(*pid, root, &system) {
                    cpu_percent += process.cpu_usage();
                    memory_rss += process.memory();
                }
            }
            (
                root,
                ProcessMetrics {
                    cpu_percent,
                    memory_rss,
                },
            )
        })
        .collect()
}

fn is_descendant(mut pid: Pid, root: u32, system: &System) -> bool {
    for _ in 0..128 {
        let Some(parent) = system.process(pid).and_then(sysinfo::Process::parent) else {
            return false;
        };
        if parent.as_u32() == root {
            return true;
        }
        if parent == pid {
            return false;
        }
        pid = parent;
    }
    false
}

type SocketRow = (String, String, u16, Vec<u32>);

fn socket_rows() -> AppResult<Vec<SocketRow>> {
    let families = AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6;
    let protocols = ProtocolFlags::TCP | ProtocolFlags::UDP;
    let sockets = match get_sockets_info(families, protocols) {
        Ok(sockets) => sockets,
        Err(error) => {
            #[cfg(target_os = "macos")]
            {
                return socket_rows_lsof().map_err(|fallback| {
                    AppError::conflict(format!(
                        "failed to inspect ports ({error}); lsof fallback failed: {fallback}"
                    ))
                });
            }
            #[cfg(not(target_os = "macos"))]
            {
                return Err(AppError::conflict(format!(
                    "failed to inspect ports: {error}"
                )));
            }
        }
    };
    Ok(sockets
        .into_iter()
        .filter_map(|socket| match socket.protocol_socket_info {
            ProtocolSocketInfo::Tcp(tcp) if tcp.state == TcpState::Listen => Some((
                "tcp".into(),
                tcp.local_addr.to_string(),
                tcp.local_port,
                socket.associated_pids,
            )),
            ProtocolSocketInfo::Udp(udp) => Some((
                "udp".into(),
                udp.local_addr.to_string(),
                udp.local_port,
                socket.associated_pids,
            )),
            _ => None,
        })
        .collect())
}

#[cfg(target_os = "macos")]
fn socket_rows_lsof() -> AppResult<Vec<SocketRow>> {
    let mut rows = run_lsof("tcp")?;
    if let Ok(udp) = run_lsof("udp") {
        rows.extend(udp);
    }
    rows.sort_by(|left, right| {
        (left.2, &left.0, &left.1, &left.3).cmp(&(right.2, &right.0, &right.1, &right.3))
    });
    rows.dedup();
    Ok(rows)
}

#[cfg(target_os = "macos")]
fn run_lsof(protocol: &str) -> AppResult<Vec<SocketRow>> {
    use std::process::{Command, Stdio};

    let mut command = Command::new("lsof");
    if protocol == "tcp" {
        command.args(["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-FpcLfnT"]);
    } else {
        command.args(["-nP", "-iUDP", "-FpcLfnT"]);
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::conflict(
                "timed out while inspecting ports with lsof",
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
    let output = child.wait_with_output()?;
    if !matches!(output.status.code(), Some(0 | 1)) {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(AppError::conflict(if detail.is_empty() {
            format!("lsof port inspection failed: {}", output.status)
        } else {
            format!("lsof port inspection failed: {detail}")
        }));
    }
    Ok(parse_lsof_socket_rows(
        &String::from_utf8_lossy(&output.stdout),
        protocol,
    ))
}

#[cfg(target_os = "macos")]
fn parse_lsof_socket_rows(output: &str, protocol: &str) -> Vec<SocketRow> {
    let mut current_pid = None;
    let mut rows = Vec::new();
    for line in output.lines() {
        let Some((field, value)) = line.split_at_checked(1) else {
            continue;
        };
        match field {
            "p" => current_pid = value.parse::<u32>().ok(),
            "n" => {
                let local = value.split("->").next().unwrap_or(value);
                let Some((address, raw_port)) = local.rsplit_once(':') else {
                    continue;
                };
                let Ok(port) = raw_port.parse::<u16>() else {
                    continue;
                };
                let address = address
                    .strip_prefix('[')
                    .and_then(|value| value.strip_suffix(']'))
                    .unwrap_or(address)
                    .to_owned();
                rows.push((
                    protocol.to_owned(),
                    address,
                    port,
                    current_pid.into_iter().collect(),
                ));
            }
            _ => {}
        }
    }
    rows
}

fn refreshed_system() -> System {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_user(UpdateKind::OnlyIfNotSet)
            .with_cwd(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_environ(UpdateKind::OnlyIfNotSet),
    );
    system
}

fn command_argv(process: &sysinfo::Process) -> Vec<String> {
    process
        .cmd()
        .iter()
        .map(|part| part.to_string_lossy().into_owned())
        .collect()
}

fn command_text(process: &sysinfo::Process) -> Option<String> {
    let (masked, _) = mask_sensitive_argv(&command_argv(process));
    (!masked.is_empty()).then(|| format_command(&masked))
}

pub fn list_ports(filter: Option<u16>) -> AppResult<Vec<PortRow>> {
    let system = refreshed_system();
    let users = Users::new_with_refreshed_list();
    let mut result = Vec::new();
    for (protocol, address, port, pids) in socket_rows()? {
        if filter.is_some_and(|value| value != port) {
            continue;
        }
        if pids.is_empty() {
            result.push(PortRow {
                protocol,
                local_address: address,
                port,
                pid: None,
                process_name: None,
                command: None,
                username: None,
            });
            continue;
        }
        for raw_pid in pids {
            let process = system.process(Pid::from_u32(raw_pid));
            result.push(PortRow {
                protocol: protocol.clone(),
                local_address: address.clone(),
                port,
                pid: Some(raw_pid),
                process_name: process.map(|value| value.name().to_string_lossy().into_owned()),
                command: process.and_then(command_text),
                username: process
                    .and_then(|value| value.user_id())
                    .and_then(|id| users.get_user_by_id(id))
                    .map(|user| user.name().to_owned()),
            });
        }
    }
    result.sort_by_key(|row| (row.port, row.protocol.clone(), row.pid));
    Ok(result)
}

fn pid_ports(system: &System) -> AppResult<HashMap<u32, Vec<u16>>> {
    let mut result: HashMap<u32, Vec<u16>> = HashMap::new();
    for (_, _, port, pids) in socket_rows()? {
        for pid in pids {
            let mut current = Some(Pid::from_u32(pid));
            for _ in 0..17 {
                let Some(process_pid) = current else {
                    break;
                };
                result.entry(process_pid.as_u32()).or_default().push(port);
                current = system
                    .process(process_pid)
                    .and_then(sysinfo::Process::parent)
                    .filter(|parent| parent.as_u32() > 1 && *parent != process_pid);
            }
        }
    }
    for ports in result.values_mut() {
        ports.sort_unstable();
        ports.dedup();
    }
    Ok(result)
}

const SAFE_ENV_KEYS: &[&str] = &[
    "HOST",
    "NODE_ENV",
    "PORT",
    "PYTHONPATH",
    "PYTHONUNBUFFERED",
    "UV_PROJECT",
    "UV_PYTHON",
    "VIRTUAL_ENV",
];

const SHELL_NAMES: &[&str] = &[
    "bash",
    "cmd",
    "cmd.exe",
    "dash",
    "fish",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
    "sh",
    "tcsh",
    "zsh",
];

static SENSITIVE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|[_-])(?:api[_-]?key|access[_-]?key|private[_-]?key|password|passwd|secret|token|credentials?|authorization)(?:$|[_-])",
    )
    .expect("sensitive-key regex must compile")
});
static AUTHORIZATION_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(?:proxy-)?authorization\s*:")
        .expect("authorization-header regex must compile")
});

#[derive(Clone, Copy, PartialEq, Eq)]
enum Ownership {
    Current,
    Other,
    Unknown,
}

struct InspectedProcess {
    row: ProcessRow,
    protected: bool,
    shell: bool,
    ownership: Ownership,
}

pub fn list_processes(
    query: Option<&str>,
    limit: usize,
    managed: &HashMap<u32, String>,
) -> AppResult<Vec<ProcessRow>> {
    let system = refreshed_system();
    let users = Users::new_with_refreshed_list();
    let (ports, port_warning) = match pid_ports(&system) {
        Ok(ports) => (ports, None),
        Err(error) => (
            HashMap::new(),
            Some(format!("Listening ports could not be inspected: {error}")),
        ),
    };
    let protected = controller_ancestry(&system);
    let controller = system.process(Pid::from_u32(std::process::id()));
    let current_user_id = controller.and_then(sysinfo::Process::user_id).cloned();
    let current_username = controller.and_then(|process| username(process, &users));
    let query = query.unwrap_or_default().trim().to_lowercase();
    let mut rows = Vec::new();
    let mut identities = HashSet::new();
    for pid in system.processes().keys().copied() {
        let raw_pid = pid.as_u32();
        if raw_pid <= 1 {
            continue;
        }
        let Ok(inspected) = inspect_process(
            pid,
            &system,
            &users,
            &ports,
            managed,
            &protected,
            current_user_id.as_ref(),
            current_username.as_deref(),
            port_warning.as_deref(),
        ) else {
            continue;
        };
        if inspected.protected
            || inspected.shell
            || inspected.ownership == Ownership::Other
            || inspected.row.managed_service.is_some()
        {
            continue;
        }
        let row = inspected.row;
        let search = format!(
            "{} {} {} {} {} {}",
            row.pid,
            row.process_name.as_deref().unwrap_or_default(),
            row.command.as_deref().unwrap_or_default(),
            row.cwd.as_deref().unwrap_or_default(),
            row.username.as_deref().unwrap_or_default(),
            row.suggested_name.as_deref().unwrap_or_default(),
        )
        .to_lowercase();
        if !query.is_empty() && !search.contains(&query) {
            continue;
        }
        let identity = (row.pid, row.create_time.map(f64::to_bits));
        if identities.insert(identity) {
            rows.push(row);
        }
    }
    rows.sort_by(|left, right| {
        left.suggested_name
            .cmp(&right.suggested_name)
            .then(left.pid.cmp(&right.pid))
    });
    rows.truncate(limit);
    Ok(rows)
}

pub fn get_process(pid: u32, managed: &HashMap<u32, String>) -> AppResult<ProcessRow> {
    if pid <= 1 {
        return Err(AppError::bad_request("pid must be greater than 1"));
    }
    let system = refreshed_system();
    let users = Users::new_with_refreshed_list();
    let (ports, port_warning) = match pid_ports(&system) {
        Ok(ports) => (ports, None),
        Err(error) => (
            HashMap::new(),
            Some(format!("Listening ports could not be inspected: {error}")),
        ),
    };
    let protected = controller_ancestry(&system);
    let controller = system.process(Pid::from_u32(std::process::id()));
    let current_user_id = controller.and_then(sysinfo::Process::user_id).cloned();
    let current_username = controller.and_then(|process| username(process, &users));
    let inspected = inspect_process(
        Pid::from_u32(pid),
        &system,
        &users,
        &ports,
        managed,
        &protected,
        current_user_id.as_ref(),
        current_username.as_deref(),
        port_warning.as_deref(),
    )?;
    if let Some(start_time) = inspected.row.create_time {
        verify_process_identity(inspected.row.pid, start_time as u64)?;
    }
    Ok(inspected.row)
}

#[allow(clippy::too_many_arguments)]
fn inspect_process(
    selected_pid: Pid,
    system: &System,
    users: &Users,
    ports: &HashMap<u32, Vec<u16>>,
    managed: &HashMap<u32, String>,
    protected: &HashSet<u32>,
    current_user_id: Option<&Uid>,
    current_username: Option<&str>,
    port_warning: Option<&str>,
) -> AppResult<InspectedProcess> {
    let selected = system.process(selected_pid).ok_or_else(|| {
        AppError::bad_request(format!("process {} does not exist", selected_pid.as_u32()))
    })?;
    if protected.contains(&selected_pid.as_u32()) {
        return Err(AppError::bad_request(format!(
            "process {} belongs to Service Console and cannot be imported",
            selected_pid.as_u32()
        )));
    }
    let selected_ownership = process_ownership(selected, users, current_user_id, current_username);
    if selected_ownership != Ownership::Current {
        return Ok(InspectedProcess {
            row: restricted_row(
                selected,
                system,
                users,
                ports,
                managed,
                selected_ownership,
                port_warning,
            ),
            protected: false,
            shell: false,
            ownership: selected_ownership,
        });
    }

    let launcher_pid = resolve_launcher(
        selected_pid,
        system,
        users,
        protected,
        managed,
        current_user_id,
        current_username,
    );
    let launcher = system
        .process(launcher_pid)
        .ok_or_else(|| AppError::bad_request("process disappeared while it was being inspected"))?;
    let ownership = process_ownership(launcher, users, current_user_id, current_username);
    if ownership != Ownership::Current {
        return Ok(InspectedProcess {
            row: restricted_row(
                launcher,
                system,
                users,
                ports,
                managed,
                ownership,
                port_warning,
            ),
            protected: false,
            shell: false,
            ownership,
        });
    }

    let argv = command_argv(launcher);
    let (masked_argv, redacted) = mask_sensitive_argv(&argv);
    let command = (!masked_argv.is_empty()).then(|| format_command(&masked_argv));
    let cwd = launcher
        .cwd()
        .map(|value| value.to_string_lossy().into_owned());
    let name = launcher.name().to_string_lossy().into_owned();
    let username = username(launcher, users);
    let managed_service = managed_service(launcher_pid, system, managed);
    let is_protected = protected.contains(&launcher_pid.as_u32());
    let shell = is_shell(&name, &argv);
    let mut warnings = Vec::new();
    if selected_pid != launcher_pid {
        warnings.push(format!(
            "Command restored from same-process-group launcher PID {}; review it before saving.",
            launcher_pid.as_u32()
        ));
    }
    if let Some(service) = managed_service.as_deref() {
        warnings.push(format!("Already managed by service {service}."));
    }
    if is_protected {
        warnings.push("Service Console and its launcher processes cannot be imported.".into());
    }
    if shell {
        warnings.push("Interactive shell processes cannot be imported directly.".into());
    }
    if redacted {
        warnings.push(
            "Sensitive command arguments were redacted; enter them manually before saving.".into(),
        );
    }
    if command.is_none() {
        warnings.push("Command line is unavailable; enter a command manually.".into());
    }
    if cwd.is_none() {
        warnings.push("Working directory is unavailable; select one manually.".into());
    } else if !cwd
        .as_deref()
        .is_some_and(|value| Path::new(value).is_dir())
    {
        warnings.push("Working directory no longer exists.".into());
    }
    if username.is_none() {
        warnings.push("Process username could not be inspected.".into());
    }
    if let Some(warning) = port_warning {
        warnings.push(warning.to_owned());
    }
    warnings.dedup();

    let restorable = command.is_some()
        && cwd
            .as_deref()
            .is_some_and(|value| Path::new(value).is_dir())
        && managed_service.is_none()
        && !is_protected
        && !shell
        && !redacted;
    let start_time = launcher.start_time();
    Ok(InspectedProcess {
        row: ProcessRow {
            pid: launcher_pid.as_u32(),
            ppid: launcher.parent().map(Pid::as_u32),
            create_time: Some(start_time as f64),
            started_at: chrono::DateTime::from_timestamp(start_time as i64, 0)
                .map(|value| value.to_rfc3339()),
            process_name: Some(name.clone()),
            command,
            cwd,
            username,
            ports: ports
                .get(&launcher_pid.as_u32())
                .cloned()
                .unwrap_or_default(),
            suggested_name: Some(suggested_name(
                launcher.cwd(),
                &argv,
                &name,
                launcher_pid.as_u32(),
            )),
            safe_env: safe_environment(launcher),
            restorable,
            warnings,
            managed_service,
        },
        protected: is_protected,
        shell,
        ownership,
    })
}

fn restricted_row(
    process: &sysinfo::Process,
    system: &System,
    users: &Users,
    ports: &HashMap<u32, Vec<u16>>,
    managed: &HashMap<u32, String>,
    ownership: Ownership,
    port_warning: Option<&str>,
) -> ProcessRow {
    let pid = process.pid();
    let name = process.name().to_string_lossy().into_owned();
    let managed_service =
        managed_service(pid, system, managed).or_else(|| managed.get(&pid.as_u32()).cloned());
    let mut warnings = vec![match ownership {
        Ownership::Other => "Process metadata access is limited because it is owned by another user; enter the command and working directory manually.".into(),
        Ownership::Unknown => "Process ownership and metadata access could not be verified; enter the command and working directory manually.".into(),
        Ownership::Current => "Process metadata access is limited; enter the command and working directory manually.".into(),
    }];
    if let Some(service) = managed_service.as_deref() {
        warnings.push(format!("Already managed by service {service}."));
    }
    if let Some(warning) = port_warning {
        warnings.push(warning.to_owned());
    }
    let start_time = process.start_time();
    ProcessRow {
        pid: pid.as_u32(),
        ppid: process.parent().map(Pid::as_u32),
        create_time: Some(start_time as f64),
        started_at: chrono::DateTime::from_timestamp(start_time as i64, 0)
            .map(|value| value.to_rfc3339()),
        process_name: Some(name.clone()),
        command: Some(String::new()),
        cwd: Some(String::new()),
        username: username(process, users),
        ports: ports.get(&pid.as_u32()).cloned().unwrap_or_default(),
        suggested_name: Some(suggested_name(None, &[], &name, pid.as_u32())),
        safe_env: BTreeMap::new(),
        restorable: false,
        warnings,
        managed_service,
    }
}

fn controller_ancestry(system: &System) -> HashSet<u32> {
    let mut result = HashSet::new();
    let mut current = Some(Pid::from_u32(std::process::id()));
    for _ in 0..17 {
        let Some(pid) = current else {
            break;
        };
        result.insert(pid.as_u32());
        current = system
            .process(pid)
            .and_then(sysinfo::Process::parent)
            .filter(|parent| parent.as_u32() > 1 && *parent != pid);
    }
    result
}

fn process_ownership(
    process: &sysinfo::Process,
    users: &Users,
    current_user_id: Option<&Uid>,
    current_username: Option<&str>,
) -> Ownership {
    if let (Some(candidate), Some(current)) = (process.user_id(), current_user_id) {
        return if candidate == current {
            Ownership::Current
        } else {
            Ownership::Other
        };
    }
    match (username(process, users), current_username) {
        (Some(candidate), Some(current)) if same_username(&candidate, current) => {
            Ownership::Current
        }
        (Some(_), Some(_)) => Ownership::Other,
        _ => Ownership::Unknown,
    }
}

fn username(process: &sysinfo::Process, users: &Users) -> Option<String> {
    process
        .user_id()
        .and_then(|id| users.get_user_by_id(id))
        .map(|user| user.name().to_owned())
}

#[cfg(not(windows))]
fn same_username(candidate: &str, current: &str) -> bool {
    candidate == current
}

#[cfg(windows)]
fn same_username(candidate: &str, current: &str) -> bool {
    let normalize = |value: &str| value.trim().replace('/', "\\").to_lowercase();
    let candidate = normalize(candidate);
    let current = normalize(current);
    if candidate == current {
        return true;
    }
    let candidate_domain = candidate.contains('\\');
    let current_domain = current.contains('\\');
    if candidate_domain && current_domain {
        return false;
    }
    candidate.rsplit('\\').next() == current.rsplit('\\').next()
}

#[allow(clippy::too_many_arguments)]
fn resolve_launcher(
    selected: Pid,
    system: &System,
    users: &Users,
    protected: &HashSet<u32>,
    managed: &HashMap<u32, String>,
    current_user_id: Option<&Uid>,
    current_username: Option<&str>,
) -> Pid {
    let Some(selected_group) = process_group(selected.as_u32()) else {
        return selected;
    };
    let mut candidate = selected;
    let mut current = selected;
    for _ in 0..16 {
        let Some(parent) = system.process(current).and_then(sysinfo::Process::parent) else {
            break;
        };
        if parent.as_u32() <= 1
            || protected.contains(&parent.as_u32())
            || managed.contains_key(&parent.as_u32())
            || process_group(parent.as_u32()) != Some(selected_group)
        {
            break;
        }
        let Some(parent_process) = system.process(parent) else {
            break;
        };
        if process_ownership(parent_process, users, current_user_id, current_username)
            != Ownership::Current
        {
            break;
        }
        let argv = command_argv(parent_process);
        let name = parent_process.name().to_string_lossy();
        if is_shell(&name, &argv) {
            break;
        }
        if is_launcher(&name, &argv) {
            candidate = parent;
        }
        current = parent;
    }
    candidate
}

#[cfg(unix)]
fn process_group(pid: u32) -> Option<u32> {
    let group = unsafe { libc::getpgid(pid as i32) };
    (group >= 0).then_some(group as u32)
}

#[cfg(not(unix))]
fn process_group(_pid: u32) -> Option<u32> {
    None
}

fn managed_service(pid: Pid, system: &System, managed: &HashMap<u32, String>) -> Option<String> {
    if let Some(service) = managed.get(&pid.as_u32()) {
        return Some(service.clone());
    }
    if let Some(service) = process_group(pid.as_u32()).and_then(|group| managed.get(&group)) {
        return Some(service.clone());
    }
    let mut current = pid;
    for _ in 0..16 {
        let parent = system.process(current).and_then(sysinfo::Process::parent)?;
        if parent.as_u32() <= 1 || parent == current {
            return None;
        }
        if let Some(service) = managed.get(&parent.as_u32()) {
            return Some(service.clone());
        }
        current = parent;
    }
    None
}

fn shell_name(process_name: &str, argv: &[String]) -> String {
    let executable = argv
        .first()
        .and_then(|value| Path::new(value).file_name())
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if SHELL_NAMES.contains(&executable.as_str()) {
        executable
    } else {
        process_name.to_lowercase()
    }
}

fn is_shell(process_name: &str, argv: &[String]) -> bool {
    SHELL_NAMES.contains(&shell_name(process_name, argv).as_str())
        && !is_scripted_shell(process_name, argv)
}

fn is_scripted_shell(process_name: &str, argv: &[String]) -> bool {
    if !SHELL_NAMES.contains(&shell_name(process_name, argv).as_str()) || argv.len() < 2 {
        return false;
    }
    let mut index = 1;
    while index < argv.len() {
        let argument = &argv[index];
        if argument == "--" || matches!(argument.as_str(), "-c" | "--command") {
            return index + 1 < argv.len();
        }
        if argument.starts_with('-') && !argument.starts_with("--") && argument[1..].contains('c') {
            return index + 1 < argv.len();
        }
        if matches!(argument.as_str(), "-o" | "-O" | "--init-file" | "--rcfile") {
            index += 2;
            continue;
        }
        if !argument.starts_with('-') {
            return true;
        }
        index += 1;
    }
    false
}

fn is_launcher(process_name: &str, argv: &[String]) -> bool {
    if argv.is_empty() {
        return false;
    }
    if is_scripted_shell(process_name, argv) {
        return true;
    }
    let executable = Path::new(&argv[0])
        .file_name()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let head = argv
        .iter()
        .take(2)
        .cloned()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    executable == "uv"
        || matches!(executable.as_str(), "pnpm" | "pnpm.cjs")
        || head.contains("pnpm.cjs")
}

fn safe_environment(process: &sysinfo::Process) -> BTreeMap<String, String> {
    collect_safe_environment(
        process
            .environ()
            .iter()
            .map(|entry| entry.to_string_lossy()),
    )
}

fn collect_safe_environment<I, S>(entries: I) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    entries
        .into_iter()
        .filter_map(|entry| {
            let entry = entry.as_ref();
            let (key, value) = entry.split_once('=')?;
            SAFE_ENV_KEYS
                .contains(&key)
                .then(|| (key.to_owned(), value.to_owned()))
        })
        .collect()
}

fn mask_sensitive_argv(argv: &[String]) -> (Vec<String>, bool) {
    let mut masked = Vec::with_capacity(argv.len());
    let mut redacted = false;
    let mut index = 0;
    while index < argv.len() {
        let argument = &argv[index];
        if AUTHORIZATION_HEADER.is_match(argument) {
            let key = argument
                .split_once(':')
                .map_or(argument.as_str(), |item| item.0);
            masked.push(format!("{key}: REDACTED"));
            redacted = true;
            index += 1;
            continue;
        }
        if let Some((key, value)) = argument.split_once('=') {
            if is_sensitive_key(key) {
                masked.push(format!("{key}=REDACTED"));
                redacted = true;
                index += 1;
                continue;
            }
            if AUTHORIZATION_HEADER.is_match(value) {
                let header = value.split_once(':').map_or(value, |item| item.0);
                masked.push(format!("{key}={header}: REDACTED"));
                redacted = true;
                index += 1;
                continue;
            }
        }
        if argument.starts_with('-') && is_sensitive_key(argument) {
            masked.push(argument.clone());
            redacted = true;
            if index + 1 < argv.len() {
                masked.push("REDACTED".into());
                index += 2;
                continue;
            }
        } else {
            masked.push(argument.clone());
        }
        index += 1;
    }
    (masked, redacted)
}

fn is_sensitive_key(value: &str) -> bool {
    SENSITIVE_KEY.is_match(value.trim_start_matches('-'))
}

fn format_command(argv: &[String]) -> String {
    #[cfg(windows)]
    {
        argv.iter()
            .map(|value| quote_windows_argument(value))
            .collect::<Vec<_>>()
            .join(" ")
    }
    #[cfg(not(windows))]
    {
        argv.iter()
            .map(|value| {
                shlex::try_quote(value)
                    .map(|quoted| quoted.into_owned())
                    .unwrap_or_else(|_| "REDACTED".into())
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[cfg(windows)]
fn quote_windows_argument(value: &str) -> String {
    if !value.is_empty()
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return value.to_owned();
    }
    let mut result = String::from("\"");
    let mut backslashes = 0;
    for character in value.chars() {
        if character == '\\' {
            backslashes += 1;
        } else if character == '"' {
            result.push_str(&"\\".repeat(backslashes * 2 + 1));
            result.push('"');
            backslashes = 0;
        } else {
            result.push_str(&"\\".repeat(backslashes));
            backslashes = 0;
            result.push(character);
        }
    }
    result.push_str(&"\\".repeat(backslashes * 2));
    result.push('"');
    result
}

fn suggested_name(cwd: Option<&Path>, argv: &[String], process_name: &str, pid: u32) -> String {
    let project = cwd
        .and_then(Path::file_name)
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| process_name.to_owned());
    let command = argv.join(" ").to_lowercase();
    let role = if command.contains("celery") && command.contains("worker") {
        "celery-worker"
    } else if command.contains("celery") && command.contains("beat") {
        "celery-beat"
    } else if argv
        .iter()
        .any(|value| value.replace('\\', "/").ends_with("backend/run.py"))
    {
        "backend"
    } else if is_pnpm_argv(argv) {
        "frontend"
    } else {
        ""
    };
    let base = slug(&project);
    let base = if base.is_empty() {
        format!("service-{pid}")
    } else {
        base
    };
    if !role.is_empty() && !base.contains(role) {
        format!("{base}-{role}")
    } else {
        base
    }
}

fn is_pnpm_argv(argv: &[String]) -> bool {
    let Some(first) = argv.first() else {
        return false;
    };
    let executable = Path::new(first)
        .file_name()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    matches!(executable.as_str(), "pnpm" | "pnpm.cjs")
        || argv
            .iter()
            .take(2)
            .any(|value| value.to_lowercase().contains("pnpm.cjs"))
}

fn slug(value: &str) -> String {
    let mut result = String::new();
    for character in value.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            result.push(character);
        } else if !result.ends_with('-') {
            result.push('-');
        }
    }
    result.trim_matches('-').to_owned()
}

fn verify_process_identity(pid: u32, expected_start_time: u64) -> AppResult<()> {
    let current = process_start_time(pid)?;
    if current != expected_start_time {
        return Err(AppError::bad_request(format!(
            "process {pid} changed identity while it was being inspected"
        )));
    }
    Ok(())
}

fn process_start_time(pid: u32) -> AppResult<u64> {
    let mut system = System::new();
    let process_pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[process_pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    system
        .process(process_pid)
        .map(sysinfo::Process::start_time)
        .ok_or_else(|| AppError::bad_request(format!("process {pid} does not exist")))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminateResult {
    pub pid: u32,
    pub expected_port: Option<u16>,
    pub action: String,
    pub force: bool,
    pub terminated: bool,
    pub exit_code: Option<i32>,
}

pub fn terminate_process(
    pid: u32,
    expected_port: Option<u16>,
    force: bool,
    timeout: f64,
) -> AppResult<TerminateResult> {
    if pid <= 1 || pid == std::process::id() {
        return Err(AppError::bad_request(
            "refusing to terminate a protected process",
        ));
    }
    if !timeout.is_finite() || timeout <= 0.0 {
        return Err(AppError::bad_request(
            "timeout must be a finite positive number",
        ));
    }
    let created_at = process_start_time(pid)?;
    if let Some(port) = expected_port {
        let owns_port = list_ports(Some(port))?
            .iter()
            .any(|row| row.pid == Some(pid));
        if !owns_port {
            return Err(AppError::bad_request(format!(
                "process {pid} no longer owns port {port}"
            )));
        }
    }
    verify_process_identity(pid, created_at)?;
    signal_process(pid, force)?;
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    while process_matches_identity(pid, created_at) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    if process_matches_identity(pid, created_at) {
        let hint = if force {
            ""
        } else {
            "; retry with force=true to send a kill signal"
        };
        return Err(AppError::conflict(format!(
            "process {pid} did not exit within {timeout} seconds after {}{hint}",
            if force { "kill" } else { "terminate" }
        )));
    }
    Ok(TerminateResult {
        pid,
        expected_port,
        action: if force {
            "kill".into()
        } else {
            "terminate".into()
        },
        force,
        terminated: true,
        exit_code: None,
    })
}

#[cfg(unix)]
fn signal_process(pid: u32, force: bool) -> AppResult<()> {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    if unsafe { libc::kill(pid as i32, signal) } == 0 {
        Ok(())
    } else {
        Err(AppError::conflict(format!(
            "failed to signal process {pid}: {}",
            std::io::Error::last_os_error()
        )))
    }
}

#[cfg(windows)]
fn signal_process(pid: u32, force: bool) -> AppResult<()> {
    let mut command = std::process::Command::new("taskkill");
    command.args(["/PID", &pid.to_string()]);
    if force {
        command.arg("/F");
    }
    if command.status()?.success() {
        Ok(())
    } else {
        Err(AppError::conflict(format!("taskkill failed for PID {pid}")))
    }
}

fn process_matches_identity(pid: u32, expected_start_time: u64) -> bool {
    let mut system = System::new();
    let process_pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[process_pid]), true);
    system.process(process_pid).is_some_and(|process| {
        process.start_time() == expected_start_time
            && !matches!(
                process.status(),
                ProcessStatus::Zombie | ProcessStatus::Dead
            )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_sensitive_command_arguments_without_changing_safe_values() {
        let argv = vec![
            "client".into(),
            "--token".into(),
            "secret-value".into(),
            "PASSWORD=hunter2".into(),
            "--header".into(),
            "Authorization: Bearer abc".into(),
            "--port=8080".into(),
        ];
        let (masked, redacted) = mask_sensitive_argv(&argv);
        assert!(redacted);
        assert_eq!(
            masked,
            vec![
                "client",
                "--token",
                "REDACTED",
                "PASSWORD=REDACTED",
                "--header",
                "Authorization: REDACTED",
                "--port=8080"
            ]
        );
    }

    #[test]
    fn recognizes_scripted_shells_but_rejects_interactive_shells() {
        assert!(is_scripted_shell(
            "zsh",
            &["/bin/zsh".into(), "-lc".into(), "pnpm dev".into()]
        ));
        assert!(is_launcher(
            "zsh",
            &["/bin/zsh".into(), "-lc".into(), "pnpm dev".into()]
        ));
        assert!(!is_shell(
            "zsh",
            &["/bin/zsh".into(), "-lc".into(), "pnpm dev".into()]
        ));
        assert!(is_shell("zsh", &["/bin/zsh".into(), "-l".into()]));
    }

    #[test]
    fn derives_project_role_names() {
        assert_eq!(
            suggested_name(
                Some(Path::new("/workspace/My App")),
                &["uv".into(), "run".into(), "backend/run.py".into()],
                "python",
                123
            ),
            "my-app-backend"
        );
        assert_eq!(
            suggested_name(
                Some(Path::new("/workspace/My App")),
                &["pnpm".into(), "dev".into()],
                "node",
                123
            ),
            "my-app-frontend"
        );
    }

    #[test]
    fn safe_environment_uses_an_explicit_allowlist() {
        let environment = collect_safe_environment([
            "PORT=43210",
            "NODE_ENV=development",
            "TOKEN=must-not-leak",
            "DATABASE_URL=must-not-leak",
        ]);
        assert_eq!(environment.get("PORT").map(String::as_str), Some("43210"));
        assert_eq!(
            environment.get("NODE_ENV").map(String::as_str),
            Some("development")
        );
        assert!(!environment.contains_key("TOKEN"));
        assert!(!environment.contains_key("DATABASE_URL"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_lsof_ipv4_and_ipv6_endpoints() {
        let rows = parse_lsof_socket_rows(
            "p12\ncnode\nn127.0.0.1:8080\nTST=LISTEN\np13\nn[::1]:9000\n",
            "tcp",
        );
        assert_eq!(
            rows,
            vec![
                ("tcp".into(), "127.0.0.1".into(), 8080, vec![12]),
                ("tcp".into(), "::1".into(), 9000, vec![13])
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn live_process_import_preserves_only_safe_environment_and_can_be_terminated() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("/bin/sh")
            .args(["-c", "while :; do :; done"])
            .env("PORT", "43210")
            .env("TOKEN", "must-not-leak")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        thread::sleep(Duration::from_millis(100));
        let pid = child.id();

        let row = get_process(pid, &HashMap::new()).unwrap();
        assert_eq!(row.pid, pid);
        assert!(!row.safe_env.contains_key("TOKEN"));
        assert!(row.restorable);

        let result = terminate_process(pid, None, true, 2.0).unwrap();
        assert!(result.terminated);
        child.wait().unwrap();
    }
}
