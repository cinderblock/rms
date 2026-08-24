//! Where this agent points, and who it thinks it is.
//!
//! Deliberately holds **no secrets**. The device private key lives in the OS
//! keystore ([`crate::keys`]) and the enrollment passphrase is discarded the
//! moment enrollment succeeds. What's left — a URL, a device id, a server name —
//! is not sensitive, which is why this can be a plain readable file.
//!
//! Enrollment state is therefore split across two places, and the pair can
//! disagree: a restored backup or a hand-edited file can leave config present
//! with no key, or vice versa. [`AgentConfig::load`] doesn't try to reconcile
//! that; [`is_enrolled`] answers the only question that matters by requiring
//! both.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::keys::DeviceKey;

const CONFIG_FILE: &str = "config.json";

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("could not determine a config directory for this platform")]
    NoConfigDir,
    #[error("could not read or write {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("config file at {path} is not valid JSON: {source}")]
    Malformed {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    /// Base URL of the control server, without a trailing slash.
    pub server_url: String,
    /// Assigned by the server at enrollment.
    pub device_id: String,
    /// The server's self-reported name, kept so the UI can show where this
    /// machine actually landed rather than just a URL.
    pub server_name: String,
    /// Epoch seconds. Informational.
    pub enrolled_at: u64,
}

impl AgentConfig {
    /// `%APPDATA%\rms` on Windows, `~/.config/rms` on Linux,
    /// `~/Library/Application Support/rms` on macOS.
    pub fn directory() -> Result<PathBuf, ConfigError> {
        directories::ProjectDirs::from("com", "cinderblock", "rms")
            .map(|dirs| dirs.config_dir().to_path_buf())
            .ok_or(ConfigError::NoConfigDir)
    }

    pub fn path() -> Result<PathBuf, ConfigError> {
        Ok(Self::directory()?.join(CONFIG_FILE))
    }

    pub fn load() -> Result<Option<Self>, ConfigError> {
        Self::load_from(&Self::path()?)
    }

    pub fn save(&self) -> Result<(), ConfigError> {
        self.save_to(&Self::path()?)
    }

    pub fn clear() -> Result<(), ConfigError> {
        let path = Self::path()?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(ConfigError::Io { path, source }),
        }
    }

    pub fn load_from(path: &Path) -> Result<Option<Self>, ConfigError> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(ConfigError::Io {
                    path: path.to_path_buf(),
                    source,
                });
            }
        };

        serde_json::from_str(&text)
            .map(Some)
            .map_err(|source| ConfigError::Malformed {
                path: path.to_path_buf(),
                source,
            })
    }

    /// Written via a temporary file and a rename, so an interrupted write leaves
    /// the previous config intact rather than a truncated one. A half-written
    /// config would strand the agent with no server to talk to and no way to be
    /// told about it.
    pub fn save_to(&self, path: &Path) -> Result<(), ConfigError> {
        let io = |source: std::io::Error| ConfigError::Io {
            path: path.to_path_buf(),
            source,
        };

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io)?;
        }

        let json = serde_json::to_string_pretty(self).expect("config is always serializable");
        let temp = path.with_extension("json.tmp");

        std::fs::write(&temp, json).map_err(io)?;
        std::fs::rename(&temp, path).map_err(io)?;

        Ok(())
    }
}

/// True only when the config *and* the device key are both present.
///
/// Either half alone is a broken state, not a usable one — config without a key
/// cannot authenticate, and a key without config has nowhere to go. Reporting
/// "enrolled" for either would send the agent into a retry loop it can't escape;
/// reporting "not enrolled" sends the user to the enrollment form, which fixes it.
pub fn is_enrolled() -> bool {
    matches!(AgentConfig::load(), Ok(Some(_))) && matches!(DeviceKey::load(), Ok(Some(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> AgentConfig {
        AgentConfig {
            server_url: "https://control.example.com".into(),
            device_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301".into(),
            server_name: "control".into(),
            enrolled_at: 1_800_000_000,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rms-config-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn round_trips_through_a_file() {
        let path = temp_dir("roundtrip").join("config.json");
        sample().save_to(&path).unwrap();

        assert_eq!(AgentConfig::load_from(&path).unwrap(), Some(sample()));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_missing_file_is_none_rather_than_an_error() {
        let path = temp_dir("missing").join("config.json");
        assert_eq!(AgentConfig::load_from(&path).unwrap(), None);
    }

    #[test]
    fn malformed_json_is_an_error_rather_than_silently_none() {
        // Silently treating a corrupt config as "not enrolled" would re-enroll
        // the machine and leave an orphaned device record behind on the server.
        let dir = temp_dir("malformed");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, "{ not json").unwrap();

        assert!(matches!(
            AgentConfig::load_from(&path),
            Err(ConfigError::Malformed { .. })
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saving_over_an_existing_config_replaces_it_and_leaves_no_temp_file() {
        let dir = temp_dir("replace");
        let path = dir.join("config.json");

        sample().save_to(&path).unwrap();
        let updated = AgentConfig {
            server_url: "https://other.example.com".into(),
            ..sample()
        };
        updated.save_to(&path).unwrap();

        assert_eq!(AgentConfig::load_from(&path).unwrap(), Some(updated));
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn serializes_with_camel_case_keys() {
        let json = serde_json::to_value(sample()).unwrap();
        assert!(json.get("serverUrl").is_some());
        assert!(json.get("deviceId").is_some());
        assert!(json.get("enrolledAt").is_some());
    }

    #[test]
    fn a_config_directory_is_resolvable_on_this_platform() {
        assert!(AgentConfig::directory().is_ok());
    }
}
