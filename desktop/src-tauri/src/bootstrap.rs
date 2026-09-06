use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::time::sleep;

use crate::error::{DesktopError, Result};

const DATABASE_NAME: &str = "penpot";
const DATABASE_USER: &str = "penpot";

pub struct DatabaseBootstrap<'a> {
    pub target: &'a str,
    pub postgres_root: &'a Path,
    pub database_directory: &'a Path,
    pub run_directory: &'a Path,
    pub password: &'a str,
    pub port: u16,
}

impl DatabaseBootstrap<'_> {
    pub fn is_cluster_initialized(&self) -> bool {
        self.database_directory.join("PG_VERSION").is_file()
    }

    pub async fn initialize_cluster(&self) -> Result<()> {
        if self.is_cluster_initialized() {
            return Ok(());
        }
        if self.password.is_empty() {
            return Err(DesktopError::Process(
                "database password must not be empty".to_owned(),
            ));
        }
        let password_file = self.run_directory.join("postgres-bootstrap-password");
        if password_file.exists() {
            fs::remove_file(&password_file).map_err(|source| DesktopError::WriteFile {
                path: password_file.clone(),
                source,
            })?;
        }
        write_private_file(&password_file, self.password.as_bytes())?;
        let result = self.run_initdb(&password_file).await;
        let remove_result =
            fs::remove_file(&password_file).map_err(|source| DesktopError::WriteFile {
                path: password_file,
                source,
            });
        result?;
        remove_result
    }

    pub async fn create_application_database(&self) -> Result<()> {
        if self.database_exists().await? {
            return Ok(());
        }
        let mut command = self.postgres_command("createdb");
        command
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                &self.port.to_string(),
                "--username",
                DATABASE_USER,
                DATABASE_NAME,
            ])
            .env("PGPASSWORD", self.password);
        run_checked(command, "create the Penpot database").await
    }

    async fn database_exists(&self) -> Result<bool> {
        let mut command = self.postgres_command("psql");
        command
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                &self.port.to_string(),
                "--username",
                DATABASE_USER,
                "--dbname",
                "postgres",
                "--tuples-only",
                "--no-align",
                "--command",
                "SELECT 1 FROM pg_database WHERE datname = 'penpot'",
            ])
            .env("PGPASSWORD", self.password)
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        let output = command.output().await.map_err(|error| {
            DesktopError::Process(format!("could not inspect the Penpot database: {error}"))
        })?;
        if !output.status.success() {
            return Err(DesktopError::Process(format!(
                "could not inspect the Penpot database: psql exited with {}",
                output.status
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim() == "1")
    }

    async fn run_initdb(&self, password_file: &Path) -> Result<()> {
        let mut command = self.postgres_command("initdb");
        command.args([
            "--pgdata",
            &display(self.database_directory),
            "--username",
            DATABASE_USER,
            "--pwfile",
            &display(password_file),
            "--encoding",
            "UTF8",
            "--auth-host",
            "scram-sha-256",
            "--auth-local",
            if self.target == "aarch64-apple-darwin" {
                "trust"
            } else {
                "scram-sha-256"
            },
        ]);
        run_checked(command, "initialize PostgreSQL").await
    }

    fn postgres_command(&self, name: &str) -> Command {
        let extension = if self.target == "x86_64-pc-windows-msvc" {
            ".exe"
        } else {
            ""
        };
        Command::new(
            self.postgres_root
                .join("bin")
                .join(format!("{name}{extension}")),
        )
    }
}

pub async fn wait_for_port(port: u16, timeout: Duration, service: &str) -> Result<()> {
    let started = Instant::now();
    loop {
        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            return Err(DesktopError::Process(format!(
                "{service} did not become ready on 127.0.0.1:{port} within {} seconds",
                timeout.as_secs()
            )));
        }
        sleep(Duration::from_millis(100)).await;
    }
}

pub async fn wait_for_http(port: u16, path: &str, timeout: Duration, service: &str) -> Result<()> {
    if !path.starts_with('/')
        || path
            .chars()
            .any(|character| matches!(character, '\r' | '\n'))
    {
        return Err(DesktopError::Process(
            "readiness path must be an absolute HTTP path".to_owned(),
        ));
    }
    let started = Instant::now();
    loop {
        if probe_http(port, path).await {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            return Err(DesktopError::Process(format!(
                "{service} did not pass its readiness probe within {} seconds",
                timeout.as_secs()
            )));
        }
        sleep(Duration::from_millis(150)).await;
    }
}

async fn probe_http(port: u16, path: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)).await else {
        return false;
    };
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).await.is_err() {
        return false;
    }
    let mut response = [0_u8; 64];
    let Ok(read) = stream.read(&mut response).await else {
        return false;
    };
    response[..read].starts_with(b"HTTP/1.1 200") || response[..read].starts_with(b"HTTP/1.0 200")
}

