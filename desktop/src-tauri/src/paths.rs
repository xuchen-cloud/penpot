use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{DesktopError, Result};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstancePaths {
    pub root: PathBuf,
    pub database: PathBuf,
    pub cache: PathBuf,
    pub assets: PathBuf,
    pub config: PathBuf,
    pub logs: PathBuf,
    pub backups: PathBuf,
    pub certificates: PathBuf,
    pub temporary: PathBuf,
    pub run: PathBuf,
}

impl InstancePaths {
    pub fn from_root(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self {
            database: root.join("database"),
            cache: root.join("cache"),
            assets: root.join("assets"),
            config: root.join("config"),
            logs: root.join("logs"),
            backups: root.join("backups"),
            certificates: root.join("certificates"),
            temporary: root.join("tmp"),
            run: root.join("run"),
            root,
        }
    }

    pub fn create(&self) -> Result<()> {
        for path in self.directories() {
            create_private_directory(path)?;
        }
        Ok(())
    }

    pub fn config_file(&self) -> PathBuf {
        self.config.join("desktop.json")
    }

    fn directories(&self) -> [&Path; 10] {
        [
            &self.root,
            &self.database,
            &self.cache,
            &self.assets,
            &self.config,
            &self.logs,
            &self.backups,
            &self.certificates,
            &self.temporary,
            &self.run,
        ]
    }

    #[cfg(windows)]
    pub fn verify_private_acls(&self) -> Result<()> {
        for path in self.directories() {
            if !crate::windows_security::has_private_owner_acl(path)? {
                return Err(DesktopError::Process(format!(
                    "Windows path does not have a protected owner-only ACL: {}",
                    path.display()
                )));
            }
        }
        let probe = tempfile::NamedTempFile::new_in(&self.config).map_err(|source| {
            DesktopError::WriteFile {
                path: self.config.join("acl-probe"),
                source,
            }
        })?;
        if !crate::windows_security::has_private_owner_acl(probe.path())? {
            return Err(DesktopError::Process(
                "files created in the private config directory are not owner-only".to_owned(),
            ));
        }
        Ok(())
    }
}

fn create_private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|source| DesktopError::WriteFile {
        path: path.to_owned(),
        source,
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|source| {
            DesktopError::WriteFile {
                path: path.to_owned(),
                source,
            }
        })?;
    }

    #[cfg(windows)]
    crate::windows_security::restrict_to_owner(path)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_complete_instance_layout() {
        let temporary = tempfile::tempdir().unwrap();
        let paths = InstancePaths::from_root(temporary.path().join("Penpot Desktop"));

        paths.create().unwrap();

        for directory in paths.directories() {
            assert!(
                directory.is_dir(),
                "{} was not created",
                directory.display()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn instance_directories_are_private_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().unwrap();
        let paths = InstancePaths::from_root(temporary.path().join("Penpot Desktop"));
        paths.create().unwrap();

        let mode = fs::metadata(&paths.config).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[cfg(windows)]
    #[test]
    fn instance_directories_have_a_protected_owner_only_acl_on_windows() {
        let temporary = tempfile::tempdir().unwrap();
        let paths = InstancePaths::from_root(temporary.path().join("Penpot Desktop"));
        paths.create().unwrap();

        assert!(crate::windows_security::has_private_owner_acl(&paths.config).unwrap());
        assert!(crate::windows_security::has_private_owner_acl(&paths.database).unwrap());
        assert!(crate::windows_security::has_private_owner_acl(&paths.logs).unwrap());
        assert!(crate::windows_security::has_private_owner_acl(&paths.temporary).unwrap());
        fs::write(paths.config_file(), b"private").unwrap();
        assert!(crate::windows_security::has_private_owner_acl(&paths.config_file()).unwrap());
    }
}
