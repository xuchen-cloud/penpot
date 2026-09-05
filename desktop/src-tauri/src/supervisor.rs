use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::{Child, Command};
use tokio::time::timeout;

use crate::error::{DesktopError, Result};

const STOP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct ProcessSpec {
    pub id: String,
    pub command: CommandSpec,
    pub graceful_shutdown: Option<CommandSpec>,
}

#[derive(Clone)]
pub struct CommandSpec {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub working_directory: PathBuf,
}

impl CommandSpec {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        command
            .args(&self.arguments)
            .envs(&self.environment)
            .current_dir(&self.working_directory);
        command
    }

    fn validate(&self, purpose: &str) -> Result<()> {
        if !self.executable.is_file() {
            return Err(DesktopError::Process(format!(
                "{purpose} executable does not exist: {}",
                self.executable.display()
            )));
        }
        if !self.working_directory.is_dir() {
            return Err(DesktopError::Process(format!(
                "{purpose} working directory does not exist: {}",
                self.working_directory.display()
            )));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessState {
    Running,
    Exited,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStatus {
    pub id: String,
    pub state: ProcessState,
    pub exit_code: Option<i32>,
}

struct ManagedProcess {
    id: String,
    child: Child,
    containment: platform::Containment,
    graceful_shutdown: Option<CommandSpec>,
}

#[derive(Default)]
pub struct ProcessSupervisor {
    processes: Vec<ManagedProcess>,
}

impl ProcessSupervisor {
    pub async fn start_all(specs: &[ProcessSpec], logs: &Path) -> Result<Self> {
        fs::create_dir_all(logs).map_err(|source| DesktopError::WriteFile {
            path: logs.to_owned(),
            source,
        })?;
        let mut supervisor = Self::default();
        for spec in specs {
            if let Err(error) = supervisor.start(spec, logs) {
                let _ = supervisor.stop_all().await;
                return Err(error);
            }
        }
        Ok(supervisor)
    }

    pub fn start(&mut self, spec: &ProcessSpec, logs: &Path) -> Result<()> {
        fs::create_dir_all(logs).map_err(|source| DesktopError::WriteFile {
            path: logs.to_owned(),
            source,
        })?;
        self.processes.push(spawn(spec, logs)?);
        Ok(())
    }

    pub fn statuses(&mut self) -> Result<Vec<ProcessStatus>> {
        self.processes
            .iter_mut()
            .map(|process| {
                let status = process.child.try_wait().map_err(|error| {
                    DesktopError::Process(format!(
                        "could not inspect process {}: {error}",
                        process.id
                    ))
                })?;
                Ok(ProcessStatus {
                    id: process.id.clone(),
                    state: if status.is_some() {
                        ProcessState::Exited
                    } else {
                        ProcessState::Running
                    },
                    exit_code: status.and_then(|value| value.code()),
                })
            })
            .collect()
    }

    pub async fn stop_all(&mut self) -> Result<()> {
        let mut first_error = None;
        while let Some(mut process) = self.processes.pop() {
            if let Err(error) = stop(&mut process).await
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

impl Drop for ProcessSupervisor {
    fn drop(&mut self) {
        for process in &mut self.processes {
            platform::force_stop(process);
        }
    }
}

fn spawn(spec: &ProcessSpec, logs: &Path) -> Result<ManagedProcess> {
    validate_spec(spec)?;
    let stdout = log_file(logs, &spec.id, "stdout")?;
    let stderr = log_file(logs, &spec.id, "stderr")?;
    let mut command = spec.command.command();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .kill_on_drop(true);
    platform::prepare_command(&mut command);
    let mut child = command.spawn().map_err(|error| {
        DesktopError::Process(format!(
            "could not start {} from {}: {error}",
            spec.id,
            spec.command.executable.display()
        ))
    })?;
    let containment = match platform::contain(&child) {
        Ok(containment) => containment,
        Err(error) => {
            let _ = child.start_kill();
            return Err(error);
        }
    };
    Ok(ManagedProcess {
        id: spec.id.clone(),
        child,
        containment,
        graceful_shutdown: spec.graceful_shutdown.clone(),
    })
}

fn validate_spec(spec: &ProcessSpec) -> Result<()> {
    if spec.id.is_empty()
        || !spec
            .id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-' || value == b'_')
    {
        return Err(DesktopError::Process(format!(
            "invalid process id {:?}",
            spec.id
        )));
    }
    spec.command.validate("process")?;
    if let Some(shutdown) = &spec.graceful_shutdown {
        shutdown.validate("shutdown")?;
    }
    Ok(())
}

fn log_file(logs: &Path, id: &str, stream: &str) -> Result<std::fs::File> {
    let path = logs.join(format!("{id}.{stream}.log"));
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|source| DesktopError::WriteFile { path, source })
}

async fn stop(process: &mut ManagedProcess) -> Result<()> {
    if process
        .child
        .try_wait()
        .map_err(|error| DesktopError::Process(error.to_string()))?
        .is_some()
    {
        platform::force_stop(process);
        return Ok(());
    }
    let graceful_error = request_stop(process).await.err();
    if graceful_error.is_some() {
        platform::force_stop(process);
    }
    match timeout(STOP_TIMEOUT, process.child.wait()).await {
        Ok(result) => {
            result.map_err(|error| {
                DesktopError::Process(format!(
                    "could not wait for process {}: {error}",
                    process.id
                ))
            })?;
        }
        Err(_) => {
            platform::force_stop(process);
            process.child.wait().await.map_err(|error| {
                DesktopError::Process(format!(
                    "could not wait for process {} after forcing it to stop: {error}",
                    process.id
                ))
            })?;
        }
    };
    // The direct child can exit before its descendants. Containment still
    // identifies the original process tree, so finish any remaining members.
    platform::force_stop(process);
    graceful_error.map_or(Ok(()), Err)
}

async fn request_stop(process: &mut ManagedProcess) -> Result<()> {
    let Some(spec) = &process.graceful_shutdown else {
        return platform::request_stop(process);
    };
    let mut command = spec.command();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut shutdown = command.spawn().map_err(|error| {
        DesktopError::Process(format!(
            "could not run shutdown command for {}: {error}",
            process.id
        ))
    })?;
    let status = timeout(STOP_TIMEOUT, shutdown.wait())
        .await
        .map_err(|_| {
            let _ = shutdown.start_kill();
            DesktopError::Process(format!("shutdown command for {} timed out", process.id))
        })?
        .map_err(|error| {
            DesktopError::Process(format!(
                "could not wait for shutdown command for {}: {error}",
                process.id
            ))
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(DesktopError::Process(format!(
            "shutdown command for {} exited with {status}",
            process.id
        )))
    }
}

#[cfg(unix)]
mod platform {
    use std::io;

    use tokio::process::{Child, Command};

    use super::{DesktopError, ManagedProcess, Result};

    #[derive(Debug)]
    pub struct Containment {
        process_group: libc::pid_t,
    }

    pub fn prepare_command(command: &mut Command) {
        command.process_group(0);
    }

    pub fn contain(child: &Child) -> Result<Containment> {
        let process_group = child
            .id()
            .ok_or_else(|| DesktopError::Process("child process has no process id".to_owned()))?
            as libc::pid_t;
        Ok(Containment { process_group })
    }

    pub fn request_stop(process: &ManagedProcess) -> Result<()> {
        signal_group(process, libc::SIGTERM)
    }

    pub fn force_stop(process: &mut ManagedProcess) {
        let _ = signal_group(process, libc::SIGKILL);
    }

    fn signal_group(process: &ManagedProcess, signal: libc::c_int) -> Result<()> {
        // The child is its own process-group leader because prepare_command set
        // pgroup to zero. A negative PID addresses the whole group.
        let result = unsafe { libc::kill(-process.containment.process_group, signal) };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(DesktopError::Process(format!(
                "could not signal process group {}: {error}",
                process.id
            )))
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::io;
    use std::mem::size_of;
    use std::ptr;

    use tokio::process::{Child, Command};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
    };

    use super::{DesktopError, ManagedProcess, Result};

    #[derive(Debug)]
    pub struct Containment(usize);

    impl Drop for Containment {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.handle());
            }
        }
    }

    impl Containment {
        fn handle(&self) -> HANDLE {
            self.0 as HANDLE
        }
    }

    pub fn prepare_command(command: &mut Command) {
        command.creation_flags(CREATE_SUSPENDED);
    }

    pub fn contain(child: &Child) -> Result<Containment> {
        let process_handle = child.raw_handle().ok_or_else(|| {
            DesktopError::Process("child process has no Windows handle".to_owned())
        })? as HANDLE;
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(last_error("could not create a Windows Job Object"));
        }
        let containment = Containment(job as usize);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                containment.handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(last_error("could not configure a Windows Job Object"));
        }
        if unsafe { AssignProcessToJobObject(containment.handle(), process_handle) } == 0 {
            return Err(last_error(
                "could not assign a child process to its Windows Job Object",
            ));
        }
        resume_child(child)?;
        Ok(containment)
    }

    fn resume_child(child: &Child) -> Result<()> {
        let process_id = child
            .id()
            .ok_or_else(|| DesktopError::Process("child process has no process id".to_owned()))?;
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(last_error("could not enumerate Windows process threads"));
        }
        let _snapshot = OwnedHandle(snapshot);
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut found = unsafe { Thread32First(snapshot, &mut entry) } != 0;
        while found {
            if entry.th32OwnerProcessID == process_id {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    return Err(last_error("could not open the suspended process thread"));
                }
                let _thread = OwnedHandle(thread);
                if unsafe { ResumeThread(thread) } == u32::MAX {
                    return Err(last_error("could not resume the contained process"));
                }
                return Ok(());
            }
            found = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
        }
        Err(DesktopError::Process(format!(
            "could not find the suspended thread for process {process_id}"
        )))
    }

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub fn request_stop(process: &ManagedProcess) -> Result<()> {
        if unsafe { TerminateJobObject(process.containment.handle(), 1) } == 0 {
            Err(last_error(&format!(
                "could not terminate process tree {}",
                process.id
            )))
        } else {
            Ok(())
        }
    }

    pub fn force_stop(process: &mut ManagedProcess) {
        let _ = unsafe { TerminateJobObject(process.containment.handle(), 1) };
    }

    fn last_error(context: &str) -> DesktopError {
        DesktopError::Process(format!("{context}: {}", io::Error::last_os_error()))
    }
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::thread;

    use super::*;

    fn fixture_spec(id: &str, marker: &str, directory: &Path) -> ProcessSpec {
        ProcessSpec {
            id: id.to_owned(),
            command: CommandSpec {
                executable: env::current_exe().unwrap(),
                arguments: vec![
                    "--exact".to_owned(),
                    "supervisor::tests::fixture_process".to_owned(),
                    "--ignored".to_owned(),
                    "--nocapture".to_owned(),
                ],
                environment: BTreeMap::from([(
                    "PENPOT_DESKTOP_FIXTURE".to_owned(),
                    marker.to_owned(),
                )]),
                working_directory: directory.to_owned(),
            },
            graceful_shutdown: None,
        }
    }

    #[test]
    #[ignore = "runs only as a supervised fixture"]
    fn fixture_process() {
        println!("fixture={}", env::var("PENPOT_DESKTOP_FIXTURE").unwrap());
        if let Ok(marker) = env::var("PENPOT_DESKTOP_STOP_MARKER") {
            while !Path::new(&marker).is_file() {
                thread::sleep(Duration::from_millis(10));
            }
            return;
        }
        thread::sleep(Duration::from_secs(60));
    }

    #[test]
    #[ignore = "runs only as a supervised shutdown fixture"]
    fn fixture_shutdown() {
        fs::write(env::var("PENPOT_DESKTOP_STOP_MARKER").unwrap(), "stop").unwrap();
    }

    #[tokio::test]
    async fn starts_reports_and_stops_a_process() {
        let temporary = tempfile::tempdir().unwrap();
        let logs = temporary.path().join("logs");
        let mut supervisor = ProcessSupervisor::start_all(
            &[fixture_spec("backend", "running", temporary.path())],
            &logs,
        )
        .await
        .unwrap();

        assert_eq!(
            supervisor.statuses().unwrap(),
            [ProcessStatus {
                id: "backend".to_owned(),
                state: ProcessState::Running,
                exit_code: None,
            }]
        );
        supervisor.stop_all().await.unwrap();
        assert!(supervisor.statuses().unwrap().is_empty());
        assert!(logs.join("backend.stdout.log").is_file());
        assert!(logs.join("backend.stderr.log").is_file());
    }

    #[tokio::test]
    async fn rolls_back_started_processes_when_a_later_start_fails() {
        let temporary = tempfile::tempdir().unwrap();
        let invalid = ProcessSpec {
            id: "missing".to_owned(),
            command: CommandSpec {
                executable: temporary.path().join("missing"),
                arguments: Vec::new(),
                environment: BTreeMap::new(),
                working_directory: temporary.path().to_owned(),
            },
            graceful_shutdown: None,
        };

        let result = ProcessSupervisor::start_all(
            &[
                fixture_spec("database", "rollback", temporary.path()),
                invalid,
            ],
            &temporary.path().join("logs"),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn runs_the_configured_graceful_shutdown_before_forcing_the_tree() {
        let temporary = tempfile::tempdir().unwrap();
        let marker = temporary.path().join("stop-marker");
        let executable = env::current_exe().unwrap();
        let mut spec = fixture_spec("postgres", "graceful", temporary.path());
        spec.command.environment.insert(
            "PENPOT_DESKTOP_STOP_MARKER".to_owned(),
            marker.display().to_string(),
        );
        spec.graceful_shutdown = Some(CommandSpec {
            executable,
            arguments: vec![
                "--exact".to_owned(),
                "supervisor::tests::fixture_shutdown".to_owned(),
                "--ignored".to_owned(),
            ],
            environment: BTreeMap::from([(
                "PENPOT_DESKTOP_STOP_MARKER".to_owned(),
                marker.display().to_string(),
            )]),
            working_directory: temporary.path().to_owned(),
        });
        let mut supervisor = ProcessSupervisor::start_all(&[spec], &temporary.path().join("logs"))
            .await
            .unwrap();

        supervisor.stop_all().await.unwrap();

        assert!(marker.is_file());
    }

    #[tokio::test]
    async fn rejects_process_ids_that_could_escape_the_log_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let result = ProcessSupervisor::start_all(
            &[fixture_spec("../backend", "invalid", temporary.path())],
            &temporary.path().join("logs"),
        )
        .await;

        assert!(result.is_err());
    }
}
