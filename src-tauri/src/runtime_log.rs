use std::{
    collections::{HashMap, VecDeque},
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};

const LOG_FILE_NAME: &str = "service-console.log";
const MAX_LOG_BYTES: u64 = 1024 * 1024;
const BACKUP_COUNT: usize = 2;
const MAX_MESSAGE_CHARS: usize = 4 * 1024;

static LOGGER: OnceLock<RotatingLog> = OnceLock::new();

#[derive(Debug, Serialize)]
pub struct LogEntry {
    pub id: String,
    pub timestamp: Option<String>,
    pub level: String,
    pub event: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct LogSnapshot {
    pub entries: Vec<LogEntry>,
    pub path: PathBuf,
    pub max_file_bytes: u64,
    pub retained_files: usize,
}

/// Bound both repeated polling failures and bursts of distinct client errors.
#[derive(Default)]
pub struct DiagnosticLimiter(Mutex<HashMap<String, Instant>>);

impl DiagnosticLimiter {
    pub fn allow(&self, key: &str) -> bool {
        let mut recent = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        recent.retain(|_, time| time.elapsed() < Duration::from_secs(60));
        let key = hex::encode(Sha256::digest(key.as_bytes()));
        if recent.contains_key(&key) || recent.len() >= 64 {
            return false;
        }
        recent.insert(key, Instant::now());
        true
    }
}

/// Read only the fixed application log files, never a caller-supplied path.
pub fn read_recent(data_dir: &Path, limit: usize) -> io::Result<LogSnapshot> {
    let path = data_dir.join("logs").join(LOG_FILE_NAME);
    let _guard = LOGGER
        .get()
        .filter(|logger| logger.path == path)
        .map(|logger| {
            logger
                .lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        });
    let limit = limit.clamp(1, 1_000);
    let mut lines = VecDeque::with_capacity(limit);
    let mut occurrences = HashMap::<String, usize>::new();
    for index in (0..=BACKUP_COUNT).rev() {
        let candidate = if index == 0 {
            path.clone()
        } else {
            backup_path(&path, index)
        };
        let mut file = match File::open(candidate) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let offset = file.metadata()?.len().saturating_sub(MAX_LOG_BYTES);
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::new();
        file.take(MAX_LOG_BYTES).read_to_end(&mut bytes)?;
        // Discard a partial first/last line when an external writer is appending.
        let start = if offset == 0 {
            0
        } else {
            bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(bytes.len(), |index| index + 1)
        };
        let end = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
        if start >= end {
            continue;
        }
        for line in String::from_utf8_lossy(&bytes[start..end])
            .lines()
            .filter(|line| !line.is_empty())
        {
            let digest = hex::encode(Sha256::digest(line.as_bytes()));
            let occurrence = occurrences.entry(digest.clone()).or_default();
            *occurrence += 1;
            let id = format!("{digest}-{occurrence}");
            if lines.len() == limit {
                lines.pop_front();
            }
            lines.push_back((id, line.to_owned()));
        }
    }
    Ok(LogSnapshot {
        entries: lines
            .into_iter()
            .map(|(id, line)| parse_line(id, &line))
            .collect(),
        path,
        max_file_bytes: MAX_LOG_BYTES,
        retained_files: BACKUP_COUNT + 1,
    })
}

fn parse_line(id: String, line: &str) -> LogEntry {
    let mut parts = line.splitn(2, ' ');
    let timestamp = parts.next().unwrap_or_default();
    let rest = parts.next().unwrap_or_default().trim_start();
    let (level, rest) = rest.split_once(' ').unwrap_or(("", ""));
    if chrono::DateTime::parse_from_rfc3339(timestamp).is_err()
        || !matches!(level, "INFO" | "WARN" | "ERROR")
    {
        return LogEntry {
            id,
            timestamp: None,
            level: "INFO".into(),
            event: "runtime.raw".into(),
            message: sanitize(line),
        };
    }
    let (event, message) = rest
        .trim_start()
        .split_once(' ')
        .unwrap_or((rest.trim(), ""));
    LogEntry {
        id,
        timestamp: Some(timestamp.into()),
        level: level.into(),
        event: event.chars().take(100).collect(),
        message: sanitize(message),
    }
}

/// Best-effort redaction for diagnostic messages. Callers must not log payloads/env/headers.
pub fn sanitize(message: &str) -> String {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| vec![
        (Regex::new(r"(?i)\b(Bearer|Basic)\s+[^\s,;]+" ).unwrap(), "$1 [redacted]"),
        (Regex::new(r"(?i)(https?://)[^\s/@]+@" ).unwrap(), "$1[redacted]@"),
        (Regex::new(r"(https?://[^\s?#]+)[?#][^\s]*" ).unwrap(), "$1?[redacted]"),
        (Regex::new(r#"(?i)((?:[\w-]*(?:token|password|secret|api[_-]?key)[\w-]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)"#).unwrap(), "$1[redacted]"),
    ]);
    let mut text: String = message.chars().take(16 * 1024).collect();
    for (pattern, replacement) in patterns {
        text = pattern.replace_all(&text, *replacement).into_owned();
    }
    text = text
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    if text.chars().count() > MAX_MESSAGE_CHARS {
        text = text.chars().take(MAX_MESSAGE_CHARS).collect();
        text.push('…');
    }
    text
}

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
    let message = sanitize(message);
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
        backup_path(&self.path, index)
    }
}

