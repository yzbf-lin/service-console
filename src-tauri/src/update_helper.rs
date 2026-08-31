use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::io::Read;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
use sysinfo::{Pid, ProcessesToUpdate, System};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

pub const UPDATE_READY_FILE_ENV: &str = "SERVICE_CONSOLE_UPDATE_READY_FILE";
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_RESTART_ARGUMENTS_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone)]
pub struct InstalledApplication {
    pub root: PathBuf,
    pub executable: PathBuf,
    pub launch_relative: PathBuf,
}

#[derive(Debug, Clone)]
pub struct PreparedUpdate {
    pub root: PathBuf,
    pub executable: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ApplyUpdate {
    pub process_id: u32,
    pub process_start_time: u64,
    pub source: PathBuf,
    pub target: PathBuf,
    pub launch_relative: PathBuf,
    pub ready_file: PathBuf,
    pub started_file: PathBuf,
    pub log_file: PathBuf,
    pub restart_arguments: Vec<String>,
    pub ready_timeout: Duration,
}

pub fn installed_application() -> AppResult<InstalledApplication> {
    let executable = std::env::current_exe()?;
    #[cfg(target_os = "macos")]
    {
        let root = executable
            .ancestors()
            .find(|path| path.extension().is_some_and(|extension| extension == "app"))
            .ok_or_else(|| {
                AppError::conflict(
                    "Development builds can check and download updates but cannot replace an app bundle",
                )
            })?
            .to_path_buf();
        let launch_relative = executable
            .strip_prefix(&root)
            .map_err(|_| AppError::Internal("desktop executable is outside its app bundle".into()))?
            .to_path_buf();
        return Ok(InstalledApplication {
            root,
            executable,
            launch_relative,
        });
    }
    #[cfg(target_os = "windows")]
    {
        if cfg!(debug_assertions) {
            return Err(AppError::conflict(
                "Development builds can check and download updates but cannot replace an installation",
            ));
        }
        let root = executable
            .parent()
            .ok_or_else(|| AppError::Internal("desktop executable has no parent directory".into()))?
            .to_path_buf();
        let launch_relative = executable
            .file_name()
            .map(PathBuf::from)
            .ok_or_else(|| AppError::Internal("desktop executable has no filename".into()))?;
        return Ok(InstalledApplication {
            root,
            executable,
            launch_relative,
        });
    }
    #[allow(unreachable_code)]
    Err(AppError::conflict(
        "Automatic installation is not supported on this platform",
    ))
}

pub fn prepare_archive(
    archive: &Path,
    destination: &Path,
    platform: &str,
    installed: &InstalledApplication,
    version: &str,
) -> AppResult<PreparedUpdate> {
    validate_archive(archive)?;
    if destination.exists() {
        remove_tree_retry(destination)?;
    }
    fs::create_dir_all(destination)?;
    extract_archive(archive, destination)?;

    let prepared = match platform {
        "darwin-arm64" | "darwin-x86_64" => {
            let mut bundles = Vec::new();
            collect_named_directories(destination, "Service Console.app", &mut bundles)?;
            if bundles.len() != 1 {
                return Err(AppError::conflict(
                    "The macOS update must contain exactly one Service Console.app",
                ));
            }
            let root = bundles.remove(0);
            let executable = root.join(&installed.launch_relative);
            PreparedUpdate { root, executable }
        }
        "windows-x86_64" => {
            let filename = installed
                .launch_relative
                .file_name()
                .ok_or_else(|| AppError::Internal("installed executable has no filename".into()))?;
            let mut executables = Vec::new();
            collect_named_files(destination, filename, &mut executables)?;
            if executables.len() != 1 {
                return Err(AppError::conflict(
                    "The Windows update must contain exactly one desktop executable",
                ));
            }
            let executable = executables.remove(0);
            let root = executable
                .parent()
                .ok_or_else(|| AppError::Internal("prepared executable has no parent".into()))?
                .to_path_buf();
            PreparedUpdate { root, executable }
        }
        _ => {
            return Err(AppError::conflict(
                "Automatic installation is not supported on this platform",
            ));
        }
    };
    if !prepared.executable.is_file() {
        return Err(AppError::conflict(
            "The prepared update does not contain the desktop executable",
        ));
    }
    verify_prepared_update(&prepared, platform, version)?;
    Ok(prepared)
}

pub async fn launch_helper(
    prepared: &PreparedUpdate,
    installed: &InstalledApplication,
    working_dir: &Path,
) -> AppResult<()> {
    fs::create_dir_all(working_dir)?;
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let helper = working_dir.join(format!("service-console-update-helper{extension}"));
    fs::copy(std::env::current_exe()?, &helper)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&helper)?.permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&helper, permissions)?;
    }
    let ready_file = working_dir.join("install-update.ready");
    let started_file = working_dir.join("install-update.started");
    let log_file = working_dir.join("install-update.log");
    let _ = fs::remove_file(&ready_file);
    let _ = fs::remove_file(&started_file);
    let process_start_time = process_start_time(std::process::id()).ok_or_else(|| {
        AppError::Internal("desktop process start time could not be determined".into())
    })?;
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let restart_arguments = encode_restart_arguments(&arguments)?;
    let output = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)?;
    let mut command = Command::new(helper);
    command
        .arg("--update-helper")
        .arg("--process-id")
        .arg(std::process::id().to_string())
        .arg("--process-start-time")
        .arg(process_start_time.to_string())
        .arg("--source")
        .arg(&prepared.root)
        .arg("--target")
        .arg(&installed.root)
        .arg("--launch-relative")
        .arg(&installed.launch_relative)
        .arg("--ready-file")
        .arg(&ready_file)
        .arg("--started-file")
        .arg(&started_file)
        .arg("--log-file")
        .arg(&log_file)
        .arg("--restart-arguments")
        .arg(restart_arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::from(output.try_clone()?))
        .stderr(Stdio::from(output));
    configure_detached(&mut command);
    let mut child = command.spawn()?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        if started_file.is_file() {
            return Ok(());
        }
        if let Some(status) = child.try_wait()? {
            return Err(AppError::conflict(format!(
                "The update helper exited before it became ready: {status}"
            )));
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = child.kill();
            return Err(AppError::conflict(
                "The update helper did not start within 8 seconds",
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub fn write_ready_marker_from_env() -> AppResult<()> {
    let Some(path) = std::env::var_os(UPDATE_READY_FILE_ENV).map(PathBuf::from) else {
        return Ok(());
    };
    let parent = path
        .parent()
        .ok_or_else(|| AppError::bad_request("invalid update readiness path"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".update-ready-{}.tmp", Uuid::new_v4()));
    let payload = serde_json::to_vec(&json!({
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
    }))?;
    fs::write(&temporary, payload)?;
    fs::rename(temporary, path)?;
    Ok(())
}

pub fn apply_update(spec: &ApplyUpdate) -> AppResult<()> {
    validate_relative_path(&spec.launch_relative)?;
    if spec.process_id == 0 || spec.process_start_time == 0 {
        return Err(AppError::bad_request("invalid desktop process identity"));
    }
    if !spec.source.is_dir() || !spec.target.is_dir() || spec.source == spec.target {
        return Err(AppError::bad_request(
            "prepared and installed application directories are invalid",
        ));
    }
    if spec.ready_timeout.is_zero() {
        return Err(AppError::bad_request(
            "update readiness timeout must be positive",
        ));
    }
    append_log(&spec.log_file, "Rust update helper started");
    write_started_marker(&spec.started_file)?;
    wait_for_process_exit(spec.process_id, spec.process_start_time);
    append_log(
        &spec.log_file,
        "Desktop process exited; replacing application",
    );

    let incoming = sibling_with_suffix(&spec.target, ".update-new")?;
    let backup = sibling_with_suffix(&spec.target, ".update-backup")?;
    let mut new_process = None;
    let result = (|| -> AppResult<()> {
        if !spec.target.exists() && backup.exists() {
            rename_retry(&backup, &spec.target)?;
        }
        remove_tree_retry(&incoming)?;
        remove_tree_retry(&backup)?;
        let _ = fs::remove_file(&spec.ready_file);
        copy_tree(&spec.source, &incoming)?;
        rename_retry(&spec.target, &backup)?;
        rename_retry(&incoming, &spec.target)?;
        let executable = spec.target.join(&spec.launch_relative);
        if !executable.is_file() {
            return Err(AppError::conflict("Updated desktop executable is missing"));
        }
        let child = start_application(
            &executable,
            &spec.target,
            &spec.ready_file,
            &spec.restart_arguments,
            &spec.log_file,
        )?;
        append_log(
            &spec.log_file,
            &format!("Started updated application process {}", child.id()),
        );
        new_process = Some(child);
        wait_for_readiness(
            new_process.as_mut().expect("new process was just stored"),
            &spec.ready_file,
            spec.ready_timeout,
        )?;
        let _ = fs::remove_file(&spec.ready_file);
        if let Err(error) = remove_tree_retry(&backup) {
            append_log(
                &spec.log_file,
                &format!("Update succeeded; backup cleanup is deferred: {error}"),
            );
        }
        append_log(
            &spec.log_file,
            "Update completed after readiness confirmation",
        );
        Ok(())
    })();
    if let Err(error) = result {
        append_log(&spec.log_file, &format!("Update failed: {error}"));
        rollback(spec, &incoming, &backup, new_process.as_mut());
        return Err(error);
    }
    Ok(())
}

fn rollback(spec: &ApplyUpdate, incoming: &Path, backup: &Path, child: Option<&mut Child>) {
    if let Some(child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    let _ = fs::remove_file(&spec.ready_file);
    if backup.exists() {
        let _ = remove_tree_retry(&spec.target);
        let _ = rename_retry(backup, &spec.target);
    }
    let _ = remove_tree_retry(incoming);
    let executable = spec.target.join(&spec.launch_relative);
    if executable.is_file() {
        match start_application(
            &executable,
            &spec.target,
            Path::new(""),
            &spec.restart_arguments,
            &spec.log_file,
        ) {
            Ok(_) => append_log(
                &spec.log_file,
                "Rollback restored and relaunched the previous version",
            ),
            Err(error) => append_log(
                &spec.log_file,
                &format!("Rollback relaunch failed: {error}"),
            ),
        }
    }
}

fn validate_archive(path: &Path) -> AppResult<()> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| AppError::conflict(format!("Invalid update archive: {error}")))?;
    if archive.is_empty() || archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(AppError::conflict(
            "The update archive is empty or contains too many entries",
        ));
    }
    let mut names = BTreeSet::new();
    #[cfg(unix)]
    let mut symlinks: BTreeSet<String> = BTreeSet::new();
    #[cfg(not(unix))]
    let symlinks: BTreeSet<String> = BTreeSet::new();
    let mut extracted_size = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| AppError::conflict(error.to_string()))?;
        let relative = safe_archive_path(entry.name())?;
        let folded = relative.to_string_lossy().to_lowercase();
        if !names.insert(folded.clone()) {
            return Err(AppError::conflict(format!(
                "The update archive contains a duplicate entry: {}",
                entry.name()
            )));
        }
        extracted_size = extracted_size
            .checked_add(entry.size())
            .ok_or_else(|| AppError::conflict("The update archive size overflowed"))?;
        if extracted_size > MAX_EXTRACTED_BYTES {
            return Err(AppError::conflict(
                "The update archive expands beyond the allowed size",
            ));
        }
        if is_symlink(entry.unix_mode()) {
            #[cfg(windows)]
            return Err(AppError::conflict(
                "Windows update archives may not contain symbolic links",
            ));
            #[cfg(unix)]
            {
                let mut entry = entry;
                let mut target = String::new();
                entry
                    .by_ref()
                    .take(4_097)
                    .read_to_string(&mut target)
                    .map_err(|_| AppError::conflict("Update archive symlink is invalid"))?;
                validate_symlink_target(&relative, &target)?;
                symlinks.insert(folded);
            }
        } else if is_special(entry.unix_mode()) {
            return Err(AppError::conflict(
                "The update archive contains a special filesystem entry",
            ));
        }
    }
    for name in &names {
        if Path::new(name)
            .ancestors()
            .skip(1)
            .any(|parent| symlinks.contains(&parent.to_string_lossy().to_lowercase()))
        {
            return Err(AppError::conflict(
                "The update archive writes through a symbolic link",
            ));
        }
    }
    Ok(())
}

