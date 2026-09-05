use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use url::Url;

use crate::error::{DesktopError, Result};
use crate::paths::InstancePaths;
use crate::runtime_manifest::{RuntimeComponent, RuntimeManifest};
use crate::supervisor::{CommandSpec, ProcessSpec};

const LOOPBACK: &str = "127.0.0.1";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimePorts {
    pub postgres: u16,
    pub cache: u16,
    pub media_processor: u16,
    pub backend: u16,
    pub exporter: u16,
}

pub struct RuntimeSecrets<'a> {
    pub database_password: &'a str,
    pub cache_password: &'a str,
    pub penpot_secret: &'a str,
    pub media_processor_key: &'a str,
    pub exporter_key: &'a str,
}

pub struct LocalStackConfig<'a> {
    pub target: &'a str,
    pub runtime_root: &'a Path,
    pub paths: &'a InstancePaths,
    pub ports: RuntimePorts,
    pub secrets: RuntimeSecrets<'a>,
    pub public_origin: &'a str,
    pub administrator_email: &'a str,
}

pub fn process_specs(
    manifest: &RuntimeManifest,
    config: &LocalStackConfig<'_>,
) -> Result<Vec<ProcessSpec>> {
    validate(config)?;
    let runtime = manifest.targets.get(config.target).ok_or_else(|| {
        DesktopError::InvalidManifest(format!("target {} is not defined", config.target))
    })?;
    let components: HashMap<_, _> = runtime
        .components
        .iter()
        .map(|component| (component.id.as_str(), component))
        .collect();

    let mut specs = HashMap::from([
        (
            "postgres",
            postgres(component(&components, "postgres")?, config)?,
        ),
        ("cache", cache(component(&components, "cache")?, config)?),
        (
            "media-processor",
            media_processor(component(&components, "media-processor")?, config),
        ),
        (
            "backend",
            backend(component(&components, "backend")?, config)?,
        ),
        (
            "exporter",
            exporter(component(&components, "exporter")?, config)?,
        ),
    ]);
    runtime
        .startup_order()?
        .into_iter()
        .map(|component| {
            specs.remove(component.id.as_str()).ok_or_else(|| {
                DesktopError::InvalidManifest(format!(
                    "runtime component {} has no desktop process specification",
                    component.id
                ))
            })
        })
        .collect()
}

fn validate(config: &LocalStackConfig<'_>) -> Result<()> {
    if !config.runtime_root.is_absolute() || !config.paths.root.is_absolute() {
        return Err(DesktopError::Process(
            "runtime and instance roots must be absolute".to_owned(),
        ));
    }
    let origin = Url::parse(config.public_origin)
        .map_err(|error| DesktopError::Process(format!("invalid public origin: {error}")))?;
    if origin.scheme() != "http"
        || origin.host_str() != Some("localhost")
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return Err(DesktopError::Process(
            "public origin must be an HTTP localhost origin".to_owned(),
        ));
    }
    if [
        config.ports.postgres,
        config.ports.cache,
        config.ports.media_processor,
        config.ports.backend,
        config.ports.exporter,
    ]
    .contains(&0)
    {
        return Err(DesktopError::Process(
            "internal service ports must be non-zero".to_owned(),
        ));
    }
    if config.administrator_email.trim().is_empty() {
        return Err(DesktopError::Process(
            "standalone administrator email must not be empty".to_owned(),
        ));
    }
    for (name, value) in [
        ("database password", config.secrets.database_password),
        ("cache password", config.secrets.cache_password),
        ("Penpot secret", config.secrets.penpot_secret),
        ("media processor key", config.secrets.media_processor_key),
        ("exporter key", config.secrets.exporter_key),
    ] {
        if value.is_empty() {
            return Err(DesktopError::Process(format!("{name} must not be empty")));
        }
    }
    Ok(())
}