fn backup_path(path: &Path, index: usize) -> PathBuf {
    let mut path = path.as_os_str().to_os_string();
    path.push(format!(".{index}"));
    PathBuf::from(path)
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

    #[test]
    fn recent_logs_include_rotated_history_and_keep_ids_stable() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("logs").join(LOG_FILE_NAME);
        let logger = RotatingLog::new(path.clone(), 1_000, 2).unwrap();
        let first = "2026-09-22T00:00:00.000Z INFO  desktop.ready started\n";
        let second = "2026-09-22T00:00:01.000Z WARN  service.failed 检查网络\n";
        logger.append(first.as_bytes()).unwrap();
        logger.append(second.as_bytes()).unwrap();
        let before = read_recent(directory.path(), 10).unwrap();
        assert_eq!(before.entries[1].level, "WARN");
        assert_eq!(before.entries[1].message, "检查网络");
        logger.rotate().unwrap();
        logger
            .append(b"2026-09-22T00:00:02.000Z ERROR ui.error failure\npartial line")
            .unwrap();
        let after = read_recent(directory.path(), 10).unwrap();
        assert_eq!(after.entries.len(), 3);
        assert_eq!(before.entries[0].id, after.entries[0].id);
        assert_eq!(before.entries[1].id, after.entries[1].id);
        let tail = read_recent(directory.path(), 2).unwrap();
        assert_eq!(tail.entries.len(), 2);
        assert_eq!(tail.entries[0].id, before.entries[1].id);
        assert_eq!(tail.entries[1].event, "ui.error");
    }

    #[test]
    fn recent_logs_handle_missing_and_oversized_files_with_bounded_output() {
        let directory = tempdir().unwrap();
        assert!(
            read_recent(directory.path(), 500)
                .unwrap()
                .entries
                .is_empty()
        );
        let path = directory.path().join("logs").join(LOG_FILE_NAME);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut data = vec![b'x'; MAX_LOG_BYTES as usize + 100];
        data.extend_from_slice(
            b"\nold unstructured line\n2026-09-22T00:00:00.000Z ERROR api.failed last\nunfinished",
        );
        fs::write(path, data).unwrap();
        let snapshot = read_recent(directory.path(), 10).unwrap();
        assert_eq!(snapshot.entries.len(), 2);
        assert_eq!(snapshot.entries[0].event, "runtime.raw");
        assert_eq!(snapshot.entries[1].message, "last");
    }

    #[test]
    fn diagnostics_redact_credentials_and_limit_repeated_errors() {
        let input = r#"Bearer bearer-value Basic basic-value token=abc password="two words" API_KEY='key-value' https://user:pass@example.test/api?auth=hidden#secret"#;
        let output = sanitize(input);
        for secret in [
            "bearer-value",
            "basic-value",
            "abc",
            "two words",
            "key-value",
            "user:pass",
            "hidden",
            "#secret",
        ] {
            assert!(!output.contains(secret), "{output}");
        }
        assert!(output.contains("https://[redacted]@example.test/api?[redacted]"));
        let limiter = DiagnosticLimiter::default();
        assert!(limiter.allow("same"));
        assert!(!limiter.allow("same"));
        for index in 0..63 {
            assert!(limiter.allow(&index.to_string()));
        }
        assert!(!limiter.allow("overflow"));
    }
}