fn extract_archive(archive_path: &Path, destination: &Path) -> AppResult<()> {
    let file = File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| AppError::conflict(format!("Invalid update archive: {error}")))?;
    let mut written = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| AppError::conflict(error.to_string()))?;
        let relative = safe_archive_path(entry.name())?;
        let output = destination.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        if is_symlink(entry.unix_mode()) {
            #[cfg(unix)]
            {
                use std::os::unix::fs::symlink;
                let mut target = String::new();
                entry.read_to_string(&mut target)?;
                validate_symlink_target(&relative, &target)?;
                symlink(target, output)?;
                continue;
            }
            #[cfg(windows)]
            return Err(AppError::conflict(
                "Windows update archives may not contain symbolic links",
            ));
        }
        let mut output_file = File::create(&output)?;
        let copied = std::io::copy(&mut entry, &mut output_file)?;
        written = written
            .checked_add(copied)
            .ok_or_else(|| AppError::conflict("The extracted update size overflowed"))?;
        if copied != entry.size() || written > MAX_EXTRACTED_BYTES {
            return Err(AppError::conflict("The extracted update size is invalid"));
        }
        output_file.sync_all()?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&output, fs::Permissions::from_mode(mode & 0o777))?;
        }
    }
    Ok(())
}

fn safe_archive_path(name: &str) -> AppResult<PathBuf> {
    if name.is_empty() || name.contains(['\0', '\\']) {
        return Err(AppError::conflict(
            "The update archive contains an unsafe path",
        ));
    }
    let path = Path::new(name);
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => result.push(value),
            _ => {
                return Err(AppError::conflict(
                    "The update archive contains an unsafe path",
                ));
            }
        }
    }
    if result.as_os_str().is_empty() {
        return Err(AppError::conflict(
            "The update archive contains an empty path",
        ));
    }
    Ok(result)
}

