use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use crate::error::{DesktopError, Result};

const BUCKET_SCRIPT: &str = include_str!("../../../backend/src/app/rpc/rlimit/bucket.lua");
const WINDOW_SCRIPT: &str = include_str!("../../../backend/src/app/rpc/rlimit/window.lua");

const REQUIRED_CHECKS: &[&str] = &[
    "postgres.initialize",
    "postgres.migrate",
    "postgres.stop",
    "postgres.restart",
    "postgres.persistence",
    "cache.compatibility",
    "service.media-processor",
    "service.backend",
    "service.exporter",
    "chromium.offline",
    "export.png",
    "export.jpeg",
    "export.webp",
    "export.svg",
    "export.pdf",
    "font.ttf",
    "font.otf",
    "font.woff",
    "font.woff2",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityPlan {
    pub schema_version: u32,
    pub target: String,
    #[serde(default)]
    pub ports: Vec<String>,
    pub steps: Vec<PlanStep>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub id: String,
    #[serde(flatten)]
    pub action: StepAction,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum StepAction {
    Command {
        command: CommandDefinition,
        #[serde(default)]
        expected_artifacts: Vec<ArtifactExpectation>,
    },
    Start {
        process_id: String,
        command: CommandDefinition,
        ready: ReadyProbe,
    },
    Stop {
        process_id: String,
        command: Option<CommandDefinition>,
    },
    CacheCompatibility {
        port: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDefinition {
    pub executable: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default = "default_command_timeout")]
    pub timeout_seconds: u64,
    pub stdout_contains: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactExpectation {
    pub path: String,
    #[serde(default = "default_minimum_bytes")]
    pub minimum_bytes: u64,
    pub magic_hex: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyProbe {
    pub host: String,
    pub port: String,
    #[serde(default)]
    pub http_path: Option<String>,
    #[serde(default = "default_probe_timeout")]
    pub timeout_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityReport {
    pub schema_version: u32,
    pub target: String,
    pub started_at_unix_ms: u128,
    pub finished_at_unix_ms: u128,
    pub passed: bool,
    pub ports: BTreeMap<String, u16>,
    pub versions: BTreeMap<String, String>,
    pub checks: Vec<CheckReport>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    pub id: String,
    pub passed: bool,
    pub duration_ms: u128,
    pub command: Option<RecordedCommand>,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedCommand {
    pub executable: String,
    pub arguments: Vec<String>,
    pub working_directory: String,
}

struct RunningProcess {
    child: Child,
    stdout_path: PathBuf,
    stderr_path: PathBuf,
}

pub struct PlanRunner {
    runtime_root: PathBuf,
    work_root: PathBuf,
    ports: BTreeMap<String, u16>,
    processes: HashMap<String, RunningProcess>,
    checks: Vec<CheckReport>,
}

impl CompatibilityPlan {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path).map_err(|source| DesktopError::ReadFile {
            path: path.to_owned(),
            source,
        })?;
        let plan: Self =
            serde_json::from_slice(&bytes).map_err(|source| DesktopError::InvalidJson {
                path: path.to_owned(),
                source,
            })?;
        plan.validate()?;
        Ok(plan)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1 {
            return Err(DesktopError::Compatibility(format!(
                "unsupported compatibility plan schema version {}",
                self.schema_version
            )));
        }
        if self.target.trim().is_empty() {
            return Err(DesktopError::Compatibility(
                "compatibility plan target is empty".to_owned(),
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for step in &self.steps {
            if !ids.insert(step.id.as_str()) {
                return Err(DesktopError::Compatibility(format!(
                    "compatibility plan repeats check {}",
                    step.id
                )));
            }
        }
        let missing: Vec<_> = REQUIRED_CHECKS
            .iter()
            .filter(|id| !ids.contains(**id))
            .copied()
            .collect();
        if !missing.is_empty() {
            return Err(DesktopError::Compatibility(format!(
                "compatibility plan is missing required checks: {}",
                missing.join(", ")
            )));
        }
        for step in &self.steps {
            let valid_action = match step.id.as_str() {
                "postgres.initialize"
                | "postgres.migrate"
                | "postgres.persistence"
                | "chromium.offline"
                | "export.png"
                | "export.jpeg"
                | "export.webp"
                | "export.svg"
                | "export.pdf"
                | "font.ttf"
                | "font.otf"
                | "font.woff"
                | "font.woff2" => matches!(&step.action, StepAction::Command { .. }),
                "postgres.stop" => matches!(&step.action, StepAction::Stop { .. }),
                "postgres.restart"
                | "service.media-processor"
                | "service.backend"
                | "service.exporter" => matches!(&step.action, StepAction::Start { .. }),
                "cache.compatibility" => {
                    matches!(&step.action, StepAction::CacheCompatibility { .. })
                }
                _ => true,
            };
            if !valid_action {
                return Err(DesktopError::Compatibility(format!(
                    "required check {} uses the wrong action",
                    step.id
                )));
            }
        }
        let cache_start = self.steps.iter().find(|step| step.id == "cache.start");
        match (self.target.as_str(), cache_start.map(|step| &step.action)) {
            (
                "aarch64-apple-darwin",
                Some(StepAction::Start {
                    command: CommandDefinition { executable, .. },
                    ..
                }),
            ) if executable == "valkey/bin/valkey-server" => {}
            (
                "x86_64-pc-windows-msvc",
                Some(StepAction::Start {
                    command:
                        CommandDefinition {
                            executable,
                            arguments,
                            ..
                        },
                    ..
                }),
            ) if executable == "garnet/GarnetServer.exe"
                && arguments.iter().any(|argument| argument == "--lua") => {}
            ("aarch64-apple-darwin" | "x86_64-pc-windows-msvc", _) => {
                return Err(DesktopError::Compatibility(
                    "compatibility plan does not start the required platform cache".to_owned(),
                ));
            }
            _ => {}
        }
        Ok(())
    }
}

impl PlanRunner {
    pub fn new(runtime_root: PathBuf, work_root: PathBuf, port_names: &[String]) -> Result<Self> {
        if !runtime_root.is_dir() {
            return Err(DesktopError::Compatibility(format!(
                "runtime root does not exist: {}",
                runtime_root.display()
            )));
        }
        fs::create_dir_all(&work_root).map_err(|source| DesktopError::WriteFile {
            path: work_root.clone(),
            source,
        })?;
        for directory in ["artifacts", "assets", "cache", "logs", "run", "tmp"] {
            let path = work_root.join(directory);
            fs::create_dir_all(&path).map_err(|source| DesktopError::WriteFile { path, source })?;
        }
        let mut ports = BTreeMap::new();
        let mut reservations = Vec::new();
        for name in port_names {
            if ports.contains_key(name) {
                return Err(DesktopError::Compatibility(format!(
                    "port name {name} is repeated"
                )));
            }
            let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
            ports.insert(name.clone(), listener.local_addr()?.port());
            reservations.push(listener);
        }
        Ok(Self {
            runtime_root,
            work_root,
            ports,
            processes: HashMap::new(),
            checks: Vec::new(),
        })
    }

    pub fn run(mut self, plan: &CompatibilityPlan) -> CompatibilityReport {
        let started_at_unix_ms = unix_ms();
        for step in &plan.steps {
            let started = Instant::now();
            let result = self.run_step(step);
            let (passed, command, detail) = match result {
                Ok((command, detail)) => (true, command, detail),
                Err((command, detail)) => (false, command, detail),
            };
            self.checks.push(CheckReport {
                id: step.id.clone(),
                passed,
                duration_ms: started.elapsed().as_millis(),
                command,
                detail,
            });
            if !passed {
                break;
            }
        }
        self.stop_remaining();
        let passed =
            self.checks.len() == plan.steps.len() && self.checks.iter().all(|check| check.passed);
        let versions = self
            .checks
            .iter()
            .filter_map(|check| {
                check
                    .id
                    .strip_prefix("version.")
                    .filter(|_| check.passed)
                    .map(|component| (component.to_owned(), check.detail.clone()))
            })
            .collect();
        CompatibilityReport {
            schema_version: 1,
            target: plan.target.clone(),
            started_at_unix_ms,
            finished_at_unix_ms: unix_ms(),
            passed,
            ports: std::mem::take(&mut self.ports),
            versions,
            checks: std::mem::take(&mut self.checks),
        }
    }

    fn run_step(
        &mut self,
        step: &PlanStep,
    ) -> std::result::Result<(Option<RecordedCommand>, String), (Option<RecordedCommand>, String)>
    {
        match &step.action {
            StepAction::Command {
                command: definition,
                expected_artifacts,
            } => {
                let (mut command, recorded) = self
                    .prepare_command(definition)
                    .map_err(|error| (None, error.to_string()))?;
                let timeout = Duration::from_secs(definition.timeout_seconds);
                let output = run_to_completion(&mut command, timeout)
                    .map_err(|error| (Some(recorded.clone()), error))?;
                if let Some(expected) = &definition.stdout_contains
                    && !output.contains(expected)
                {
                    return Err((
                        Some(recorded),
                        format!("command output did not contain {expected:?}: {output}"),
                    ));
                }
                for artifact in expected_artifacts {
                    self.verify_artifact(artifact)
                        .map_err(|error| (Some(recorded.clone()), error.to_string()))?;
                }
                Ok((Some(recorded), output))
            }
            StepAction::Start {
                process_id,
                command,
                ready,
            } => {
                if self.processes.contains_key(process_id) {
                    return Err((None, format!("process {process_id} is already running")));
                }
                let (mut command, recorded) = self
                    .prepare_command(command)
                    .map_err(|error| (None, error.to_string()))?;
                let logs = self.work_root.join("logs");
                fs::create_dir_all(&logs)
                    .map_err(|error| (Some(recorded.clone()), error.to_string()))?;
                let stdout_path = logs.join(format!("{process_id}.stdout.log"));
                let stderr_path = logs.join(format!("{process_id}.stderr.log"));
                let stdout = fs::File::create(&stdout_path)
                    .map_err(|error| (Some(recorded.clone()), error.to_string()))?;
                let stderr = fs::File::create(&stderr_path)
                    .map_err(|error| (Some(recorded.clone()), error.to_string()))?;
                command
                    .stdout(Stdio::from(stdout))
                    .stderr(Stdio::from(stderr));
                let child = command
                    .spawn()
                    .map_err(|error| (Some(recorded.clone()), error.to_string()))?;
                self.processes.insert(
                    process_id.clone(),
                    RunningProcess {
                        child,
                        stdout_path,
                        stderr_path,
                    },
                );
                self.wait_until_ready(process_id, ready)
                    .map_err(|error| (Some(recorded.clone()), error))?;
                Ok((Some(recorded), format!("process {process_id} is ready")))
            }
            StepAction::Stop {
                process_id,
                command,
            } => {
                let recorded = if let Some(command) = command {
                    let (mut command, recorded) = self
                        .prepare_command(command)
                        .map_err(|error| (None, error.to_string()))?;
                    run_to_completion(&mut command, Duration::from_secs(30))
                        .map_err(|error| (Some(recorded.clone()), error))?;
                    Some(recorded)
                } else {
                    None
                };
                let mut process = self.processes.remove(process_id).ok_or_else(|| {
                    (
                        recorded.clone(),
                        format!("process {process_id} is not running"),
                    )
                })?;
                let forced = command.is_none();
                if forced {
                    process
                        .child
                        .kill()
                        .map_err(|error| (recorded.clone(), error.to_string()))?;
                }
                wait_for_exit(&mut process.child, Duration::from_secs(30), !forced)
                    .map_err(|error| (recorded.clone(), error))?;
                Ok((recorded, format!("process {process_id} stopped")))
            }
            StepAction::CacheCompatibility { port } => {
                let port = self
                    .ports
                    .get(port)
                    .copied()
                    .ok_or_else(|| (None, format!("unknown port name {port}")))?;
                let details = run_cache_compatibility("127.0.0.1", port)
                    .map_err(|error| (None, error.to_string()))?;
                Ok((None, details.join(", ")))
            }
        }
    }

    fn prepare_command(
        &self,
        definition: &CommandDefinition,
    ) -> Result<(Command, RecordedCommand)> {
        let executable = self.resolve_runtime_path(&definition.executable)?;
        if !executable.is_file() {
            return Err(DesktopError::Compatibility(format!(
                "command executable does not exist: {}",
                executable.display()
            )));
        }
        let working_directory = match &definition.working_directory {
            Some(path) => self.resolve_work_path(path)?,
            None => self.work_root.clone(),
        };
        fs::create_dir_all(&working_directory).map_err(|source| DesktopError::WriteFile {
            path: working_directory.clone(),
            source,
        })?;
        let arguments: Vec<_> = definition
            .arguments
            .iter()
            .map(|value| self.expand(value))
            .collect::<Result<_>>()?;
        let environment: BTreeMap<_, _> = definition
            .environment
            .iter()
            .map(|(key, value)| {
                let expanded = self.expand(value)?;
                let expanded = if key == "PENPOT_OBJECTS_STORAGE_FS_DIRECTORY" {
                    expanded.replace('\\', "/")
                } else {
                    expanded
                };
                Ok((key.clone(), expanded))
            })
            .collect::<Result<_>>()?;
        let mut command = Command::new(&executable);
        command
            .args(&arguments)
            .env_clear()
            .envs(&environment)
            .env("PATH", runtime_path_environment(&self.runtime_root))
            .current_dir(&working_directory)
            .stdin(Stdio::null());
        for name in [
            "ALLUSERSPROFILE",
            "APPDATA",
            "COMSPEC",
            "CommonProgramFiles",
            "CommonProgramFiles(x86)",
            "CommonProgramW6432",
            "HOMEDRIVE",
            "HOMEPATH",
            "LOCALAPPDATA",
            "OS",
            "PATHEXT",
            "ProgramData",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "SystemDrive",
            "SystemRoot",
            "TEMP",
            "TMP",
            "TMPDIR",
            "USERPROFILE",
            "windir",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let recorded = RecordedCommand {
            executable: executable.display().to_string(),
            arguments,
            working_directory: working_directory.display().to_string(),
        };
        Ok((command, recorded))
    }

    fn wait_until_ready(
        &mut self,
        process_id: &str,
        probe: &ReadyProbe,
    ) -> std::result::Result<(), String> {
        let port = self
            .ports
            .get(&probe.port)
            .copied()
            .ok_or_else(|| format!("unknown port name {}", probe.port))?;
        let deadline = Instant::now() + Duration::from_secs(probe.timeout_seconds);
        while Instant::now() < deadline {
            let process = self.processes.get_mut(process_id).unwrap();
            if let Some(status) = process
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
            {
                let stdout = fs::read_to_string(&process.stdout_path).unwrap_or_default();
                let stderr = fs::read_to_string(&process.stderr_path).unwrap_or_default();
                return Err(format!(
                    "process {process_id} exited before it was ready: {status}\nstdout: {}\nstderr: {}",
                    stdout.trim(),
                    stderr.trim()
                ));
            }
            let ready = if let Some(path) = &probe.http_path {
                http_probe(&probe.host, port, path).is_ok()
            } else {
                TcpStream::connect_timeout(
                    &format!("{}:{port}", probe.host)
                        .parse()
                        .map_err(|error| format!("invalid probe address: {error}"))?,
                    Duration::from_millis(250),
                )
                .is_ok()
            };
            if ready {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
        Err(format!(
            "process {process_id} did not become ready before the timeout"
        ))
    }

    fn verify_artifact(&self, expectation: &ArtifactExpectation) -> Result<()> {
        let path = self.resolve_work_path(&expectation.path)?;
        let bytes = fs::read(&path).map_err(|source| DesktopError::ReadFile {
            path: path.clone(),
            source,
        })?;
        if bytes.len() < expectation.minimum_bytes as usize {
            return Err(DesktopError::Compatibility(format!(
                "artifact {} contains {} bytes, expected at least {}",
                path.display(),
                bytes.len(),
                expectation.minimum_bytes
            )));
        }
        if let Some(magic) = &expectation.magic_hex {
            let expected = decode_hex(magic)?;
            if !bytes.starts_with(&expected) {
                return Err(DesktopError::Compatibility(format!(
                    "artifact {} has the wrong signature",
                    path.display()
                )));
            }
        }
        Ok(())
    }

    fn resolve_runtime_path(&self, value: &str) -> Result<PathBuf> {
        confined_join(&self.runtime_root, value)
    }

    fn resolve_work_path(&self, value: &str) -> Result<PathBuf> {
        confined_join(&self.work_root, &self.expand(value)?)
    }

    fn expand(&self, value: &str) -> Result<String> {
        let mut result = value
            .replace("{{runtime_root}}", &self.runtime_root.display().to_string())
            .replace("{{work_root}}", &self.work_root.display().to_string());
        while let Some(start) = result.find("{{port.") {
            let tail = &result[start + 7..];
            let end = tail.find("}}").ok_or_else(|| {
                DesktopError::Compatibility(format!("invalid placeholder in {value}"))
            })?;
            let name = &tail[..end];
            let port = self
                .ports
                .get(name)
                .ok_or_else(|| DesktopError::Compatibility(format!("unknown port name {name}")))?;
            result.replace_range(start..start + 7 + end + 2, &port.to_string());
        }
        if result.contains("{{") {
            return Err(DesktopError::Compatibility(format!(
                "unknown placeholder in {value}"
            )));
        }
        Ok(result)
    }

    fn stop_remaining(&mut self) {
        for (_, mut process) in self.processes.drain() {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }
}

impl Drop for PlanRunner {
    fn drop(&mut self) {
        self.stop_remaining();
    }
}

pub fn write_report(path: &Path, report: &CompatibilityReport) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| DesktopError::WriteFile {
            path: parent.to_owned(),
            source,
        })?;
    }
    let bytes = serde_json::to_vec_pretty(report).map_err(|source| DesktopError::InvalidJson {
        path: path.to_owned(),
        source,
    })?;
    fs::write(path, bytes).map_err(|source| DesktopError::WriteFile {
        path: path.to_owned(),
        source,
    })
}

fn default_command_timeout() -> u64 {
    120
}

fn default_probe_timeout() -> u64 {
    60
}

fn default_minimum_bytes() -> u64 {
    1
}

fn run_to_completion(
    command: &mut Command,
    timeout: Duration,
) -> std::result::Result<String, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "command stdout was not captured".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "command stderr was not captured".to_owned())?;
    let stdout = thread::spawn(move || read_pipe(stdout));
    let stderr = thread::spawn(move || read_pipe(stderr));
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let stdout = join_pipe(stdout)?;
            let stderr = join_pipe(stderr)?;
            let stdout = String::from_utf8_lossy(&stdout).trim().to_owned();
            let stderr = String::from_utf8_lossy(&stderr).trim().to_owned();
            let detail = match (stdout.is_empty(), stderr.is_empty()) {
                (false, false) => format!("stdout: {stdout}\nstderr: {stderr}"),
                (false, true) => stdout,
                (true, false) => stderr,
                (true, true) => status.to_string(),
            };
            return if status.success() {
                Ok(detail)
            } else {
                Err(detail)
            };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout.join();
            let _ = stderr.join();
            return Err(format!(
                "command timed out after {} seconds",
                timeout.as_secs()
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn read_pipe(mut pipe: impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn join_pipe(
    handle: thread::JoinHandle<std::io::Result<Vec<u8>>>,
) -> std::result::Result<Vec<u8>, String> {
    handle
        .join()
        .map_err(|_| "command output reader panicked".to_owned())?
        .map_err(|error| error.to_string())
}

fn wait_for_exit(
    child: &mut Child,
    timeout: Duration,
    require_success: bool,
) -> std::result::Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return if status.success() || !require_success {
                Ok(())
            } else {
                Err(format!("process exited with {status}"))
            };
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err("process did not stop before the timeout".to_owned())
}

fn http_probe(host: &str, port: u16, path: &str) -> std::result::Result<(), String> {
    let mut stream = TcpStream::connect((host, port)).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
    )
    .map_err(|error| error.to_string())?;
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    if line.starts_with("HTTP/1.1 2") || line.starts_with("HTTP/1.0 2") {
        Ok(())
    } else {
        Err(format!("probe returned {line:?}"))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Resp {
    Simple(String),
    Bulk(Option<Vec<u8>>),
    Integer(i64),
    Array(Option<Vec<Resp>>),
}

struct RespConnection {
    reader: BufReader<TcpStream>,
}

impl RespConnection {
    fn connect(host: &str, port: u16) -> Result<Self> {
        let stream = TcpStream::connect((host, port))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        Ok(Self {
            reader: BufReader::new(stream),
        })
    }

    fn command(&mut self, parts: &[&[u8]]) -> Result<Resp> {
        let stream = self.reader.get_mut();
        write!(stream, "*{}\r\n", parts.len())?;
        for part in parts {
            write!(stream, "${}\r\n", part.len())?;
            stream.write_all(part)?;
            stream.write_all(b"\r\n")?;
        }
        stream.flush()?;
        read_resp(&mut self.reader)
    }
}

fn read_resp(reader: &mut impl BufRead) -> Result<Resp> {
    let mut marker = [0_u8; 1];
    reader.read_exact(&mut marker)?;
    let line = read_resp_line(reader)?;
    match marker[0] {
        b'+' => Ok(Resp::Simple(line)),
        b'-' => Err(DesktopError::Compatibility(format!("cache error: {line}"))),
        b':' => Ok(Resp::Integer(line.parse().map_err(|error| {
            DesktopError::Compatibility(format!("invalid cache integer: {error}"))
        })?)),
        b'$' => {
            let length: i64 = line.parse().map_err(|error| {
                DesktopError::Compatibility(format!("invalid cache bulk length: {error}"))
            })?;
            if length < 0 {
                return Ok(Resp::Bulk(None));
            }
            let mut bytes = vec![0; length as usize];
            reader.read_exact(&mut bytes)?;
            let mut ending = [0; 2];
            reader.read_exact(&mut ending)?;
            if ending != *b"\r\n" {
                return Err(DesktopError::Compatibility(
                    "invalid cache bulk ending".to_owned(),
                ));
            }
            Ok(Resp::Bulk(Some(bytes)))
        }
        b'*' => {
            let length: i64 = line.parse().map_err(|error| {
                DesktopError::Compatibility(format!("invalid cache array length: {error}"))
            })?;
            if length < 0 {
                return Ok(Resp::Array(None));
            }
            let mut values = Vec::with_capacity(length as usize);
            for _ in 0..length {
                values.push(read_resp(reader)?);
            }
            Ok(Resp::Array(Some(values)))
        }
        marker => Err(DesktopError::Compatibility(format!(
            "unknown cache response marker {marker}"
        ))),
    }
}

fn read_resp_line(reader: &mut impl BufRead) -> Result<String> {
    let mut bytes = Vec::new();
    reader.read_until(b'\n', &mut bytes)?;
    if !bytes.ends_with(b"\r\n") {
        return Err(DesktopError::Compatibility(
            "invalid cache response line".to_owned(),
        ));
    }
    bytes.truncate(bytes.len() - 2);
    String::from_utf8(bytes).map_err(|error| {
        DesktopError::Compatibility(format!("cache returned invalid UTF-8: {error}"))
    })
}

pub fn run_cache_compatibility(host: &str, port: u16) -> Result<Vec<String>> {
    let mut connection = RespConnection::connect(host, port)?;
    expect_simple(connection.command(&[b"PING"])?, "PONG")?;
    connection.command(&[
        b"DEL",
        b"desktop:string",
        b"desktop:hash",
        b"desktop:queue",
        b"desktop:rate:bucket",
        b"desktop:rate:window",
    ])?;
    expect_simple(
        connection.command(&[b"SET", b"desktop:string", b"value"])?,
        "OK",
    )?;
    expect_bulk(connection.command(&[b"GET", b"desktop:string"])?, b"value")?;
    expect_integer(
        connection.command(&[b"HSET", b"desktop:hash", b"field", b"value"])?,
        1,
    )?;
    expect_bulk(
        connection.command(&[b"HGET", b"desktop:hash", b"field"])?,
        b"value",
    )?;
    let scan = connection.command(&[b"SCAN", b"0", b"MATCH", b"desktop:*"])?;
    if !resp_contains(&scan, b"desktop:string") || !resp_contains(&scan, b"desktop:hash") {
        return Err(DesktopError::Compatibility(
            "SCAN did not return the seeded keys".to_owned(),
        ));
    }

    let host_owned = host.to_owned();
    let (subscribed_tx, subscribed_rx) = mpsc::channel();
    let subscriber = thread::spawn(move || -> Result<()> {
        let mut subscriber = RespConnection::connect(&host_owned, port)?;
        let subscribed = subscriber.command(&[b"SUBSCRIBE", b"desktop:topic"])?;
        if !resp_contains(&subscribed, b"subscribe") {
            return Err(DesktopError::Compatibility(
                "SUBSCRIBE acknowledgement was invalid".to_owned(),
            ));
        }
        subscribed_tx.send(()).map_err(|error| {
            DesktopError::Compatibility(format!("could not signal subscription readiness: {error}"))
        })?;
        let message = read_resp(&mut subscriber.reader)?;
        if !resp_contains(&message, b"payload") {
            return Err(DesktopError::Compatibility(
                "Pub/Sub payload was not received".to_owned(),
            ));
        }
        Ok(())
    });
    subscribed_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|error| {
            DesktopError::Compatibility(format!("subscription did not become ready: {error}"))
        })?;
    expect_integer(
        connection.command(&[b"PUBLISH", b"desktop:topic", b"payload"])?,
        1,
    )?;
    subscriber
        .join()
        .map_err(|_| DesktopError::Compatibility("Pub/Sub test thread panicked".to_owned()))??;

    let host_owned = host.to_owned();
    let blocking = thread::spawn(move || -> Result<Resp> {
        RespConnection::connect(&host_owned, port)?.command(&[b"BLPOP", b"desktop:queue", b"5"])
    });
    thread::sleep(Duration::from_millis(100));
    expect_integer(
        connection.command(&[b"RPUSH", b"desktop:queue", b"task-payload"])?,
        1,
    )?;
    let popped = blocking.join().map_err(|_| {
        DesktopError::Compatibility("blocking-list test thread panicked".to_owned())
    })??;
    if !resp_contains(&popped, b"task-payload") {
        return Err(DesktopError::Compatibility(
            "BLPOP did not return the RPUSH payload".to_owned(),
        ));
    }

    let eval = connection.command(&[b"EVAL", b"return {KEYS[1],ARGV[1]}", b"1", b"key", b"arg"])?;
    if !resp_contains(&eval, b"key") || !resp_contains(&eval, b"arg") {
        return Err(DesktopError::Compatibility(
            "EVAL returned the wrong value".to_owned(),
        ));
    }
    let sha = expect_bulk_bytes(connection.command(&[b"SCRIPT", b"LOAD", b"return ARGV[1]"])?)?;
    expect_bulk(
        connection.command(&[b"EVALSHA", &sha, b"0", b"evalsha-ok"])?,
        b"evalsha-ok",
    )?;
    let bucket = connection.command(&[
        b"EVAL",
        BUCKET_SCRIPT.as_bytes(),
        b"1",
        b"desktop:rate:bucket",
        b"1000",
        b"2",
        b"2",
        b"1000",
        b"1",
    ])?;
    expect_integer_array(&bucket, &[1, 1])?;
    let window = connection.command(&[
        b"EVAL",
        WINDOW_SCRIPT.as_bytes(),
        b"1",
        b"desktop:rate:window",
        b"2",
        b"60",
    ])?;
    expect_integer_array(&window, &[1, 1])?;

    Ok(vec![
        "strings".to_owned(),
        "hashes".to_owned(),
        "scan".to_owned(),
        "pubsub".to_owned(),
        "blocking_lists".to_owned(),
        "eval".to_owned(),
        "evalsha".to_owned(),
        "penpot_bucket_rate_limit".to_owned(),
        "penpot_window_rate_limit".to_owned(),
        "penpot_worker_queue".to_owned(),
    ])
}

fn expect_simple(value: Resp, expected: &str) -> Result<()> {
    match value {
        Resp::Simple(value) if value == expected => Ok(()),
        value => Err(DesktopError::Compatibility(format!(
            "expected simple response {expected:?}, got {value:?}"
        ))),
    }
}

fn expect_integer(value: Resp, expected: i64) -> Result<()> {
    match value {
        Resp::Integer(value) if value == expected => Ok(()),
        value => Err(DesktopError::Compatibility(format!(
            "expected integer response {expected}, got {value:?}"
        ))),
    }
}

fn expect_bulk(value: Resp, expected: &[u8]) -> Result<()> {
    let value = expect_bulk_bytes(value)?;
    if value == expected {
        Ok(())
    } else {
        Err(DesktopError::Compatibility(format!(
            "expected bulk response {:?}, got {:?}",
            String::from_utf8_lossy(expected),
            String::from_utf8_lossy(&value)
        )))
    }
}

fn expect_bulk_bytes(value: Resp) -> Result<Vec<u8>> {
    match value {
        Resp::Bulk(Some(value)) => Ok(value),
        value => Err(DesktopError::Compatibility(format!(
            "expected bulk response, got {value:?}"
        ))),
    }
}

fn expect_integer_array(value: &Resp, expected: &[i64]) -> Result<()> {
    let Resp::Array(Some(values)) = value else {
        return Err(DesktopError::Compatibility(format!(
            "expected array response, got {value:?}"
        )));
    };
    let actual: Option<Vec<_>> = values
        .iter()
        .map(|value| match value {
            Resp::Integer(value) => Some(*value),
            _ => None,
        })
        .collect();
    if actual.as_deref() == Some(expected) {
        Ok(())
    } else {
        Err(DesktopError::Compatibility(format!(
            "expected integer array {expected:?}, got {value:?}"
        )))
    }
}

fn resp_contains(value: &Resp, needle: &[u8]) -> bool {
    match value {
        Resp::Simple(value) => value.as_bytes() == needle,
        Resp::Bulk(Some(value)) => value == needle,
        Resp::Array(Some(values)) => values.iter().any(|value| resp_contains(value, needle)),
        _ => false,
    }
}

fn confined_join(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(DesktopError::Compatibility(format!(
            "path must stay within {}: {relative}",
            root.display()
        )));
    }
    Ok(root.join(path))
}

fn decode_hex(value: &str) -> Result<Vec<u8>> {
    if value.len() % 2 != 0 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(DesktopError::Compatibility(format!(
            "invalid hexadecimal signature {value:?}"
        )));
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16).map_err(|error| {
                DesktopError::Compatibility(format!("invalid hexadecimal signature: {error}"))
            })
        })
        .collect()
}

fn runtime_path_environment(runtime_root: &Path) -> String {
    let separator = if cfg!(windows) { ";" } else { ":" };
    [
        runtime_root.join("node/bin"),
        runtime_root.join("node"),
        runtime_root.join("postgres/bin"),
        runtime_root.join("jre/bin"),
        runtime_root.join("tools/bin"),
        runtime_root.join("tools"),
    ]
    .iter()
    .map(|path| path.display().to_string())
    .collect::<Vec<_>>()
    .join(separator)
}

fn unix_ms() -> u128 {
    SystemTime::UNIX_EPOCH
        .elapsed()
        .unwrap_or_default()
        .as_millis()
}

impl From<std::io::Error> for DesktopError {
    fn from(error: std::io::Error) -> Self {
        DesktopError::Compatibility(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete_plan() -> CompatibilityPlan {
        fn action(id: &str) -> StepAction {
            let command = || CommandDefinition {
                executable: "runtime".to_owned(),
                arguments: Vec::new(),
                environment: BTreeMap::new(),
                working_directory: None,
                timeout_seconds: 1,
                stdout_contains: None,
            };
            match id {
                "postgres.stop" => StepAction::Stop {
                    process_id: "postgres".to_owned(),
                    command: Some(command()),
                },
                "postgres.restart"
                | "service.media-processor"
                | "service.backend"
                | "service.exporter" => StepAction::Start {
                    process_id: id.to_owned(),
                    command: command(),
                    ready: ReadyProbe {
                        host: "127.0.0.1".to_owned(),
                        port: "cache".to_owned(),
                        http_path: None,
                        timeout_seconds: 1,
                    },
                },
                "cache.compatibility" => StepAction::CacheCompatibility {
                    port: "cache".to_owned(),
                },
                _ => StepAction::Command {
                    command: command(),
                    expected_artifacts: Vec::new(),
                },
            }
        }
        CompatibilityPlan {
            schema_version: 1,
            target: "test-target".to_owned(),
            ports: vec!["cache".to_owned()],
            steps: REQUIRED_CHECKS
                .iter()
                .map(|id| PlanStep {
                    id: (*id).to_owned(),
                    action: action(id),
                })
                .collect(),
        }
    }

    #[test]
    fn requires_every_entry_gate_check() {
        let mut plan = complete_plan();
        plan.steps.retain(|step| step.id != "font.woff2");

        let error = plan.validate().unwrap_err();

        assert!(error.to_string().contains("font.woff2"));
    }

    #[test]
    fn rejects_duplicate_check_ids() {
        let mut plan = complete_plan();
        plan.steps.push(plan.steps[0].clone());

        assert!(plan.validate().unwrap_err().to_string().contains("repeats"));
    }

    #[test]
    fn confines_runtime_and_work_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime = temporary.path().join("runtime");
        fs::create_dir(&runtime).unwrap();
        let runner = PlanRunner::new(runtime, temporary.path().join("work"), &[]).unwrap();

        assert!(runner.resolve_runtime_path("../escape").is_err());
        assert!(runner.resolve_work_path("../escape").is_err());
    }

    #[test]
    fn expands_named_ports_and_roots() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime = temporary.path().join("runtime");
        fs::create_dir(&runtime).unwrap();
        let runner = PlanRunner::new(
            runtime.clone(),
            temporary.path().join("work"),
            &["cache".to_owned()],
        )
        .unwrap();

        let expanded = runner
            .expand("{{runtime_root}}:{{work_root}}:{{port.cache}}")
            .unwrap();

        assert!(expanded.contains(&runtime.display().to_string()));
        assert!(!expanded.contains("{{"));
    }

    #[test]
    fn reserves_a_distinct_port_for_each_service() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime = temporary.path().join("runtime");
        fs::create_dir(&runtime).unwrap();
        let runner = PlanRunner::new(
            runtime,
            temporary.path().join("work"),
            &["one".to_owned(), "two".to_owned(), "three".to_owned()],
        )
        .unwrap();

        let ports: std::collections::HashSet<_> = runner.ports.values().collect();
        assert_eq!(ports.len(), 3);
    }

    #[test]
    fn checks_artifact_signatures() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime = temporary.path().join("runtime");
        fs::create_dir(&runtime).unwrap();
        let runner = PlanRunner::new(runtime, temporary.path().join("work"), &[]).unwrap();
        fs::write(
            runner.work_root.join("image.png"),
            b"\x89PNG\r\n\x1a\ncontent",
        )
        .unwrap();

        runner
            .verify_artifact(&ArtifactExpectation {
                path: "image.png".to_owned(),
                minimum_bytes: 9,
                magic_hex: Some("89504e470d0a1a0a".to_owned()),
            })
            .unwrap();
    }

    #[test]
    fn bundled_native_plans_cover_the_entry_gate() {
        for contents in [
            include_str!("../../compatibility/plans/aarch64-apple-darwin.json"),
            include_str!("../../compatibility/plans/x86_64-pc-windows-msvc.json"),
        ] {
            let plan: CompatibilityPlan = serde_json::from_str(contents).unwrap();
            plan.validate().unwrap();
        }
    }
}
