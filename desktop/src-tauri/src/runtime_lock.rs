use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{DesktopError, Result};
use crate::runtime_manifest::{RuntimeComponent, RuntimeManifest};

pub const RUNTIME_LOCK_FILE: &str = "runtime-lock.json";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLock {
    pub schema_version: u32,
    pub target: String,
    pub components: Vec<LockedComponent>,
    pub sources: Vec<SourceArtifact>,
    /// Every file and link, including native libraries and JavaScript modules.
    pub inventory: Vec<InventoryEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEntry {
    pub path: PathBuf,
    pub sha256: String,
    pub link_target: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedComponent {
    pub id: String,
    pub version: String,
    pub source: String,
    pub license: String,
    pub build_recipe: String,
    pub files: Vec<LockedFile>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedFile {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentMetadataManifest {
    pub schema_version: u32,
    pub target: String,
    pub components: Vec<ComponentMetadata>,
    pub sources: Vec<SourceArtifact>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceArtifact {
    pub id: String,
    pub version: String,
    pub source: String,
    pub license: String,
    pub sha256: String,
    pub build_recipe: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentMetadata {
    pub id: String,
    pub version: String,
    pub source: String,
    pub license: String,
    pub build_recipe: String,
}

impl RuntimeLock {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path).map_err(|source| DesktopError::ReadFile {
            path: path.to_owned(),
            source,
        })?;
        serde_json::from_slice(&bytes).map_err(|source| DesktopError::InvalidJson {
            path: path.to_owned(),
            source,
        })
    }

    pub fn build(
        manifest: &RuntimeManifest,
        metadata: &ComponentMetadataManifest,
        target: &str,
        root: &Path,
    ) -> Result<Self> {
        manifest.validate()?;
        metadata.validate(target)?;
        let runtime = manifest.targets.get(target).ok_or_else(|| {
            DesktopError::RuntimeIntegrity(format!("target {target} is not defined"))
        })?;
        let expected_metadata_ids: HashSet<_> = runtime
            .components
            .iter()
            .map(|component| component.id.as_str())
            .collect();
        let metadata_by_id: HashMap<_, _> = metadata
            .components
            .iter()
            .map(|component| (component.id.as_str(), component))
            .collect();
        let metadata_ids: HashSet<_> = metadata_by_id.keys().copied().collect();
        if metadata_ids != expected_metadata_ids {
            return Err(DesktopError::RuntimeIntegrity(
                "component metadata does not cover the runtime manifest exactly".to_owned(),
            ));
        }
        let mut components = Vec::with_capacity(runtime.components.len());
        for component in &runtime.components {
            let metadata = metadata_by_id.get(component.id.as_str()).ok_or_else(|| {
                DesktopError::RuntimeIntegrity(format!(
                    "component {} has no source metadata",
                    component.id
                ))
            })?;
            let files = component
                .files()
                .map(|path| {
                    Ok(LockedFile {
                        path: path.clone(),
                        sha256: sha256_file(root, path)?,
                    })
                })
                .collect::<Result<_>>()?;
            components.push(LockedComponent {
                id: component.id.clone(),
                version: metadata.version.clone(),
                source: metadata.source.clone(),
                license: metadata.license.clone(),
                build_recipe: metadata.build_recipe.clone(),
                files,
            });
        }
        let lock = Self {
            schema_version: 2,
            target: target.to_owned(),
            components,
            sources: metadata.sources.clone(),
            inventory: inventory(root)?,
        };
        lock.validate_against(manifest, target)?;
        Ok(lock)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let bytes =
            serde_json::to_vec_pretty(self).map_err(|source| DesktopError::InvalidJson {
                path: path.to_owned(),
                source,
            })?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|source| DesktopError::WriteFile {
                path: parent.to_owned(),
                source,
            })?;
        }
        fs::write(path, bytes).map_err(|source| DesktopError::WriteFile {
            path: path.to_owned(),
            source,
        })
    }

    pub fn verify(&self, manifest: &RuntimeManifest, target: &str, root: &Path) -> Result<()> {
        self.validate_against(manifest, target)?;
        if self.inventory != inventory(root)? {
            return Err(DesktopError::RuntimeIntegrity(
                "runtime tree has changed: missing, added, or modified files or links".to_owned(),
            ));
        }
        let canonical_root = fs::canonicalize(root).map_err(|source| DesktopError::ReadFile {
            path: root.to_owned(),
            source,
        })?;
        for component in &self.components {
            for locked in &component.files {
                let path = root.join(&locked.path);
                let canonical_path =
                    fs::canonicalize(&path).map_err(|source| DesktopError::ReadFile {
                        path: path.clone(),
                        source,
                    })?;
                if !canonical_path.starts_with(&canonical_root) {
                    return Err(DesktopError::RuntimeIntegrity(format!(
                        "runtime file escapes the bundle: {}",
                        locked.path.display()
                    )));
                }
                let actual = sha256_file(root, &locked.path)?;
                if actual != locked.sha256 {
                    return Err(DesktopError::RuntimeIntegrity(format!(
                        "SHA-256 mismatch for {} in component {}",
                        locked.path.display(),
                        component.id
                    )));
                }
            }
        }
        Ok(())
    }

    fn validate_against(&self, manifest: &RuntimeManifest, target: &str) -> Result<()> {
        if self.schema_version != 2 {
            return Err(DesktopError::RuntimeIntegrity(format!(
                "unsupported runtime lock schema version {}",
                self.schema_version
            )));
        }
        if self.target != target {
            return Err(DesktopError::RuntimeIntegrity(format!(
                "runtime lock target {} does not match {target}",
                self.target
            )));
        }
        validate_sources(&self.sources)?;
        let runtime = manifest.targets.get(target).ok_or_else(|| {
            DesktopError::RuntimeIntegrity(format!("target {target} is not defined"))
        })?;
        let expected: BTreeMap<_, _> = runtime
            .components
            .iter()
            .map(|component| (component.id.as_str(), expected_files(component)))
            .collect();
        let mut seen_components = HashSet::new();
        for component in &self.components {
            validate_metadata(
                &component.id,
                &component.version,
                &component.source,
                &component.license,
                &component.build_recipe,
            )?;
            if !seen_components.insert(component.id.as_str()) {
                return Err(DesktopError::RuntimeIntegrity(format!(
                    "runtime lock repeats component {}",
                    component.id
                )));
            }
            let expected_files = expected.get(component.id.as_str()).ok_or_else(|| {
                DesktopError::RuntimeIntegrity(format!(
                    "runtime lock contains unknown component {}",
                    component.id
                ))
            })?;
            let mut actual_files = HashSet::new();
            for file in &component.files {
                if !actual_files.insert(file.path.clone()) {
                    return Err(DesktopError::RuntimeIntegrity(format!(
                        "component {} repeats {}",
                        component.id,
                        file.path.display()
                    )));
                }
                validate_sha256(&file.sha256)?;
            }
            if &actual_files != expected_files {
                return Err(DesktopError::RuntimeIntegrity(format!(
                    "component {} file list does not match the runtime manifest",
                    component.id
                )));
            }
        }
        let expected_components: HashSet<_> = expected.keys().copied().collect();
        if seen_components != expected_components {
            return Err(DesktopError::RuntimeIntegrity(
                "runtime lock does not cover every component".to_owned(),
            ));
        }
        Ok(())
    }
}

fn inventory(root: &Path) -> Result<Vec<InventoryEntry>> {
    fn walk(root: &Path, directory: &Path, entries: &mut Vec<InventoryEntry>) -> Result<()> {
        let children = fs::read_dir(directory).map_err(|source| DesktopError::ReadFile {
            path: directory.to_owned(),
            source,
        })?;
        for child in children {
            let child = child.map_err(|source| DesktopError::ReadFile {
                path: directory.to_owned(),
                source,
            })?;
            let path = child.path();
            let relative = path
                .strip_prefix(root)
                .expect("walk stays within root")
                .to_owned();
            if relative == Path::new(RUNTIME_LOCK_FILE) {
                continue;
            }
            let metadata =
                fs::symlink_metadata(&path).map_err(|source| DesktopError::ReadFile {
                    path: path.clone(),
                    source,
                })?;
            if metadata.file_type().is_symlink() {
                let target = fs::read_link(&path).map_err(|source| DesktopError::ReadFile {
                    path: path.clone(),
                    source,
                })?;
                let resolved =
                    fs::canonicalize(&path).map_err(|source| DesktopError::ReadFile {
                        path: path.clone(),
                        source,
                    })?;
                if target.is_absolute() || !resolved.starts_with(root) {
                    return Err(DesktopError::RuntimeIntegrity(format!(
                        "runtime link escapes the bundle or is not relocatable: {}",
                        relative.display()
                    )));
                }
                entries.push(InventoryEntry {
                    path: relative,
                    sha256: String::new(),
                    link_target: Some(target),
                });
            } else if metadata.is_dir() {
                walk(root, &path, entries)?;
            } else if metadata.is_file() {
                entries.push(InventoryEntry {
                    sha256: sha256_file(root, &relative)?,
                    path: relative,
                    link_target: None,
                });
            } else {
                return Err(DesktopError::RuntimeIntegrity(format!(
                    "unsupported runtime entry: {}",
                    relative.display()
                )));
            }
        }
        Ok(())
    }
    let root = fs::canonicalize(root).map_err(|source| DesktopError::ReadFile {
        path: root.to_owned(),
        source,
    })?;
    let mut entries = Vec::new();
    walk(&root, &root, &mut entries)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

impl ComponentMetadataManifest {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path).map_err(|source| DesktopError::ReadFile {
            path: path.to_owned(),
            source,
        })?;
        serde_json::from_slice(&bytes).map_err(|source| DesktopError::InvalidJson {
            path: path.to_owned(),
            source,
        })
    }

    fn validate(&self, target: &str) -> Result<()> {
        if self.schema_version != 1 || self.target != target {
            return Err(DesktopError::RuntimeIntegrity(format!(
                "component metadata does not match target {target}"
            )));
        }
        let mut ids = HashSet::new();
        for component in &self.components {
            validate_metadata(
                &component.id,
                &component.version,
                &component.source,
                &component.license,
                &component.build_recipe,
            )?;
            if !ids.insert(component.id.as_str()) {
                return Err(DesktopError::RuntimeIntegrity(format!(
                    "component metadata repeats {}",
                    component.id
                )));
            }
        }
        validate_sources(&self.sources)?;
        Ok(())
    }
}

fn validate_sources(sources: &[SourceArtifact]) -> Result<()> {
    if sources.is_empty() {
        return Err(DesktopError::RuntimeIntegrity(
            "runtime source inventory is empty".to_owned(),
        ));
    }
    let mut ids = HashSet::new();
    for source in sources {
        validate_metadata(
            &source.id,
            &source.version,
            &source.source,
            &source.license,
            &source.build_recipe,
        )?;
        validate_sha256(&source.sha256)?;
        if !ids.insert(source.id.as_str()) {
            return Err(DesktopError::RuntimeIntegrity(format!(
                "runtime source inventory repeats {}",
                source.id
            )));
        }
    }
    Ok(())
}

fn expected_files(component: &RuntimeComponent) -> HashSet<PathBuf> {
    component.files().cloned().collect()
}

fn validate_metadata(
    id: &str,
    version: &str,
    source: &str,
    license: &str,
    recipe: &str,
) -> Result<()> {
    if [id, version, source, license, recipe]
        .iter()
        .any(|value| value.trim().is_empty())
    {
        return Err(DesktopError::RuntimeIntegrity(format!(
            "component {id:?} has incomplete source metadata"
        )));
    }
    if !(source.starts_with("https://") || source.starts_with("git+https://")) {
        return Err(DesktopError::RuntimeIntegrity(format!(
            "component {id} source must use HTTPS"
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(DesktopError::RuntimeIntegrity(format!(
            "invalid SHA-256 value {value:?}"
        )));
    }
    Ok(())
}

fn sha256_file(root: &Path, relative: &Path) -> Result<String> {
    let path = root.join(relative);
    let file = File::open(&path).map_err(|source| DesktopError::ReadFile {
        path: path.clone(),
        source,
    })?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|source| DesktopError::ReadFile {
                path: path.clone(),
                source,
            })?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let mut result = String::with_capacity(64);
    for byte in digest.finalize() {
        write!(result, "{byte:02x}").expect("writing to a string cannot fail");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_manifest::{RuntimeComponent, TargetRuntime};

    fn fixture() -> (
        tempfile::TempDir,
        RuntimeManifest,
        ComponentMetadataManifest,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        fs::write(temporary.path().join("runtime"), b"runtime contents").unwrap();
        let manifest = RuntimeManifest {
            schema_version: 1,
            targets: HashMap::from([(
                "test".to_owned(),
                TargetRuntime {
                    components: vec![RuntimeComponent {
                        id: "service".to_owned(),
                        executable: "runtime".into(),
                        required_files: Vec::new(),
                        depends_on: Vec::new(),
                    }],
                },
            )]),
        };
        let metadata = ComponentMetadataManifest {
            schema_version: 1,
            target: "test".to_owned(),
            components: vec![ComponentMetadata {
                id: "service".to_owned(),
                version: "1.0.0".to_owned(),
                source: "https://example.com/service.tar.gz".to_owned(),
                license: "MPL-2.0".to_owned(),
                build_recipe: "scripts/build-service".to_owned(),
            }],
            sources: vec![SourceArtifact {
                id: "runtime-archive".to_owned(),
                version: "1.0.0".to_owned(),
                source: "https://example.com/runtime.tar.gz".to_owned(),
                license: "MPL-2.0".to_owned(),
                sha256: "11".repeat(32),
                build_recipe: "scripts/build-runtime".to_owned(),
            }],
        };
        (temporary, manifest, metadata)
    }

    #[test]
    fn builds_and_verifies_a_complete_runtime_lock() {
        let (temporary, manifest, metadata) = fixture();

        let lock = RuntimeLock::build(&manifest, &metadata, "test", temporary.path()).unwrap();

        lock.verify(&manifest, "test", temporary.path()).unwrap();
        assert_eq!(lock.components[0].files[0].sha256.len(), 64);
    }

    #[test]
    fn rejects_a_changed_runtime_file() {
        let (temporary, manifest, metadata) = fixture();
        let lock = RuntimeLock::build(&manifest, &metadata, "test", temporary.path()).unwrap();
        fs::write(temporary.path().join("runtime"), b"changed").unwrap();

        let error = lock
            .verify(&manifest, "test", temporary.path())
            .unwrap_err();

        assert!(error.to_string().contains("runtime tree has changed"));
    }

    #[test]
    fn rejects_incomplete_component_metadata() {
        let (temporary, manifest, mut metadata) = fixture();
        metadata.components[0].license.clear();

        let error = RuntimeLock::build(&manifest, &metadata, "test", temporary.path()).unwrap_err();

        assert!(error.to_string().contains("incomplete source metadata"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_runtime_symlink_that_escapes_the_bundle() {
        use std::os::unix::fs::symlink;

        let (temporary, manifest, metadata) = fixture();
        let lock = RuntimeLock::build(&manifest, &metadata, "test", temporary.path()).unwrap();
        fs::remove_file(temporary.path().join("runtime")).unwrap();
        symlink("/etc/hosts", temporary.path().join("runtime")).unwrap();

        let error = lock
            .verify(&manifest, "test", temporary.path())
            .unwrap_err();

        assert!(error.to_string().contains("escapes the bundle"));
    }

    #[test]
    fn rejects_extra_component_metadata() {
        let (temporary, manifest, mut metadata) = fixture();
        metadata.components.push(ComponentMetadata {
            id: "not-bundled".to_owned(),
            version: "1.0.0".to_owned(),
            source: "https://example.com/not-bundled.tar.gz".to_owned(),
            license: "MPL-2.0".to_owned(),
            build_recipe: "scripts/build-not-bundled".to_owned(),
        });

        let error = RuntimeLock::build(&manifest, &metadata, "test", temporary.path()).unwrap_err();

        assert!(error.to_string().contains("exactly"));
    }

    #[test]
    fn detects_dependency_changes_outside_the_entry_file_manifest() {
        let (temporary, manifest, metadata) = fixture();
        let module = temporary.path().join("native-library.dylib");
        fs::write(&module, b"original").unwrap();
        let lock = RuntimeLock::build(&manifest, &metadata, "test", temporary.path()).unwrap();
        lock.save(&temporary.path().join(RUNTIME_LOCK_FILE))
            .unwrap();
        lock.verify(&manifest, "test", temporary.path()).unwrap();
        fs::write(&module, b"changed").unwrap();
        assert!(lock.verify(&manifest, "test", temporary.path()).is_err());
    }

    #[test]
    fn rejects_added_and_removed_dependency_files() {
        let (temporary, manifest, metadata) = fixture();
        let lock = RuntimeLock::build(&manifest, &metadata, "test", temporary.path()).unwrap();
        let module = temporary.path().join("extra.js");
        fs::write(&module, b"module").unwrap();
        assert!(lock.verify(&manifest, "test", temporary.path()).is_err());
        let expanded = RuntimeLock::build(&manifest, &metadata, "test", temporary.path()).unwrap();
        fs::remove_file(&module).unwrap();
        assert!(
            expanded
                .verify(&manifest, "test", temporary.path())
                .is_err()
        );
        lock.verify(&manifest, "test", temporary.path()).unwrap();
    }
}
