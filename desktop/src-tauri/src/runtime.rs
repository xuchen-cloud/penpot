use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::time::Duration;

use crate::bootstrap::{DatabaseBootstrap, wait_for_http, wait_for_port, write_cache_config};
use crate::config::DesktopConfig;
use crate::credentials::StoredSecrets;
use crate::error::{DesktopError, Result};
use crate::gateway::{GatewayConfig, GatewayHandle};
use crate::instance_lock::InstanceLock;
use crate::local_stack::{LocalStackConfig, RuntimePorts, RuntimeSecrets, process_specs};
use crate::paths::InstancePaths;
use crate::ports::LoopbackPortReservation;
use crate::runtime_manifest::RuntimeManifest;
use crate::supervisor::{ProcessStatus, ProcessSupervisor};

const SERVICE_TIMEOUT: Duration = Duration::from_secs(30);
const BACKEND_TIMEOUT: Duration = Duration::from_secs(120);

pub struct LocalRuntime {
    supervisor: ProcessSupervisor,
    gateway: Option<GatewayHandle>,
    _instance_lock: InstanceLock,
}

impl LocalRuntime {
    pub async fn start(
        manifest: &RuntimeManifest,
        target: &str,
        runtime_root: &Path,
        paths: &InstancePaths,
        config: &DesktopConfig,
        secrets: &StoredSecrets,
    ) -> Result<Self> {
        let instance_lock = InstanceLock::acquire(&paths.run.join("desktop.lock"))?;
        let public_port =
            LoopbackPortReservation::reserve_port(config.public_port).map_err(|error| {
                DesktopError::Gateway(format!(
                    "public port {} is unavailable: {error}",
                    config.public_port
                ))
            })?;
        let reservations = reserve_ports()?;
        let ports = RuntimePorts {
            postgres: reservations[0].port().map_err(port_error)?,
            cache: reservations[1].port().map_err(port_error)?,
            media_processor: reservations[2].port().map_err(port_error)?,
            backend: reservations[3].port().map_err(port_error)?,
            exporter: reservations[4].port().map_err(port_error)?,
        };
        let postgres_root = runtime_root.join("postgres");
        let bootstrap = DatabaseBootstrap {
            target,
            postgres_root: &postgres_root,
            database_directory: &paths.database,
            run_directory: &paths.run,
            password: &secrets.database_password,
            port: ports.postgres,
        };
        bootstrap.initialize_cluster().await?;
        let cache_config_path = paths.run.join(if target == "aarch64-apple-darwin" {
            "valkey.conf"
        } else {
            "garnet.json"
        });
        let mut cache_config = Some(write_cache_config(
            target,
            &cache_config_path,
            ports.cache,
            &paths.cache,
            &secrets.cache_password,
        )?);
        let origin = format!("http://localhost:{}/", config.public_port);
        let stack = LocalStackConfig {
            target,
            runtime_root,
            paths,
            ports,
            secrets: RuntimeSecrets {
                database_password: &secrets.database_password,
                cache_password: &secrets.cache_password,
                penpot_secret: &secrets.penpot_secret,
                media_processor_key: &secrets.media_processor_key,
                exporter_key: &secrets.management_key,
            },
            public_origin: &origin,
            administrator_email: &config.standalone_admin_email,
        };
        let specs = process_specs(manifest, &stack)?;
        let released_ports: Vec<_> = reservations
            .into_iter()
            .map(LoopbackPortReservation::release)
            .collect();
        debug_assert_eq!(
            released_ports,
            [
                ports.postgres,
                ports.cache,
                ports.media_processor,
                ports.backend,
                ports.exporter,
            ]
        );

        let mut supervisor = ProcessSupervisor::default();
        for spec in &specs {
            supervisor.start(spec, &paths.logs)?;
            let (port, timeout, readiness_path) = match spec.id.as_str() {
                "postgres" => (ports.postgres, SERVICE_TIMEOUT, None),
                "cache" => (ports.cache, SERVICE_TIMEOUT, None),
                "media-processor" => (ports.media_processor, SERVICE_TIMEOUT, Some("/api/health")),
                "backend" => (ports.backend, BACKEND_TIMEOUT, Some("/readyz")),
                "exporter" => (ports.exporter, SERVICE_TIMEOUT, Some("/readyz")),
                id => {
                    return Err(DesktopError::Process(format!(
                        "no readiness check is defined for {id}"
                    )));
                }
            };
            if spec.id == "postgres" {
                bootstrap.create_application_database(timeout).await?;
            } else if let Some(path) = readiness_path {
                wait_for_http(port, path, timeout, &spec.id).await?;
            } else {
                wait_for_port(port, timeout, &spec.id).await?;
            }
            if spec.id == "cache" {
                drop(cache_config.take());
            }
        }
        let gateway = GatewayHandle::start_with_listener(
            GatewayConfig {
                bind_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), config.public_port),
                frontend_root: runtime_root.join("frontend"),
                backend_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), ports.backend),
                exporter_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), ports.exporter),
                asset_root: paths.assets.clone(),
            },
            public_port.into_listener(),
        )?;
        Ok(Self {
            supervisor,
            gateway: Some(gateway),
            _instance_lock: instance_lock,
        })
    }

    pub fn statuses(&mut self) -> Result<Vec<ProcessStatus>> {
        self.supervisor.statuses()
    }

    pub async fn stop(&mut self) -> Result<()> {
        let gateway_error = if let Some(gateway) = self.gateway.take() {
            gateway.stop().await.err()
        } else {
            None
        };
        let process_result = self.supervisor.stop_all().await;
        if let Some(error) = gateway_error {
            Err(error)
        } else {
            process_result
        }
    }
}

fn reserve_ports() -> Result<[LoopbackPortReservation; 5]> {
    let mut reservations = Vec::with_capacity(5);
    for _ in 0..5 {
        reservations.push(LoopbackPortReservation::reserve().map_err(port_error)?);
    }
    reservations.try_into().map_err(|_| {
        DesktopError::Process("could not reserve all internal service ports".to_owned())
    })
}

fn port_error(error: std::io::Error) -> DesktopError {
    DesktopError::Process(format!(
        "could not reserve an internal service port: {error}"
    ))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn reserves_distinct_internal_ports() {
        let reservations = reserve_ports().unwrap();
        let ports: HashSet<_> = reservations
            .iter()
            .map(|reservation| reservation.port().unwrap())
            .collect();
        assert_eq!(ports.len(), reservations.len());
    }
}
