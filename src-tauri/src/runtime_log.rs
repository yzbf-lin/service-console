use std::{
    fmt,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use chrono::{SecondsFormat, Utc};

const LOG_FILE_NAME: &str = "service-console.log";
const MAX_LOG_BYTES: u64 = 1024 * 1024;
const BACKUP_COUNT: usize = 2;
const MAX_MESSAGE_CHARS: usize = 4 * 1024;

static LOGGER: OnceLock<RotatingLog> = OnceLock::new();

pub fn init(data_dir: &Path) -> io::Result<PathBuf> {
    if let Some(logger) = LOGGER.get() {
        return Ok(logger.path.clone());
    }
    let logger = RotatingLog::new(
        data_dir.join("logs").join(LOG_FILE_NAME),
        MAX_LOG_BYTES,
        BACKUP_COUNT,
    )?;
    let path = logger.path.clone();
    let _ = LOGGER.set(logger);
    Ok(LOGGER
        .get()
        .map(|logger| logger.path.clone())
        .unwrap_or(path))
}

pub fn info(event: &str, message: impl fmt::Display) {
    write("INFO", event, message);
}

pub fn warn(event: &str, message: impl fmt::Display) {
    write("WARN", event, message);
}

pub fn error(event: &str, message: impl fmt::Display) {
    write("ERROR", event, message);
}

fn write(level: &str, event: &str, message: impl fmt::Display) {
    let line = format_line(level, event, &message.to_string());
    eprint!("{line}");
    if let Some(logger) = LOGGER.get()
        && let Err(error) = logger.append(line.as_bytes())
    {
        eprintln!("runtime log write failed: {error}");
    }
}

fn format_line(level: &str, event: &str, message: &str) -> String {
    let mut message = message.replace(['\r', '\n'], " ");
    if message.chars().count() > MAX_MESSAGE_CHARS {
        message = message.chars().take(MAX_MESSAGE_CHARS).collect();
        message.push('…');
    }
    format!(
        "{} {level:<5} {event} {message}\n",
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    )
}

struct RotatingLog {
    path: PathBuf,
    max_bytes: u64,
    backup_count: usize,
    lock: Mutex<()>,
}

impl RotatingLog {
    fn new(path: PathBuf, max_bytes: u64, backup_count: usize) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let logger = Self {
            path,
            max_bytes,
            backup_count,
            lock: Mutex::new(()),
        };
        for candidate in std::iter::once(logger.path.clone())
            .chain((1..=backup_count).map(|index| logger.backup_path(index)))
        {
            if fs::metadata(&candidate).is_ok_and(|metadata| metadata.len() > max_bytes) {
                fs::remove_file(candidate)?;
            }
        }
        Ok(logger)
    }

    fn append(&self, line: &[u8]) -> io::Result<()> {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current_size = fs::metadata(&self.path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if current_size > 0 && current_size.saturating_add(line.len() as u64) > self.max_bytes {
            self.rotate()?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(line)?;
        file.flush()
    }

    fn rotate(&self) -> io::Result<()> {
        for index in (1..=self.backup_count).rev() {
            let destination = self.backup_path(index);
            if destination.exists() {
                fs::remove_file(&destination)?;
            }
            let source = if index == 1 {
                self.path.clone()
            } else {
                self.backup_path(index - 1)
            };
            if source.exists() {
                fs::rename(source, destination)?;
            }
        }
        if self.backup_count == 0 && self.path.exists() {
            fs::remove_file(&self.path)?;
        }
        Ok(())
    }

    fn backup_path(&self, index: usize) -> PathBuf {
        let mut path = self.path.as_os_str().to_os_string();
        path.push(format!(".{index}"));
        PathBuf::from(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rotation_keeps_a_fixed_number_of_bounded_files() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("runtime.log");
        let logger = RotatingLog::new(path.clone(), 80, 2).unwrap();

        for index in 0..30 {
            logger
                .append(format!("event-{index:02} important message\n").as_bytes())
                .unwrap();
        }

        for candidate in [&path, &logger.backup_path(1), &logger.backup_path(2)] {
            assert!(candidate.is_file());
            assert!(fs::metadata(candidate).unwrap().len() <= 80);
        }
        assert!(!logger.backup_path(3).exists());
    }

    #[test]
    fn log_lines_are_single_line_and_messages_are_bounded() {
        let line = format_line("INFO", "event", &format!("first\n{}", "x".repeat(5_000)));
        assert_eq!(line.lines().count(), 1);
        assert!(line.chars().count() < 4_200);
        assert!(line.contains("first "));
        assert!(line.contains('…'));
    }
}
