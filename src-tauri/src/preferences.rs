use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    models::expand_home,
};

#[derive(Debug, Serialize, Deserialize)]
struct PreferencesFile {
    #[serde(default = "version")]
    version: u32,
    #[serde(default = "default_theme")]
    theme: String,
}

fn version() -> u32 {
    1
}
fn default_theme() -> String {
    "system".into()
}

#[derive(Debug, Clone)]
pub struct UiPreferencesStore {
    path: PathBuf,
}

impl UiPreferencesStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self {
            path: expand_home(data_dir).join("ui-preferences.json"),
        }
    }

    pub fn load_theme(&self) -> String {
        fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PreferencesFile>(&bytes).ok())
            .map(|value| value.theme)
            .filter(|theme| matches!(theme.as_str(), "system" | "light" | "dark"))
            .unwrap_or_else(default_theme)
    }

    pub fn save_theme(&self, theme: &str) -> AppResult<()> {
        if !matches!(theme, "system" | "light" | "dark") {
            return Err(AppError::bad_request(
                "theme must be system, light, or dark",
            ));
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut encoded = serde_json::to_vec_pretty(&PreferencesFile {
            version: 1,
            theme: theme.into(),
        })?;
        encoded.push(b'\n');
        fs::write(&self.path, encoded)?;
        Ok(())
    }
}