fn component<'a>(
    components: &HashMap<&str, &'a RuntimeComponent>,
    id: &str,
) -> Result<&'a RuntimeComponent> {
    components.get(id).copied().ok_or_else(|| {
        DesktopError::InvalidManifest(format!("runtime component {id} is not defined"))
    })
}

fn postgres(component: &RuntimeComponent, config: &LocalStackConfig<'_>) -> Result<ProcessSpec> {
    let executable = runtime_file(config, &component.executable);
    let pg_ctl = component
        .required_files
        .iter()
        .find(|path| file_stem(path) == Some("pg_ctl"))
        .map(|path| runtime_file(config, path))
        .ok_or_else(|| {
            DesktopError::InvalidManifest("postgres does not declare pg_ctl".to_owned())
        })?;
    let database = display(&config.paths.database);
    let working_directory = config.paths.root.clone();
    let mut arguments = vec![
        "-D".to_owned(),
        database.clone(),
        "-h".to_owned(),
        LOOPBACK.to_owned(),
        "-p".to_owned(),
        config.ports.postgres.to_string(),
    ];
    if config.target == "aarch64-apple-darwin" {
        arguments.extend(["-k".to_owned(), display(&config.paths.run)]);
    }
    Ok(ProcessSpec {
        id: "postgres".to_owned(),
        command: CommandSpec {
            executable,
            arguments,
            environment: BTreeMap::new(),
            working_directory: working_directory.clone(),
        },
        graceful_shutdown: Some(CommandSpec {
            executable: pg_ctl,
            arguments: vec![
                "-D".to_owned(),
                database,
                "-m".to_owned(),
                "fast".to_owned(),
                "-w".to_owned(),
                "stop".to_owned(),
            ],
            environment: BTreeMap::new(),
            working_directory,
        }),
    })
}

fn cache(component: &RuntimeComponent, config: &LocalStackConfig<'_>) -> Result<ProcessSpec> {
    let arguments = match config.target {
        "aarch64-apple-darwin" => vec![display(&config.paths.run.join("valkey.conf"))],
        "x86_64-pc-windows-msvc" => vec![
            "--lua".to_owned(),
            "--config-import-path".to_owned(),
            display(&config.paths.run.join("garnet.json")),
        ],
        target => {
            return Err(DesktopError::InvalidManifest(format!(
                "unsupported cache target {target}"
            )));
        }
    };
    Ok(spec(
        "cache",
        runtime_file(config, &component.executable),
        arguments,
        BTreeMap::new(),
        config.paths.root.clone(),
    ))
}

fn media_processor(component: &RuntimeComponent, config: &LocalStackConfig<'_>) -> ProcessSpec {
    spec(
        "media-processor",
        runtime_file(config, &component.executable),
        vec![display(
            &config.runtime_root.join("media-processor/index.js"),
        )],
        BTreeMap::from([
            (
                "PENPOT_MEDIA_PROCESSOR_HOST".to_owned(),
                LOOPBACK.to_owned(),
            ),
            (
                "PENPOT_MEDIA_PROCESSOR_PORT".to_owned(),
                config.ports.media_processor.to_string(),
            ),
            (
                "PENPOT_MEDIA_PROCESSOR_SHARED_KEY".to_owned(),
                config.secrets.media_processor_key.to_owned(),
            ),
            (
                "PENPOT_MEDIA_PROCESSOR_LOG_LEVEL".to_owned(),
                "info".to_owned(),
            ),
            ("TMPDIR".to_owned(), display(&config.paths.temporary)),
            ("PATH".to_owned(), bundled_tool_path(config)),
        ]),
        config.paths.root.clone(),
    )
}

