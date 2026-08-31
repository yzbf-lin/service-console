#![cfg(unix)]

use std::{
    fs,
    os::unix::process::CommandExt,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use service_console::process_guardian::{
    MANAGED_PROCESS_ID_ENV, ProcessGuardian, ProcessLease, STATE_FILENAME,
};
use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate, System};
use tempfile::tempdir;
use uuid::Uuid;

#[tokio::test]
async fn ownership_pipe_eof_reaps_the_managed_process_group() {
    let directory = tempdir().unwrap();
    let pid_file = directory.path().join("pids");
    let registration_id = Uuid::new_v4().to_string();
    let script = format!(
        "trap '' TERM; sleep 60 & child=$!; printf '%s %s\\n' $$ $child > {}; wait",
        shell_quote(pid_file.to_str().unwrap())
    );
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", &script])
        .env(MANAGED_PROCESS_ID_ENV, &registration_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    let root_pid = child.id();
    let (reported_root, descendant_pid) = wait_for_pids(&pid_file);
    assert_eq!(reported_root, root_pid);

    let mut guardian = ProcessGuardian::new(directory.path());
    guardian
        .track(ProcessLease::new(
            registration_id,
            "crash-fixture".into(),
            root_pid,
            Some(root_pid),
            0.1,
        ))
        .await
        .unwrap();

    drop(guardian);
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline
        && (process_is_live(root_pid)
            || process_is_live(descendant_pid)
            || directory.path().join(STATE_FILENAME).exists())
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.wait();

    assert!(
        !process_is_live(root_pid),
        "root process survived guardian EOF"
    );
    assert!(
        !process_is_live(descendant_pid),
        "descendant process survived guardian EOF"
    );
    assert!(
        !directory.path().join(STATE_FILENAME).exists(),
        "guardian state remained after confirmed cleanup"
    );
}

fn wait_for_pids(path: &std::path::Path) -> (u32, u32) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(contents) = fs::read_to_string(path) {
            let values: Vec<u32> = contents
                .split_whitespace()
                .filter_map(|value| value.parse().ok())
                .collect();
            if let [root, child] = values.as_slice() {
                return (*root, *child);
            }
        }
        assert!(
            Instant::now() < deadline,
            "service did not publish its PIDs"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn process_is_live(pid: u32) -> bool {
    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).is_some_and(|process| {
        !matches!(
            process.status(),
            ProcessStatus::Zombie | ProcessStatus::Dead
        )
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
