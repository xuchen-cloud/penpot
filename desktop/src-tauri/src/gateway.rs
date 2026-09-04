use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::Json;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, header};
use axum::routing::get;
use axum::{Router, http};
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::error::{DesktopError, Result};

pub const MAX_REQUEST_BODY_BYTES: usize = 350 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct GatewayConfig {
    pub bind_address: SocketAddr,
    pub frontend_root: PathBuf,
}

#[derive(Debug)]
pub struct GatewayHandle {
    address: SocketAddr,
    cancellation: CancellationToken,
    task: JoinHandle<std::io::Result<()>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

impl GatewayHandle {
    pub async fn start(config: GatewayConfig) -> Result<Self> {
        validate_frontend_root(&config.frontend_root)?;
        let listener = TcpListener::bind(config.bind_address)
            .await
            .map_err(|error| DesktopError::Gateway(error.to_string()))?;
        let address = listener
            .local_addr()
            .map_err(|error| DesktopError::Gateway(error.to_string()))?;
        let cancellation = CancellationToken::new();
        let shutdown = cancellation.clone();
        let router = router(config.frontend_root);
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await
        });

        Ok(Self {
            address,
            cancellation,
            task,
        })
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub async fn stop(self) -> Result<()> {
        self.cancellation.cancel();
        self.task
            .await
            .map_err(|error| DesktopError::Gateway(error.to_string()))?
            .map_err(|error| DesktopError::Gateway(error.to_string()))
    }
}

fn validate_frontend_root(root: &Path) -> Result<()> {
    if !root.is_dir() {
        return Err(DesktopError::Gateway(format!(
            "frontend directory does not exist: {}",
            root.display()
        )));
    }
    let index = root.join("index.html");
    if !index.is_file() {
        return Err(DesktopError::Gateway(format!(
            "frontend entry point does not exist: {}",
            index.display()
        )));
    }
    Ok(())
}

fn router(frontend_root: PathBuf) -> Router {
    let index = frontend_root.join("index.html");
    let frontend = ServeDir::new(frontend_root).fallback(ServeFile::new(index));

    Router::new()
        .route("/desktop/health", get(health))
        .fallback_service(frontend)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            http::header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "penpot-desktop-gateway",
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::net::{IpAddr, Ipv4Addr};

    use super::*;

    fn frontend() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("index.html"), "desktop index").unwrap();
        fs::write(directory.path().join("app.js"), "console.log('desktop')").unwrap();
        directory
    }

    #[tokio::test]
    async fn serves_health_and_static_frontend_on_loopback() {
        let frontend = frontend();
        let gateway = GatewayHandle::start(GatewayConfig {
            bind_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            frontend_root: frontend.path().to_owned(),
        })
        .await
        .unwrap();
        let base_url = format!("http://{}", gateway.address());

        let health = reqwest::get(format!("{base_url}/desktop/health"))
            .await
            .unwrap();
        assert_eq!(health.status(), reqwest::StatusCode::OK);
        assert_eq!(health.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(
            health.json::<serde_json::Value>().await.unwrap(),
            serde_json::json!({
                "status": "ok",
                "service": "penpot-desktop-gateway"
            })
        );

        let script = reqwest::get(format!("{base_url}/app.js")).await.unwrap();
        assert_eq!(script.text().await.unwrap(), "console.log('desktop')");

        gateway.stop().await.unwrap();
    }

    #[tokio::test]
    async fn falls_back_to_the_frontend_for_client_routes() {
        let frontend = frontend();
        let gateway = GatewayHandle::start(GatewayConfig {
            bind_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            frontend_root: frontend.path().to_owned(),
        })
        .await
        .unwrap();
        let response = reqwest::get(format!("http://{}/auth/login", gateway.address()))
            .await
            .unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "desktop index");

        gateway.stop().await.unwrap();
    }

    #[tokio::test]
    async fn refuses_to_start_without_a_frontend_entry_point() {
        let directory = tempfile::tempdir().unwrap();
        let result = GatewayHandle::start(GatewayConfig {
            bind_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            frontend_root: directory.path().to_owned(),
        })
        .await;

        assert!(matches!(result, Err(DesktopError::Gateway(_))));
    }
}
