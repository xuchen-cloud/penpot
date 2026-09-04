use std::fs;
use std::io::Write;
use std::net::IpAddr;
use std::path::Path;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{DesktopError, Result};

pub const CONFIG_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_PUBLIC_PORT: u16 = 9001;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub schema_version: u32,
    pub installation_id: Uuid,
    pub standalone_admin_email: String,
    pub public_port: u16,
    pub lan: LanConfig,
    pub last_started_version: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanConfig {
    pub enabled: bool,
    pub bind_address: Option<IpAddr>,
}

impl DesktopConfig {
    pub fn new(standalone_admin_email: &str) -> Result<Self> {
        let standalone_admin_email = normalize_email(standalone_admin_email)?;
        let config = Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            installation_id: Uuid::new_v4(),
            standalone_admin_email,
            public_port: DEFAULT_PUBLIC_PORT,
            lan: LanConfig {
                enabled: false,
                bind_address: None,
            },
            last_started_version: None,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != CONFIG_SCHEMA_VERSION {
            return Err(DesktopError::InvalidConfig(format!(
                "unsupported schema version {}",
                self.schema_version
            )));
        }
        if self.public_port == 0 {
            return Err(DesktopError::InvalidConfig(
                "the public port must be between 1 and 65535".to_owned(),
            ));
        }
        normalize_email(&self.standalone_admin_email)?;
        match (self.lan.enabled, self.lan.bind_address) {
            (true, None) => Err(DesktopError::InvalidConfig(
                "LAN access requires a selected bind address".to_owned(),
            )),
            (false, Some(_)) => Err(DesktopError::InvalidConfig(
                "a LAN bind address must not be stored while LAN access is disabled".to_owned(),
            )),
            (true, Some(address)) if address.is_loopback() || address.is_unspecified() => {
                Err(DesktopError::InvalidConfig(
                    "LAN access requires a specific non-loopback address".to_owned(),
                ))
            }
            _ => Ok(()),
        }
    }

    pub fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path).map_err(|source| DesktopError::ReadFile {
            path: path.to_owned(),
            source,
        })?;
        let config: Self =
            serde_json::from_slice(&bytes).map_err(|source| DesktopError::InvalidJson {
                path: path.to_owned(),
                source,
            })?;
        config.validate()?;
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        self.validate()?;
        let parent = path.parent().ok_or_else(|| {
            DesktopError::InvalidConfig("configuration path has no parent".to_owned())
        })?;
        let bytes =
            serde_json::to_vec_pretty(self).map_err(|source| DesktopError::InvalidJson {
                path: path.to_owned(),
                source,
            })?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|source| DesktopError::WriteFile {
                path: path.to_owned(),
                source,
            })?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|source| DesktopError::WriteFile {
                path: path.to_owned(),
                source,
            })?;
        temporary
            .persist(path)
            .map_err(|error| DesktopError::WriteFile {
                path: path.to_owned(),
                source: error.error,
            })?;
        Ok(())
    }
}

fn normalize_email(value: &str) -> Result<String> {
    let value = value.trim().to_lowercase();
    let Some((local, domain)) = value.split_once('@') else {
        return Err(DesktopError::InvalidConfig(
            "the administrator email address is invalid".to_owned(),
        ));
    };
    if local.is_empty()
        || domain.is_empty()
        || domain.contains('@')
        || value.chars().any(char::is_whitespace)
    {
        return Err(DesktopError::InvalidConfig(
            "the administrator email address is invalid".to_owned(),
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_valid_configuration() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("desktop.json");
        let config = DesktopConfig::new("Admin@Example.com").unwrap();

        config.save(&path).unwrap();

        assert_eq!(DesktopConfig::load(&path).unwrap(), config);
        assert_eq!(config.standalone_admin_email, "admin@example.com");
    }

    #[test]
    fn rejects_lan_mode_without_a_selected_address() {
        let config = DesktopConfig {
            lan: LanConfig {
                enabled: true,
                bind_address: None,
            },
            ..DesktopConfig::new("admin@example.com").unwrap()
        };

        assert!(matches!(
            config.validate(),
            Err(DesktopError::InvalidConfig(_))
        ));
    }

    #[test]
    fn rejects_loopback_as_a_lan_address() {
        let config = DesktopConfig {
            lan: LanConfig {
                enabled: true,
                bind_address: Some("127.0.0.1".parse().unwrap()),
            },
            ..DesktopConfig::new("admin@example.com").unwrap()
        };

        assert!(matches!(
            config.validate(),
            Err(DesktopError::InvalidConfig(_))
        ));
    }

    #[test]
    fn rejects_an_invalid_administrator_email() {
        assert!(matches!(
            DesktopConfig::new("not an email"),
            Err(DesktopError::InvalidConfig(_))
        ));
    }
}
