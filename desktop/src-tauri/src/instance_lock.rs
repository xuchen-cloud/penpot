use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;

use fs2::FileExt;

use crate::error::{DesktopError, Result};

pub struct InstanceLock {
    _file: File,
}

impl InstanceLock {
    pub fn acquire(path: &Path) -> Result<Self> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(path)
            .map_err(|source| DesktopError::WriteFile {
                path: path.to_owned(),
                source,
            })?;
        file.try_lock_exclusive().map_err(|error| {
            DesktopError::Process(format!(
                "another Penpot Desktop process is already using this data directory: {error}"
            ))
        })?;
        file.set_len(0)
            .and_then(|_| writeln!(file, "{}", std::process::id()))
            .and_then(|_| file.sync_all())
            .map_err(|source| DesktopError::WriteFile {
                path: path.to_owned(),
                source,
            })?;
        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excludes_a_second_owner() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("desktop.lock");
        let first = InstanceLock::acquire(&path).unwrap();
        assert!(InstanceLock::acquire(&path).is_err());
        drop(first);
        assert!(InstanceLock::acquire(&path).is_ok());
    }
}