#[cfg(unix)]
fn validate_symlink_target(link: &Path, target: &str) -> AppResult<()> {
    if target.is_empty() || target.len() > 4_096 || target.contains(['\0', '\\']) {
        return Err(AppError::conflict(
            "The update archive contains an unsafe symbolic link",
        ));
    }
    let target_path = Path::new(target);
    if target_path.is_absolute() {
        return Err(AppError::conflict(
            "The update archive contains an unsafe symbolic link",
        ));
    }
    let mut depth = link
        .parent()
        .map_or(0, |parent| parent.components().count());
    for component in target_path.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::ParentDir if depth > 0 => depth -= 1,
            Component::CurDir => {}
            _ => {
                return Err(AppError::conflict(
                    "The update archive contains an unsafe symbolic link",
                ));
            }
        }
    }
    Ok(())
}

fn is_symlink(mode: Option<u32>) -> bool {
    mode.is_some_and(|mode| mode & 0o170000 == 0o120000)
}

fn is_special(mode: Option<u32>) -> bool {
    mode.is_some_and(|mode| {
        let kind = mode & 0o170000;
        !matches!(kind, 0 | 0o040000 | 0o100000 | 0o120000)
    })
}

fn verify_prepared_update(
    prepared: &PreparedUpdate,
    platform: &str,
    version: &str,
) -> AppResult<()> {
    if !platform.starts_with("darwin-") {
        return Ok(());
    }
    let plist = prepared.root.join("Contents/Info.plist");
    if !plist.is_file() {
        return Err(AppError::conflict(
            "The macOS update is missing Contents/Info.plist",
        ));
    }
    run_checked(
        "/usr/bin/codesign",
        &["--verify", "--deep", "--strict", path_text(&prepared.root)?],
    )?;
    let identifier = command_output(
        "/usr/bin/plutil",
        &[
            "-extract",
            "CFBundleIdentifier",
            "raw",
            "-o",
            "-",
            path_text(&plist)?,
        ],
    )?;
    let bundle_version = command_output(
        "/usr/bin/plutil",
        &[
            "-extract",
            "CFBundleShortVersionString",
            "raw",
            "-o",
            "-",
            path_text(&plist)?,
        ],
    )?;
    if identifier.trim() != "dev.service-console.desktop" || bundle_version.trim() != version {
        return Err(AppError::conflict(
            "The macOS update identity or version is invalid",
        ));
    }
    Ok(())
}