pub struct SensitiveFile {
    path: PathBuf,
}

impl Drop for SensitiveFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub fn write_cache_config(
    target: &str,
    path: &Path,
    port: u16,
    data_directory: &Path,
    password: &str,
) -> Result<SensitiveFile> {
    if password.is_empty() || !password.bytes().all(|value| value.is_ascii_alphanumeric()) {
        return Err(DesktopError::Process(
            "cache password must contain only letters and numbers".to_owned(),
        ));
    }
    let contents = match target {
        "aarch64-apple-darwin" => format!(
            "bind 127.0.0.1\nport {port}\nprotected-mode yes\nrequirepass {password}\ndir {}\n",
            valkey_quote(data_directory)?
        ),
        "x86_64-pc-windows-msvc" => serde_json::to_string_pretty(&serde_json::json!({
            "Address": "127.0.0.1",
            "Port": port,
            "AuthenticationMode": "Password",
            "Password": password,
            "CheckpointDir": display(data_directory),
        }))
        .map_err(|error| {
            DesktopError::Process(format!("could not create cache configuration: {error}"))
        })?,
        _ => {
            return Err(DesktopError::Process(format!(
                "unsupported cache target {target}"
            )));
        }
    };
    if path.exists() {
        fs::remove_file(path).map_err(|source| DesktopError::WriteFile {
            path: path.to_owned(),
            source,
        })?;
    }
    write_private_file(path, contents.as_bytes())?;
    Ok(SensitiveFile {
        path: path.to_owned(),
    })
}

async fn run_checked(mut command: Command, purpose: &str) -> Result<()> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let status = command
        .status()
        .await
        .map_err(|error| DesktopError::Process(format!("could not {purpose}: {error}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(DesktopError::Process(format!(
            "could not {purpose}: command exited with {status}"
        )))
    }
}

fn write_private_file(path: &Path, contents: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
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
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|source| DesktopError::WriteFile {
            path: path.to_owned(),
            source,
        })
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn valkey_quote(path: &Path) -> Result<String> {
    let value = display(path);
    if value
        .chars()
        .any(|character| matches!(character, '\n' | '\r' | '\0'))
    {
        return Err(DesktopError::Process(
            "cache data directory contains an unsupported character".to_owned(),
        ));
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bootstrap<'a>(root: &'a Path, target: &'a str) -> DatabaseBootstrap<'a> {
        DatabaseBootstrap {
            target,
            postgres_root: root,
            database_directory: root,
            run_directory: root,
            password: "secret",
            port: 5432,
        }
    }

    #[test]
    fn detects_an_initialized_cluster() {
        let directory = tempfile::tempdir().unwrap();
        let bootstrap = bootstrap(directory.path(), "aarch64-apple-darwin");
        assert!(!bootstrap.is_cluster_initialized());
        fs::write(directory.path().join("PG_VERSION"), "15").unwrap();
        assert!(bootstrap.is_cluster_initialized());
    }

    #[tokio::test]
    async fn waits_for_a_loopback_service() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        wait_for_port(port, Duration::from_secs(1), "fixture")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn reports_a_readiness_timeout() {
        let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let error = wait_for_port(port, Duration::from_millis(10), "fixture")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("fixture did not become ready"));
    }

    #[tokio::test]
    async fn waits_for_an_http_readiness_response() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 256];
            let _ = stream.read(&mut request).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
                .await
                .unwrap();
        });
        wait_for_http(port, "/readyz", Duration::from_secs(1), "fixture")
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn writes_bootstrap_secrets_with_private_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("password");
        write_private_file(&path, b"secret").unwrap();
        let mode = fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn keeps_the_cache_password_out_of_process_arguments() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("valkey.conf");
        let config_file = write_cache_config(
            "aarch64-apple-darwin",
            &path,
            6380,
            directory.path(),
            "abc123",
        )
        .unwrap();
        let config = fs::read_to_string(path).unwrap();
        assert!(config.contains("bind 127.0.0.1"));
        assert!(config.contains("port 6380"));
        assert!(config.contains("requirepass abc123"));
        assert!(config.contains(&format!("dir {}", valkey_quote(directory.path()).unwrap())));
        drop(config_file);
        assert!(!directory.path().join("valkey.conf").exists());
    }

    #[test]
    fn writes_windows_cache_secrets_to_a_temporary_json_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("garnet.json");
        let config_file = write_cache_config(
            "x86_64-pc-windows-msvc",
            &path,
            6380,
            directory.path(),
            "abc123",
        )
        .unwrap();
        let config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(config["Address"], "127.0.0.1");
        assert_eq!(config["AuthenticationMode"], "Password");
        assert_eq!(config["Password"], "abc123");
        drop(config_file);
        assert!(!path.exists());
    }
}
