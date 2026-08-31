use std::{path::PathBuf, process::ExitCode, time::Duration};

use anyhow::{Context, Result, bail};
use clap::Parser;
use service_console::update_helper::{
    ApplyUpdate, apply_update, decode_restart_arguments, process_start_time,
};

/// Transition helper accepted by the Python desktop releases up to 0.3.x.
#[derive(Debug, Parser)]
#[command(name = "Service Console Updater")]
struct Args {
    #[arg(long)]
    process_id: u32,
    #[arg(long)]
    source: PathBuf,
    #[arg(long)]
    target: PathBuf,
    #[arg(long)]
    launch_relative: PathBuf,
    #[arg(long)]
    ready_file: PathBuf,
    #[arg(long)]
    started_file: PathBuf,
    #[arg(long)]
    log_file: PathBuf,
    #[arg(long)]
    restart_arguments: String,
    #[arg(long, default_value_t = 90.0)]
    ready_timeout: f64,
}

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("update helper failed: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: Args) -> Result<()> {
    if !args.ready_timeout.is_finite() || args.ready_timeout <= 0.0 {
        bail!("update readiness timeout must be positive and finite");
    }
    let process_start_time = process_start_time(args.process_id)
        .context("desktop process identity could not be captured")?;
    let restart_arguments = decode_restart_arguments(&args.restart_arguments)?;
    apply_update(&ApplyUpdate {
        process_id: args.process_id,
        process_start_time,
        source: args.source,
        target: args.target,
        launch_relative: args.launch_relative,
        ready_file: args.ready_file,
        started_file: args.started_file,
        log_file: args.log_file,
        restart_arguments,
        ready_timeout: Duration::from_secs_f64(args.ready_timeout),
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};

    #[test]
    fn accepts_the_legacy_python_helper_protocol() {
        let restart_arguments = STANDARD.encode(b"[\"--example\",\"hello world\"]");
        let args = Args::try_parse_from([
            "Service Console Updater",
            "--process-id",
            "123",
            "--source",
            "prepared",
            "--target",
            "installed",
            "--launch-relative",
            "Service Console.exe",
            "--ready-file",
            "ready",
            "--started-file",
            "started",
            "--log-file",
            "update.log",
            "--restart-arguments",
            &restart_arguments,
            "--ready-timeout",
            "45",
        ])
        .unwrap();
        assert_eq!(args.process_id, 123);
        assert_eq!(args.launch_relative, PathBuf::from("Service Console.exe"));
        assert_eq!(args.ready_timeout, 45.0);
        assert_eq!(
            decode_restart_arguments(&args.restart_arguments).unwrap(),
            ["--example", "hello world"]
        );
    }
}