fn path_text(path: &Path) -> AppResult<&str> {
    path.to_str()
        .ok_or_else(|| AppError::bad_request("update path must be UTF-8"))
}

fn run_checked(program: &str, arguments: &[&str]) -> AppResult<()> {
    let output = Command::new(program).args(arguments).output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::conflict(format!(
            "Update verification failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

fn command_output(program: &str, arguments: &[&str]) -> AppResult<String> {
    let output = Command::new(program).args(arguments).output()?;
    if !output.status.success() {
        return Err(AppError::conflict("Update metadata verification failed"));
    }
    String::from_utf8(output.stdout).map_err(|_| AppError::conflict("Update metadata is not UTF-8"))
}

fn collect_named_directories(root: &Path, name: &str, found: &mut Vec<PathBuf>) -> AppResult<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            if entry.file_name() == name {
                found.push(path);
            } else {
                collect_named_directories(&path, name, found)?;
            }
        }
    }
    Ok(())
}

fn collect_named_files(
    root: &Path,
    name: &std::ffi::OsStr,
    found: &mut Vec<PathBuf>,
) -> AppResult<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_named_files(&path, name, found)?;
        } else if file_type.is_file() && entry.file_name() == name {
            found.push(path);
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> AppResult<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_tree(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path)?;
            fs::set_permissions(&target_path, fs::metadata(&source_path)?.permissions())?;
        } else if file_type.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(&source_path)?, &target_path)?;
            #[cfg(windows)]
            return Err(AppError::conflict(
                "Windows update trees may not contain symbolic links",
            ));
        } else {
            return Err(AppError::conflict(
                "The prepared update contains a special filesystem entry",
            ));
        }
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> AppResult<()> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AppError::bad_request(
            "The launch executable must be a safe relative path",
        ));
    }
    Ok(())
}

