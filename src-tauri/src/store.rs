use std::{
    collections::{BTreeMap, VecDeque},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    models::{LogEntry, ServiceDefinition, expand_home},
};

#[derive(Debug, Serialize, Deserialize)]
struct DefinitionFile {
    #[serde(default = "definition_version")]
    version: u32,
    #[serde(default)]
    services: Vec<ServiceDefinition>,
}

fn definition_version() -> u32 {
    1
}

#[derive(Debug, Clone)]
pub struct DefinitionStore {
    data_dir: PathBuf,
    definitions_path: PathBuf,
    logs_dir: PathBuf,
}

impl DefinitionStore {
    pub fn new(data_dir: impl AsRef<Path>) -> AppResult<Self> {
        let data_dir = expand_home(data_dir);
        let logs_dir = data_dir.join("logs");
        fs::create_dir_all(&logs_dir)?;
        Ok(Self {
            definitions_path: data_dir.join("services.json"),
            data_dir,
            logs_dir,
        })
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn load(&self) -> AppResult<BTreeMap<String, ServiceDefinition>> {
        if !self.definitions_path.exists() {
            return Ok(BTreeMap::new());
        }
        let bytes = fs::read(&self.definitions_path)?;
        let raw: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
            AppError::bad_request(format!("failed to load service definitions: {error}"))
        })?;
        let definitions = if raw.is_array() {
            serde_json::from_value::<Vec<ServiceDefinition>>(raw)?
        } else {
            serde_json::from_value::<DefinitionFile>(raw)?.services
        };
        let mut result = BTreeMap::new();
        for definition in definitions {
            let definition = definition.normalize()?;
            if result.contains_key(&definition.name) {
                return Err(AppError::bad_request(format!(
                    "duplicate service definition: {}",
                    definition.name
                )));
            }
            result.insert(definition.name.clone(), definition);
        }
        Ok(result)
    }

    pub fn save<'a>(
        &self,
        definitions: impl IntoIterator<Item = &'a ServiceDefinition>,
    ) -> AppResult<()> {
        let payload = DefinitionFile {
            version: 1,
            services: definitions.into_iter().cloned().collect(),
        };
        let mut encoded = serde_json::to_vec_pretty(&payload)?;
        encoded.push(b'\n');
        let temporary = self.data_dir.join(format!(
            ".services-{}-{}.tmp",
            std::process::id(),
            rand::random::<u64>()
        ));
        let write_result = (|| -> AppResult<()> {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            file.write_all(&encoded)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &self.definitions_path)?;
            Ok(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        write_result
    }

    pub fn append_log(&self, service: &str, entry: &LogEntry) -> AppResult<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_path(service))?;
        serde_json::to_writer(&mut file, entry)?;
        file.write_all(b"\n")?;
        Ok(())
    }

    pub fn load_logs(&self, service: &str, tail: usize) -> AppResult<Vec<LogEntry>> {
        if tail == 0 {
            return Ok(Vec::new());
        }
        let path = self.log_path(service);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let mut lines = VecDeque::with_capacity(tail);
        for line in BufReader::new(fs::File::open(path)?).lines() {
            let Ok(line) = line else { continue };
            if lines.len() == tail {
                lines.pop_front();
            }
            lines.push_back(line);
        }
        Ok(lines
            .into_iter()
            .filter_map(|line| serde_json::from_str(&line).ok())
            .collect())
    }

    pub fn delete_logs(&self, service: &str) -> AppResult<()> {
        match fs::remove_file(self.log_path(service)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn log_path(&self, service: &str) -> PathBuf {
        let encoded = utf8_percent_encode(service, NON_ALPHANUMERIC).to_string();
        self.logs_dir.join(format!("{encoded}.jsonl"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn definition(name: &str) -> ServiceDefinition {
        ServiceDefinition {
            name: name.into(),
            command: "echo ok".into(),
            cwd: ".".into(),
            env: BTreeMap::new(),
            auto_start: false,
            stop_timeout: 5.0,
        }
    }

    #[test]
    fn definitions_and_logs_round_trip() {
        let directory = tempdir().unwrap();
        let store = DefinitionStore::new(directory.path()).unwrap();
        let definitions = [definition("api"), definition("web")];
        store.save(definitions.iter()).unwrap();
        assert_eq!(store.load().unwrap().len(), 2);

        store
            .append_log("api/name", &LogEntry::new("stdout", "one"))
            .unwrap();
        store
            .append_log("api/name", &LogEntry::new("stderr", "two"))
            .unwrap();
        let logs = store.load_logs("api/name", 1).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].message, "two");
    }
}
