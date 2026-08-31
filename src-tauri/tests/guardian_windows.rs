#![cfg(windows)]

use std::{
    os::windows::process::CommandExt,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use service_console::process_guardian::{
    MANAGED_PROCESS_ID_ENV, ProcessGuardian, ProcessLease, resume_windows_process,
};
use tempfile::tempdir;
use uuid::Uuid;
use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED};

#[tokio::test]
async fn job_object_reaps_a_suspended_process_after_ownership_pipe_eof() {
    let directory = tempdir().unwrap();
    let registration_id = Uuid::new_v4().to_string();
    let mut child = Command::new("cmd.exe")
        .args(["/D", "/S", "/C", "ping -t 127.0.0.1 > NUL"])
        .env(MANAGED_PROCESS_ID_ENV, &registration_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED)
        .spawn()
        .unwrap();
    let pid = child.id();
    let mut guardian = ProcessGuardian::new(directory.path());
    guardian
        .track(ProcessLease::new(
            registration_id,
            "windows-crash-fixture".into(),
            pid,
            None,
            0.1,
        ))
        .await
        .unwrap();
    resume_windows_process(pid).unwrap();

    drop(guardian);
    let deadline = Instant::now() + Duration::from_secs(8);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(child.try_wait().unwrap().is_some());
}
