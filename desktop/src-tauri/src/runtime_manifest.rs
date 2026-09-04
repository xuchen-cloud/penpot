use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{DesktopError, Result};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub targets: HashMap<String, TargetRuntime>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRuntime {
    pub components: Vec<RuntimeComponent>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeComponent {
    pub id: String,
    pub executable: PathBuf,
    #[serde(default)]
    pub required_files: Vec<PathBuf>,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

impl RuntimeManifest {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1 {
            return Err(DesktopError::InvalidManifest(format!(
                "unsupported schema version {}",
                self.schema_version
            )));
        }
        for (target, runtime) in &self.targets {
            runtime.validate(target)?;
        }
        Ok(())
    }

    pub fn verify_bundle(&self, target: &str, root: &Path) -> Result<()> {
        let runtime = self.targets.get(target).ok_or_else(|| {
            DesktopError::InvalidManifest(format!("target {target} is not defined"))
        })?;
        for component in &runtime.components {
            for relative in std::iter::once(&component.executable).chain(&component.required_files)
            {
                let path = root.join(relative);
                if !path.is_file() {
                    return Err(DesktopError::MissingRuntime(format!(
                        "{} requires {}",
                        component.id,
                        path.display()
                    )));
                }
            }
        }
        Ok(())
    }
}

impl TargetRuntime {
    fn validate(&self, target: &str) -> Result<()> {
        let mut ids = HashSet::new();
        for component in &self.components {
            if component.id.trim().is_empty() {
                return Err(DesktopError::InvalidManifest(format!(
                    "target {target} contains an empty component id"
                )));
            }
            if !ids.insert(component.id.as_str()) {
                return Err(DesktopError::InvalidManifest(format!(
                    "target {target} repeats component {}",
                    component.id
                )));
            }
            validate_relative_path(&component.executable)?;
            for path in &component.required_files {
                validate_relative_path(path)?;
            }
        }
        for component in &self.components {
            for dependency in &component.depends_on {
                if !ids.contains(dependency.as_str()) {
                    return Err(DesktopError::InvalidManifest(format!(
                        "component {} depends on unknown component {dependency}",
                        component.id
                    )));
                }
                if dependency == &component.id {
                    return Err(DesktopError::InvalidManifest(format!(
                        "component {} depends on itself",
                        component.id
                    )));
                }
            }
        }
        detect_dependency_cycles(&self.components)
    }

    pub fn startup_order(&self) -> Result<Vec<&RuntimeComponent>> {
        self.validate("selected target")?;
        let by_id: HashMap<_, _> = self
            .components
            .iter()
            .map(|component| (component.id.as_str(), component))
            .collect();
        let mut ordered = Vec::with_capacity(self.components.len());
        let mut visited = HashSet::new();

        fn add<'a>(
            component: &'a RuntimeComponent,
            by_id: &HashMap<&str, &'a RuntimeComponent>,
            visited: &mut HashSet<&'a str>,
            ordered: &mut Vec<&'a RuntimeComponent>,
        ) {
            if !visited.insert(component.id.as_str()) {
                return;
            }
            for dependency in &component.depends_on {
                add(by_id[dependency.as_str()], by_id, visited, ordered);
            }
            ordered.push(component);
        }

        for component in &self.components {
            add(component, &by_id, &mut visited, &mut ordered);
        }
        Ok(ordered)
    }
}

fn validate_relative_path(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(DesktopError::InvalidManifest(format!(
            "runtime path must be non-empty and relative: {}",
            path.display()
        )));
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(DesktopError::InvalidManifest(format!(
            "runtime path escapes its target directory: {}",
            path.display()
        )));
    }
    Ok(())
}

fn detect_dependency_cycles(components: &[RuntimeComponent]) -> Result<()> {
    fn visit<'a>(
        id: &'a str,
        components: &HashMap<&'a str, &'a RuntimeComponent>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> Result<()> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            return Err(DesktopError::InvalidManifest(format!(
                "runtime dependency cycle includes {id}"
            )));
        }
        let component = components[id];
        for dependency in &component.depends_on {
            visit(dependency, components, visiting, visited)?;
        }
        visiting.remove(id);
        visited.insert(id);
        Ok(())
    }

    let by_id: HashMap<_, _> = components
        .iter()
        .map(|component| (component.id.as_str(), component))
        .collect();
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for id in by_id.keys() {
        visit(id, &by_id, &mut visiting, &mut visited)?;
    }
    Ok(())
}

pub fn current_target() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        (os, architecture) => Err(DesktopError::InvalidManifest(format!(
            "unsupported desktop target {architecture}-{os}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn component(id: &str, executable: &str, dependencies: &[&str]) -> RuntimeComponent {
        RuntimeComponent {
            id: id.to_owned(),
            executable: executable.into(),
            required_files: Vec::new(),
            depends_on: dependencies
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
        }
    }

    #[test]
    fn rejects_paths_that_escape_the_runtime_bundle() {
        let error = validate_relative_path(Path::new("../secrets")).unwrap_err();
        assert!(error.to_string().contains("escapes"));
    }

    #[test]
    fn rejects_unknown_dependencies() {
        let runtime = TargetRuntime {
            components: vec![component("backend", "backend.jar", &["postgres"])],
        };
        assert!(runtime.validate("test").is_err());
    }

    #[test]
    fn rejects_dependency_cycles() {
        let runtime = TargetRuntime {
            components: vec![
                component("backend", "backend.jar", &["cache"]),
                component("cache", "cache", &["backend"]),
            ],
        };
        assert!(runtime.validate("test").is_err());
    }

    #[test]
    fn reports_the_first_missing_runtime_file() {
        let temporary = tempfile::tempdir().unwrap();
        let manifest = RuntimeManifest {
            schema_version: 1,
            targets: HashMap::from([(
                "test".to_owned(),
                TargetRuntime {
                    components: vec![component("postgres", "postgres/bin/postgres", &[])],
                },
            )]),
        };

        let error = manifest
            .verify_bundle("test", temporary.path())
            .unwrap_err();
        assert!(error.to_string().contains("postgres/bin/postgres"));
    }

    #[test]
    fn orders_dependencies_before_the_services_that_use_them() {
        let runtime = TargetRuntime {
            components: vec![
                component("backend", "backend", &["postgres", "cache"]),
                component("exporter", "exporter", &["backend"]),
                component("cache", "cache", &[]),
                component("postgres", "postgres", &[]),
            ],
        };

        let ids: Vec<_> = runtime
            .startup_order()
            .unwrap()
            .into_iter()
            .map(|component| component.id.as_str())
            .collect();

        assert_eq!(ids, ["postgres", "cache", "backend", "exporter"]);
    }
}