fn backend(component: &RuntimeComponent, config: &LocalStackConfig<'_>) -> Result<ProcessSpec> {
    let cache_uri = cache_uri(config)?;
    Ok(spec(
        "backend",
        runtime_file(config, &component.executable),
        vec![
            "--enable-preview".to_owned(),
            "-jar".to_owned(),
            display(&config.runtime_root.join("backend/penpot.jar")),
            "-m".to_owned(),
            "app.main".to_owned(),
        ],
        BTreeMap::from([
            (
                "PENPOT_DATABASE_URI".to_owned(),
                format!("postgresql://{LOOPBACK}:{}/penpot", config.ports.postgres),
            ),
            ("PENPOT_DATABASE_USERNAME".to_owned(), "penpot".to_owned()),
            (
                "PENPOT_DATABASE_PASSWORD".to_owned(),
                config.secrets.database_password.to_owned(),
            ),
            ("PENPOT_REDIS_URI".to_owned(), cache_uri),
            ("PENPOT_HTTP_SERVER_HOST".to_owned(), LOOPBACK.to_owned()),
            (
                "PENPOT_HTTP_SERVER_PORT".to_owned(),
                config.ports.backend.to_string(),
            ),
            (
                "PENPOT_PUBLIC_URI".to_owned(),
                config.public_origin.to_owned(),
            ),
            ("PENPOT_STANDALONE_ENABLED".to_owned(), "true".to_owned()),
            (
                "PENPOT_STANDALONE_ADMIN_EMAIL".to_owned(),
                config.administrator_email.to_owned(),
            ),
            (
                "PENPOT_SECRET_KEY".to_owned(),
                config.secrets.penpot_secret.to_owned(),
            ),
            (
                "PENPOT_MEDIA_PROCESSING_SERVICE_URI".to_owned(),
                format!("http://{LOOPBACK}:{}", config.ports.media_processor),
            ),
            (
                "PENPOT_MEDIA_PROCESSOR_SHARED_KEY".to_owned(),
                config.secrets.media_processor_key.to_owned(),
            ),
            (
                "PENPOT_EXPORTER_SHARED_KEY".to_owned(),
                config.secrets.exporter_key.to_owned(),
            ),
            ("PENPOT_OBJECTS_STORAGE_BACKEND".to_owned(), "fs".to_owned()),
            (
                "PENPOT_OBJECTS_STORAGE_FS_DIRECTORY".to_owned(),
                display(&config.paths.assets),
            ),
            ("PENPOT_TELEMETRY_ENABLED".to_owned(), "false".to_owned()),
            (
                "PENPOT_FLAGS".to_owned(),
                "disable-email-verification disable-smtp".to_owned(),
            ),
        ]),
        config.paths.root.clone(),
    ))
}

fn exporter(component: &RuntimeComponent, config: &LocalStackConfig<'_>) -> Result<ProcessSpec> {
    let chromium = component
        .required_files
        .iter()
        .find(|path| path.to_string_lossy().contains("chromium/"))
        .ok_or_else(|| {
            DesktopError::InvalidManifest("exporter does not declare Chromium".to_owned())
        })?;
    Ok(spec(
        "exporter",
        runtime_file(config, &component.executable),
        vec![display(&config.runtime_root.join("exporter/app.js"))],
        BTreeMap::from([
            ("PENPOT_HTTP_SERVER_HOST".to_owned(), LOOPBACK.to_owned()),
            (
                "PENPOT_HTTP_SERVER_PORT".to_owned(),
                config.ports.exporter.to_string(),
            ),
            (
                "PENPOT_PUBLIC_URI".to_owned(),
                config.public_origin.to_owned(),
            ),
            (
                "PENPOT_INTERNAL_URI".to_owned(),
                format!("http://{LOOPBACK}:{}", config.ports.backend),
            ),
            ("PENPOT_REDIS_URI".to_owned(), cache_uri(config)?),
            (
                "PENPOT_SECRET_KEY".to_owned(),
                config.secrets.penpot_secret.to_owned(),
            ),
            (
                "PENPOT_EXPORTER_SHARED_KEY".to_owned(),
                config.secrets.exporter_key.to_owned(),
            ),
            (
                "PENPOT_BROWSER_EXECUTABLE".to_owned(),
                display(&runtime_file(config, chromium)),
            ),
            (
                "PENPOT_TEMPDIR".to_owned(),
                display(&config.paths.temporary),
            ),
            ("PATH".to_owned(), bundled_tool_path(config)),
        ]),
        config.paths.root.clone(),
    ))
}