fn sibling_with_suffix(path: &Path, suffix: &str) -> AppResult<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| AppError::bad_request("application root has no filename"))?;
    let mut target_name = name.to_os_string();
    target_name.push(suffix);
    Ok(path.with_file_name(target_name))
}

fn remove_tree_retry(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    retry_filesystem(|| fs::remove_dir_all(path))
}

fn rename_retry(source: &Path, target: &Path) -> AppResult<()> {
    retry_filesystem(|| fs::rename(source, target))
}

fn retry_filesystem(mut operation: impl FnMut() -> std::io::Result<()>) -> AppResult<()> {
    let mut last_error = None;
    for attempt in 0..25 {
        match operation() {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                if attempt < 24 {
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
        }
    }
    Err(last_error
        .expect("retry loop always stores an error")
        .into())
}

fn start_application(
    executable: &Path,
    root: &Path,
    ready_file: &Path,
    arguments: &[String],
    log_file: &Path,
) -> AppResult<Child> {
    let output = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file)?;
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(output.try_clone()?))
        .stderr(Stdio::from(output));
    if ready_file.as_os_str().is_empty() {
        command.env_remove(UPDATE_READY_FILE_ENV);
    } else {
        command.env(UPDATE_READY_FILE_ENV, ready_file);
    }
    configure_detached(&mut command);
    Ok(command.spawn()?)
}

