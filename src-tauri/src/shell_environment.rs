use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

const MARKER: &[u8] = b"\0SERVICE_CONSOLE_LOGIN_ENVIRONMENT_V1\0";
const PRINT_ENVIRONMENT: &str =
    "printf '\\000SERVICE_CONSOLE_LOGIN_ENVIRONMENT_V1\\000'; /usr/bin/env -0";
const PRESERVED_KEYS: &[&str] = &[
    "OLDPWD",
    "PWD",
    "SHLVL",
    "TERM",
    "TERM_PROGRAM",
    "TERM_SESSION_ID",
    "_",
];
static DESKTOP_SERVICE_ENVIRONMENT: OnceLock<BTreeMap<String, String>> = OnceLock::new();

pub fn resolve_desktop_service_environment() -> BTreeMap<String, String> {
    DESKTOP_SERVICE_ENVIRONMENT
        .get_or_init(|| {
            let base = std::env::vars().collect();
            if !cfg!(target_os = "macos") || !is_packaged_macos_app() {
                return base;
            }
            resolve_login_environment(base, None, Duration::from_secs(8))
        })
        .clone()
}

fn is_packaged_macos_app() -> bool {
    std::env::current_exe().is_ok_and(|path| {
        path.ancestors().any(|ancestor| {
            ancestor
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        })
    })
}

fn resolve_login_environment(
    base: BTreeMap<String, String>,
    selected_shell: Option<&Path>,
    timeout: Duration,
) -> BTreeMap<String, String> {
    if timeout.is_zero() {
        return base;
    }
    let Some(shell) = select_shell(&base, selected_shell) else {
        return base;
    };
    let mut capture_environment = base.clone();
    capture_environment.insert("TERM".into(), "dumb".into());
    let mut command = Command::new(shell);
    command
        .args(["-l", "-i", "-c", PRINT_ENVIRONMENT])
        .env_clear()
        .envs(&capture_environment)
        .current_dir(dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        return base;
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        return base;
    };
    let reader = thread::spawn(move || {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).map(|_| output)
    });
    let deadline = Instant::now() + timeout;
    let completed = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let Ok(Ok(output)) = reader.join() else {
        return base;
    };
    if !completed {
        return base;
    }
    let shell_environment = parse_environment_output(&output);
    if shell_environment
        .get("PATH")
        .is_none_or(|path| path.is_empty())
    {
        return base;
    }
    let mut merged = base.clone();
    merged.extend(shell_environment);
    for key in PRESERVED_KEYS {
        match base.get(*key) {
            Some(value) => {
                merged.insert((*key).into(), value.clone());
            }
            None => {
                merged.remove(*key);
            }
        }
    }
    merged
}

fn select_shell(
    environment: &BTreeMap<String, String>,
    selected: Option<&Path>,
) -> Option<PathBuf> {
    selected
        .map(Path::to_path_buf)
        .into_iter()
        .chain(environment.get("SHELL").map(PathBuf::from))
        .chain([PathBuf::from("/bin/zsh"), PathBuf::from("/bin/sh")])
        .find(|path| path.is_absolute() && path.is_file())
}

fn parse_environment_output(output: &[u8]) -> BTreeMap<String, String> {
    let Some(marker_index) = output
        .windows(MARKER.len())
        .rposition(|value| value == MARKER)
    else {
        return BTreeMap::new();
    };
    output[marker_index + MARKER.len()..]
        .split(|byte| *byte == 0)
        .filter_map(|item| {
            let separator = item.iter().position(|byte| *byte == b'=')?;
            let key = std::str::from_utf8(&item[..separator]).ok()?;
            let value = std::str::from_utf8(&item[separator + 1..]).ok()?;
            (!key.is_empty() && !key.contains('=')).then(|| (key.into(), value.into()))
        })
        .collect()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn login_environment_overrides_base_but_preserves_process_keys() {
        let directory = tempfile::tempdir().unwrap();
        let shell = directory.path().join("login-shell");
        fs::write(
            &shell,
            "#!/bin/sh\nprintf '\\000SERVICE_CONSOLE_LOGIN_ENVIRONMENT_V1\\000PATH=/login/bin\\000BASE=login\\000PWD=/wrong\\000'\n",
        )
        .unwrap();
        fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();
        let base = BTreeMap::from([
            ("PATH".into(), "/base/bin".into()),
            ("BASE".into(), "desktop".into()),
            ("PWD".into(), "/preserved".into()),
        ]);
        let resolved = resolve_login_environment(base, Some(&shell), Duration::from_secs(2));
        assert_eq!(resolved["PATH"], "/login/bin");
        assert_eq!(resolved["BASE"], "login");
        assert_eq!(resolved["PWD"], "/preserved");
    }

    #[test]
    fn output_without_marker_is_not_trusted() {
        assert!(parse_environment_output(b"PATH=/untrusted\0").is_empty());
    }
}