fn cache_uri(config: &LocalStackConfig<'_>) -> Result<String> {
    let mut uri = Url::parse(&format!("redis://{LOOPBACK}:{}/0", config.ports.cache))
        .expect("the fixed loopback cache URI must parse");
    uri.set_password(Some(config.secrets.cache_password))
        .map_err(|_| DesktopError::Process("cache password cannot be encoded".to_owned()))?;
    Ok(uri.into())
}

fn spec(
    id: &str,
    executable: PathBuf,
    arguments: Vec<String>,
    environment: BTreeMap<String, String>,
    working_directory: PathBuf,
) -> ProcessSpec {
    ProcessSpec {
        id: id.to_owned(),
        command: CommandSpec {
            executable,
            arguments,
            environment,
            working_directory,
        },
        graceful_shutdown: None,
    }
}

fn runtime_file(config: &LocalStackConfig<'_>, relative: &Path) -> PathBuf {
    config.runtime_root.join(relative)
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn bundled_tool_path(config: &LocalStackConfig<'_>) -> String {
    let directory = if config.target == "x86_64-pc-windows-msvc" {
        "tools"
    } else {
        "tools/bin"
    };
    display(&config.runtime_root.join(directory))
}

fn file_stem(path: &Path) -> Option<&str> {
    path.file_stem().and_then(|value| value.to_str())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::runtime_manifest::{RuntimeComponent, TargetRuntime};

    fn component(id: &str, executable: &str, required_files: &[&str]) -> RuntimeComponent {
        RuntimeComponent {
            id: id.to_owned(),
            executable: executable.into(),
            required_files: required_files.iter().map(PathBuf::from).collect(),
            depends_on: Vec::new(),
        }
    }

    fn manifest() -> RuntimeManifest {
        RuntimeManifest {
            schema_version: 1,
            targets: HashMap::from([(
                "aarch64-apple-darwin".to_owned(),
                TargetRuntime {
                    components: vec![
                        component(
                            "postgres",
                            "postgres/bin/postgres",
                            &["postgres/bin/pg_ctl"],
                        ),
                        component("cache", "valkey/bin/valkey-server", &[]),
                        component("media-processor", "node/bin/node", &[]),
                        component("backend", "jre/bin/java", &[]),
                        component(
                            "exporter",
                            "node/bin/node",
                            &["chromium/Chromium.app/Contents/MacOS/Chromium"],
                        ),
                    ],
                },
            )]),
        }
    }

    fn windows_manifest() -> RuntimeManifest {
        RuntimeManifest {
            schema_version: 1,
            targets: HashMap::from([(
                "x86_64-pc-windows-msvc".to_owned(),
                TargetRuntime {
                    components: vec![
                        component(
                            "postgres",
                            "postgres/bin/postgres.exe",
                            &["postgres/bin/pg_ctl.exe"],
                        ),
                        component("cache", "garnet/GarnetServer.exe", &[]),
                        component("media-processor", "node/node.exe", &[]),
                        component("backend", "jre/bin/java.exe", &[]),
                        component("exporter", "node/node.exe", &["chromium/chrome.exe"]),
                    ],
                },
            )]),
        }
    }

    fn config<'a>(runtime_root: &'a Path, paths: &'a InstancePaths) -> LocalStackConfig<'a> {
        LocalStackConfig {
            target: "aarch64-apple-darwin",
            runtime_root,
            paths,
            ports: RuntimePorts {
                postgres: 41001,
                cache: 41002,
                media_processor: 41003,
                backend: 41004,
                exporter: 41005,
            },
            secrets: RuntimeSecrets {
                database_password: "database secret",
                cache_password: "cache:/?# secret",
                penpot_secret: "penpot secret",
                media_processor_key: "media secret",
                exporter_key: "exporter secret",
            },
            public_origin: "http://localhost:9001",
            administrator_email: "admin@example.com",
        }
    }

    #[test]
    fn generates_loopback_only_specs_with_absolute_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime_root = temporary.path().join("runtime");
        let paths = InstancePaths::from_root(temporary.path().join("instance"));
        fs::create_dir_all(&runtime_root).unwrap();
        paths.create().unwrap();

        let specs = process_specs(&manifest(), &config(&runtime_root, &paths)).unwrap();

        assert_eq!(
            specs
                .iter()
                .map(|spec| spec.id.as_str())
                .collect::<Vec<_>>(),
            [
                "postgres",
                "cache",
                "media-processor",
                "backend",
                "exporter"
            ]
        );
        assert!(
            specs
                .iter()
                .all(|spec| spec.command.executable.is_absolute())
        );
        assert!(specs.iter().all(|spec| {
            !spec
                .command
                .arguments
                .iter()
                .any(|argument| argument == "0.0.0.0")
                && !spec
                    .command
                    .environment
                    .values()
                    .any(|value| value == "0.0.0.0")
        }));
        let postgres = &specs[0];
        assert!(postgres.graceful_shutdown.is_some());
        let backend = &specs[3];
        assert_eq!(
            backend.command.environment["PENPOT_PUBLIC_URI"],
            "http://localhost:9001"
        );
        assert_eq!(
            backend.command.environment["PENPOT_EXPORTER_SHARED_KEY"],
            "exporter secret"
        );
        assert_eq!(
            backend.command.environment["PENPOT_STANDALONE_ADMIN_EMAIL"],
            "admin@example.com"
        );
        assert_eq!(
            specs[1].command.arguments,
            [paths.run.join("valkey.conf").to_string_lossy().into_owned()]
        );
        assert_eq!(
            backend.command.environment["PENPOT_REDIS_URI"],
            "redis://:cache%3A%2F%3F%23%20secret@127.0.0.1:41002/0"
        );
    }

    #[test]
    fn rejects_non_local_public_origins() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime_root = temporary.path().join("runtime");
        let paths = InstancePaths::from_root(temporary.path().join("instance"));
        let mut config = config(&runtime_root, &paths);
        config.public_origin = "http://example.com";

        assert!(process_specs(&manifest(), &config).is_err());
    }

    #[test]
    fn generates_windows_specific_postgres_and_garnet_arguments() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime_root = temporary.path().join("runtime");
        let paths = InstancePaths::from_root(temporary.path().join("instance"));
        let mut config = config(&runtime_root, &paths);
        config.target = "x86_64-pc-windows-msvc";

        let specs = process_specs(&windows_manifest(), &config).unwrap();

        assert!(!specs[0].command.arguments.iter().any(|value| value == "-k"));
        assert!(specs[1].command.arguments.windows(2).any(|values| {
            values[0] == "--config-import-path" && values[1].ends_with("garnet.json")
        }));
        assert!(
            specs[1]
                .command
                .arguments
                .iter()
                .any(|value| value == "--lua")
        );
        assert!(
            !specs[1]
                .command
                .arguments
                .iter()
                .any(|value| value == config.secrets.cache_password)
        );
    }

    #[test]
    fn rejects_missing_secrets() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime_root = temporary.path().join("runtime");
        let paths = InstancePaths::from_root(temporary.path().join("instance"));
        let mut config = config(&runtime_root, &paths);
        config.secrets.penpot_secret = "";

        assert!(process_specs(&manifest(), &config).is_err());
    }

    #[test]
    fn rejects_postgres_without_a_graceful_shutdown_tool() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime_root = temporary.path().join("runtime");
        let paths = InstancePaths::from_root(temporary.path().join("instance"));
        let mut manifest = manifest();
        manifest
            .targets
            .get_mut("aarch64-apple-darwin")
            .unwrap()
            .components[0]
            .required_files
            .clear();

        assert!(process_specs(&manifest, &config(&runtime_root, &paths)).is_err());
    }
}