fn wait_for_readiness(child: &mut Child, ready_file: &Path, timeout: Duration) -> AppResult<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if ready_file.is_file() {
            if child.try_wait()?.is_none() {
                return Ok(());
            }
            return Err(AppError::conflict(
                "The updated application exited after reporting readiness",
            ));
        }
        if let Some(status) = child.try_wait()? {
            return Err(AppError::conflict(format!(
                "The updated application exited before readiness: {status}"
            )));
        }
        if Instant::now() >= deadline {
            return Err(AppError::conflict(
                "The updated application did not report readiness in time",
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

pub fn process_start_time(pid: u32) -> Option<u64> {
    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).map(sysinfo::Process::start_time)
}

fn wait_for_process_exit(pid: u32, start_time: u64) {
    while process_start_time(pid) == Some(start_time) {
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn encode_restart_arguments(arguments: &[String]) -> AppResult<String> {
    let payload = serde_json::to_vec(arguments)?;
    if payload.len() > MAX_RESTART_ARGUMENTS_BYTES {
        return Err(AppError::bad_request(
            "Desktop restart arguments are too large",
        ));
    }
    Ok(STANDARD.encode(payload))
}

pub fn decode_restart_arguments(encoded: &str) -> AppResult<Vec<String>> {
    let payload = STANDARD
        .decode(encoded)
        .map_err(|_| AppError::bad_request("Desktop restart arguments are invalid"))?;
    if payload.len() > MAX_RESTART_ARGUMENTS_BYTES {
        return Err(AppError::bad_request(
            "Desktop restart arguments are too large",
        ));
    }
    serde_json::from_slice(&payload)
        .map_err(|_| AppError::bad_request("Desktop restart arguments are invalid"))
}

fn write_started_marker(path: &Path) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::bad_request("invalid update started-marker path"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".update-started-{}.tmp", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec(&json!({"pid": std::process::id()}))?,
    )?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn append_log(path: &Path, message: &str) {
    let result = (|| -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(output, "{} {message}", chrono::Utc::now().to_rfc3339())?;
        output.flush()
    })();
    let _ = result;
}

#[cfg(unix)]
fn configure_detached(command: &mut Command) {
    use std::os::unix::process::CommandExt;
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
fn configure_detached(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

pub fn run_from_args() -> Option<i32> {
    let arguments: Vec<_> = std::env::args_os().collect();
    if arguments.get(1).and_then(|value| value.to_str()) != Some("--update-helper") {
        return None;
    }
    Some(
        match parse_helper_args(&arguments[2..]).and_then(|spec| apply_update(&spec)) {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("update helper failed: {error}");
                1
            }
        },
    )
}

fn parse_helper_args(arguments: &[std::ffi::OsString]) -> AppResult<ApplyUpdate> {
    let mut values = std::collections::BTreeMap::new();
    let mut index = 0;
    while index < arguments.len() {
        let key = arguments[index]
            .to_str()
            .ok_or_else(|| AppError::bad_request("Update helper arguments must be UTF-8"))?;
        let value = arguments
            .get(index + 1)
            .ok_or_else(|| AppError::bad_request(format!("Missing value for {key}")))?;
        values.insert(key.to_owned(), value.clone());
        index += 2;
    }
    let text = |key: &str| -> AppResult<String> {
        values
            .get(key)
            .and_then(|value| value.to_str())
            .map(str::to_owned)
            .ok_or_else(|| AppError::bad_request(format!("Missing or invalid {key}")))
    };
    let path = |key: &str| -> AppResult<PathBuf> {
        values
            .get(key)
            .map(PathBuf::from)
            .ok_or_else(|| AppError::bad_request(format!("Missing {key}")))
    };
    Ok(ApplyUpdate {
        process_id: text("--process-id")?
            .parse()
            .map_err(|_| AppError::bad_request("Invalid desktop process id"))?,
        process_start_time: text("--process-start-time")?
            .parse()
            .map_err(|_| AppError::bad_request("Invalid desktop process start time"))?,
        source: path("--source")?,
        target: path("--target")?,
        launch_relative: path("--launch-relative")?,
        ready_file: path("--ready-file")?,
        started_file: path("--started-file")?,
        log_file: path("--log-file")?,
        restart_arguments: decode_restart_arguments(&text("--restart-arguments")?)?,
        ready_timeout: Duration::from_secs(90),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;
    use zip::{ZipWriter, write::SimpleFileOptions};

    #[test]
    fn archive_validation_rejects_parent_traversal() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("unsafe.zip");
        let file = File::create(&archive_path).unwrap();
        let mut archive = ZipWriter::new(file);
        archive
            .start_file("../outside", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"bad").unwrap();
        archive.finish().unwrap();

        assert!(validate_archive(&archive_path).is_err());
        assert!(!directory.path().join("outside").exists());
    }

    #[test]
    fn tauri_bundle_preserves_the_legacy_update_identity() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], "dev.service-console.desktop");
        assert_eq!(config["mainBinaryName"], "Service Console");
    }

    #[test]
    fn apply_update_commits_only_after_the_new_process_is_ready() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("prepared");
        let target = directory.path().join("installed");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        write_script(
            &source.join("app"),
            "printf new > version; touch \"$SERVICE_CONSOLE_UPDATE_READY_FILE\"; sleep 1",
        );
        write_script(&target.join("app"), "printf old > version; sleep 1");
        fs::write(target.join("version"), "old").unwrap();
        let spec = fixture_spec(directory.path(), source, target.clone());

        apply_update(&spec).unwrap();

        assert_eq!(fs::read_to_string(target.join("version")).unwrap(), "new");
        assert!(!target.with_file_name("installed.update-backup").exists());
    }

    #[test]
    fn apply_update_rolls_back_and_relaunches_the_previous_process() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("prepared");
        let target = directory.path().join("installed");
        let rollback_marker = directory.path().join("rollback-ran");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        write_script(&source.join("app"), "exit 7");
        write_script(
            &target.join("app"),
            &format!("touch {}; sleep 1", shell_quote(&rollback_marker)),
        );
        fs::write(target.join("version"), "old").unwrap();
        let spec = fixture_spec(directory.path(), source, target.clone());

        assert!(apply_update(&spec).is_err());
        let deadline = Instant::now() + Duration::from_secs(2);
        while !rollback_marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(fs::read_to_string(target.join("version")).unwrap(), "old");
        assert!(rollback_marker.exists());
    }

    fn fixture_spec(root: &Path, source: PathBuf, target: PathBuf) -> ApplyUpdate {
        ApplyUpdate {
            process_id: u32::MAX,
            process_start_time: 1,
            source,
            target,
            launch_relative: PathBuf::from("app"),
            ready_file: root.join("ready"),
            started_file: root.join("started"),
            log_file: root.join("update.log"),
            restart_arguments: Vec::new(),
            ready_timeout: Duration::from_secs(2),
        }
    }

    fn write_script(path: &Path, body: &str) {
        fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
    }
}
