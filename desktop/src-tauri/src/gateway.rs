use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderValue, Request, Response, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::Response as AxumResponse;
use axum::routing::{any, get};
use axum::{Router, http};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::task::JoinHandle;
use tokio_util::io::ReaderStream;
use tokio_util::sync::CancellationToken;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::error::{DesktopError, Result};

pub const MAX_REQUEST_BODY_BYTES: usize = 350 * 1024 * 1024;

pub struct GatewayConfig {
    pub bind_address: SocketAddr,
    pub frontend_root: PathBuf,
    pub backend_address: SocketAddr,
    pub exporter_address: SocketAddr,
    pub asset_root: PathBuf,
}

#[derive(Clone)]
struct ProxyState {
    client: Client<HttpConnector, Body>,
    backend_address: SocketAddr,
    exporter_address: SocketAddr,
    asset_root: PathBuf,
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
        let listener = tokio::net::TcpListener::bind(config.bind_address)
            .await
            .map_err(|error| DesktopError::Gateway(error.to_string()))?;
        Self::start_on_listener(config, listener)
    }

    pub fn start_with_listener(
        config: GatewayConfig,
        listener: std::net::TcpListener,
    ) -> Result<Self> {
        validate_frontend_root(&config.frontend_root)?;
        listener
            .set_nonblocking(true)
            .map_err(|error| DesktopError::Gateway(error.to_string()))?;
        let listener = tokio::net::TcpListener::from_std(listener)
            .map_err(|error| DesktopError::Gateway(error.to_string()))?;
        Self::start_on_listener(config, listener)
    }

    fn start_on_listener(config: GatewayConfig, listener: tokio::net::TcpListener) -> Result<Self> {
        let address = listener
            .local_addr()
            .map_err(|error| DesktopError::Gateway(error.to_string()))?;
        if address.ip() != config.bind_address.ip()
            || (config.bind_address.port() != 0 && address.port() != config.bind_address.port())
        {
            return Err(DesktopError::Gateway(format!(
                "reserved gateway address {address} does not match {}",
                config.bind_address
            )));
        }
        let cancellation = CancellationToken::new();
        let shutdown = cancellation.clone();
        let router = router(config);
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

fn router(config: GatewayConfig) -> Router {
    router_with_body_limit(config, MAX_REQUEST_BODY_BYTES)
}

fn router_with_body_limit(config: GatewayConfig, body_limit: usize) -> Router {
    let index = config.frontend_root.join("index.html");
    let frontend = ServeDir::new(config.frontend_root).fallback(ServeFile::new(index));
    let public_origin = format!("http://localhost:{}/", config.bind_address.port());
    let state = ProxyState {
        client: Client::builder(TokioExecutor::new()).build_http(),
        backend_address: config.backend_address,
        exporter_address: config.exporter_address,
        asset_root: config.asset_root,
    };

    Router::new()
        .route("/desktop/health", get(health))
        .route(
            "/js/config.js",
            get(move || async move { frontend_config(&public_origin) }),
        )
        .route("/api/export", any(proxy_exporter))
        .route("/api/export/{*path}", any(proxy_exporter))
        .route("/api", any(proxy_backend))
        .route("/api/{*path}", any(proxy_backend))
        .route("/assets", any(proxy_backend))
        .route("/assets/{*path}", any(proxy_backend))
        .route("/readyz", any(proxy_backend))
        .route("/ws/notifications", any(proxy_backend))
        .fallback_service(frontend)
        .layer(RequestBodyLimitLayer::new(body_limit))
        .layer(middleware::from_fn(plugin_response_headers))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .with_state(state)
}

async fn plugin_response_headers(request: axum::extract::Request, next: Next) -> AxumResponse {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    let plugin_path = path.starts_with("/plugins/web-to-penpot/");
    response.headers_mut().insert(
        http::header::X_FRAME_OPTIONS,
        HeaderValue::from_static(if plugin_path { "SAMEORIGIN" } else { "DENY" }),
    );
    let value = match path.as_str() {
        "/plugins/web-to-penpot/manifest.json"
        | "/plugins/web-to-penpot/plugin.js"
        | "/plugins/web-to-penpot/index.html" => Some("no-cache"),
        _ if path.starts_with("/plugins/web-to-penpot/assets/") => {
            Some("public, max-age=31536000, immutable")
        }
        _ => None,
    };
    if let Some(value) = value {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    }
    response
}

fn frontend_config(public_origin: &str) -> Response<Body> {
    let public_origin = serde_json::to_string(public_origin)
        .expect("serializing a fixed localhost origin cannot fail");
    Response::builder()
        .header(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(format!(
            "globalThis.penpotPublicURI = {public_origin};\n"
        )))
        .expect("the generated frontend configuration is valid")
}

async fn proxy_backend(State(state): State<ProxyState>, request: Request<Body>) -> Response<Body> {
    proxy(state.clone(), request, state.backend_address).await
}

async fn proxy_exporter(State(state): State<ProxyState>, request: Request<Body>) -> Response<Body> {
    proxy(state.clone(), request, state.exporter_address).await
}

async fn proxy(
    state: ProxyState,
    mut request: Request<Body>,
    target: SocketAddr,
) -> Response<Body> {
    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let uri = match format!("http://{target}{path}").parse() {
        Ok(uri) => uri,
        Err(_) => return gateway_error("invalid upstream request URI"),
    };
    *request.uri_mut() = uri;
    let Ok(host) = HeaderValue::from_str(&target.to_string()) else {
        return gateway_error("invalid upstream host");
    };
    request.headers_mut().insert(header::HOST, host);
    let range = request.headers().get(header::RANGE).cloned();
    let websocket = request
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"));
    let downstream_upgrade = websocket.then(|| hyper::upgrade::on(&mut request));
    let mut response = match state.client.request(request).await {
        Ok(response) => response,
        Err(error) if caused_by_length_limit(&error) => {
            return Response::builder()
                .status(StatusCode::PAYLOAD_TOO_LARGE)
                .body(Body::empty())
                .expect("fixed payload-too-large response is valid");
        }
        Err(error) => return gateway_error(&format!("upstream request failed: {error}")),
    };
    if let Some(redirect) = response.headers().get("x-accel-redirect").cloned() {
        return serve_asset(&state.asset_root, redirect, range, response.headers()).await;
    }
    if response.status() == StatusCode::SWITCHING_PROTOCOLS
        && let Some(downstream_upgrade) = downstream_upgrade
    {
        let upstream_upgrade = hyper::upgrade::on(&mut response);
        tokio::spawn(async move {
            let (Ok(downstream), Ok(upstream)) = tokio::join!(downstream_upgrade, upstream_upgrade)
            else {
                return;
            };
            let mut downstream = TokioIo::new(downstream);
            let mut upstream = TokioIo::new(upstream);
            let _ = tokio::io::copy_bidirectional(&mut downstream, &mut upstream).await;
        });
    }
    response.map(Body::new)
}

fn caused_by_length_limit(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        if error.is::<http_body_util::LengthLimitError>() {
            return true;
        }
        current = error.source();
    }
    false
}

async fn serve_asset(
    asset_root: &Path,
    redirect: HeaderValue,
    range: Option<HeaderValue>,
    upstream_headers: &http::HeaderMap,
) -> Response<Body> {
    let Ok(redirect) = redirect.to_str() else {
        return gateway_error("invalid internal asset path");
    };
    let Some(relative) = redirect.strip_prefix("/internal/assets/") else {
        return gateway_error("invalid internal asset path");
    };
    let relative = Path::new(relative);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return gateway_error("invalid internal asset path");
    }
    let path = asset_root.join(relative);
    let Ok(root) = tokio::fs::canonicalize(asset_root).await else {
        return gateway_error("asset storage is unavailable");
    };
    let Ok(canonical) = tokio::fs::canonicalize(&path).await else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .expect("fixed response is valid");
    };
    if !canonical.starts_with(root) {
        return gateway_error("internal asset path escapes storage");
    }
    let Ok(mut file) = tokio::fs::File::open(canonical).await else {
        return gateway_error("could not open internal asset");
    };
    let Ok(metadata) = file.metadata().await else {
        return gateway_error("could not inspect internal asset");
    };
    let length = metadata.len();
    let requested = match range.as_ref() {
        Some(value) => match value
            .to_str()
            .ok()
            .and_then(|value| parse_single_range(value, length))
        {
            Some(range) => Some(range),
            None => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                    .body(Body::empty())
                    .expect("fixed range response is valid");
            }
        },
        None => None,
    };
    let (status, start, end) = requested
        .map(|(start, end)| (StatusCode::PARTIAL_CONTENT, start, end))
        .unwrap_or((StatusCode::OK, 0, length.saturating_sub(1)));
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return gateway_error("could not seek internal asset");
    }
    let body_length = if length == 0 { 0 } else { end - start + 1 };
    let stream = ReaderStream::new(file.take(body_length));
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_LENGTH, body_length)
        .header(header::ACCEPT_RANGES, "bytes");
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{length}"),
        );
    }
    for name in [
        header::CONTENT_TYPE,
        header::CACHE_CONTROL,
        header::CONTENT_DISPOSITION,
    ] {
        if let Some(value) = upstream_headers.get(&name) {
            builder = builder.header(name, value);
        }
    }
    builder
        .body(Body::from_stream(stream))
        .expect("validated asset headers form a response")
}

fn parse_single_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?;
    if value.contains(',') || length == 0 {
        return None;
    }
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(length);
        return (suffix > 0).then_some((length - suffix, length - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= length {
        return None;
    }
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<u64>().ok()?.min(length - 1)
    };
    (start <= end).then_some((start, end))
}

fn gateway_error(message: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(message.to_owned()))
        .expect("the fixed gateway error response is valid")
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
    use tower::ServiceExt;

    fn frontend() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("index.html"), "desktop index").unwrap();
        fs::write(directory.path().join("app.js"), "console.log('desktop')").unwrap();
        let plugin = directory.path().join("plugins/web-to-penpot");
        fs::create_dir_all(plugin.join("assets")).unwrap();
        fs::write(plugin.join("manifest.json"), "{}").unwrap();
        fs::write(plugin.join("plugin.js"), "plugin").unwrap();
        fs::write(plugin.join("index.html"), "plugin ui").unwrap();
        fs::write(plugin.join("assets/index-hash.css"), "styles").unwrap();
        directory
    }

    fn unused_upstream() -> SocketAddr {
        "127.0.0.1:9".parse().unwrap()
    }

    async fn upstream(body: &'static str) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().fallback(move || async move { body });
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (address, task)
    }

    async fn body_consuming_upstream() -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().fallback(|request: Request<Body>| async move {
            let _ = axum::body::to_bytes(request.into_body(), usize::MAX).await;
            StatusCode::OK
        });
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (address, task)
    }

    #[tokio::test]
    async fn serves_health_and_static_frontend_on_loopback() {
        let frontend = frontend();
        let gateway = GatewayHandle::start(GatewayConfig {
            bind_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            frontend_root: frontend.path().to_owned(),
            backend_address: unused_upstream(),
            exporter_address: unused_upstream(),
            asset_root: frontend.path().to_owned(),
        })
        .await
        .unwrap();
        let base_url = format!("http://{}", gateway.address());

        let health = reqwest::get(format!("{base_url}/desktop/health"))
            .await
            .unwrap();
        assert_eq!(health.status(), reqwest::StatusCode::OK);
        assert_eq!(health.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(health.headers()[header::X_FRAME_OPTIONS], "DENY");
        assert_eq!(
            health.json::<serde_json::Value>().await.unwrap(),
            serde_json::json!({
                "status": "ok",
                "service": "penpot-desktop-gateway"
            })
        );

        let script = reqwest::get(format!("{base_url}/app.js")).await.unwrap();
        assert_eq!(script.text().await.unwrap(), "console.log('desktop')");

        for path in ["manifest.json", "plugin.js", "index.html"] {
            let plugin = reqwest::get(format!("{base_url}/plugins/web-to-penpot/{path}"))
                .await
                .unwrap();
            assert_eq!(plugin.headers()[header::X_FRAME_OPTIONS], "SAMEORIGIN");
            assert_eq!(plugin.headers()[header::CACHE_CONTROL], "no-cache");
        }

        let asset = reqwest::get(format!(
            "{base_url}/plugins/web-to-penpot/assets/index-hash.css"
        ))
        .await
        .unwrap();
        assert_eq!(
            asset.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );

        gateway.stop().await.unwrap();
    }

    #[tokio::test]
    async fn falls_back_to_the_frontend_for_client_routes() {
        let frontend = frontend();
        let gateway = GatewayHandle::start(GatewayConfig {
            bind_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            frontend_root: frontend.path().to_owned(),
            backend_address: unused_upstream(),
            exporter_address: unused_upstream(),
            asset_root: frontend.path().to_owned(),
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
    async fn serves_generated_frontend_configuration_without_changing_the_bundle() {
        let frontend = frontend();
        let app = router(GatewayConfig {
            bind_address: "127.0.0.1:9001".parse().unwrap(),
            frontend_root: frontend.path().to_owned(),
            backend_address: unused_upstream(),
            exporter_address: unused_upstream(),
            asset_root: frontend.path().to_owned(),
        });

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/js/config.js?version=test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            body,
            "globalThis.penpotPublicURI = \"http://localhost:9001/\";\n"
        );
    }

    #[tokio::test]
    async fn rejects_proxy_requests_larger_than_the_configured_limit() {
        let frontend = frontend();
        let (backend_address, backend) = body_consuming_upstream().await;
        let app = router_with_body_limit(
            GatewayConfig {
                bind_address: "127.0.0.1:9001".parse().unwrap(),
                frontend_root: frontend.path().to_owned(),
                backend_address,
                exporter_address: unused_upstream(),
                asset_root: frontend.path().to_owned(),
            },
            2,
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api")
                    .body(Body::from("too large"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        backend.abort();
    }

    #[tokio::test]
    async fn refuses_to_start_without_a_frontend_entry_point() {
        let directory = tempfile::tempdir().unwrap();
        let result = GatewayHandle::start(GatewayConfig {
            bind_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            frontend_root: directory.path().to_owned(),
            backend_address: unused_upstream(),
            exporter_address: unused_upstream(),
            asset_root: directory.path().to_owned(),
        })
        .await;

        assert!(matches!(result, Err(DesktopError::Gateway(_))));
    }

    #[tokio::test]
    async fn sends_api_and_export_requests_to_the_right_service() {
        let frontend = frontend();
        let (backend_address, backend) = upstream("backend").await;
        let (exporter_address, exporter) = upstream("exporter").await;
        let gateway = GatewayHandle::start(GatewayConfig {
            bind_address: "127.0.0.1:0".parse().unwrap(),
            frontend_root: frontend.path().to_owned(),
            backend_address,
            exporter_address,
            asset_root: frontend.path().to_owned(),
        })
        .await
        .unwrap();

        let api = reqwest::get(format!("http://{}/api/profile", gateway.address()))
            .await
            .unwrap();
        let export = reqwest::get(format!("http://{}/api/export/file", gateway.address()))
            .await
            .unwrap();
        assert_eq!(api.text().await.unwrap(), "backend");
        assert_eq!(export.text().await.unwrap(), "exporter");

        gateway.stop().await.unwrap();
        backend.abort();
        exporter.abort();
    }

    #[tokio::test]
    async fn serves_internal_assets_with_byte_ranges() {
        let assets = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(assets.path().join("ab")).unwrap();
        std::fs::write(assets.path().join("ab/object"), b"0123456789").unwrap();
        let headers = http::HeaderMap::from_iter([(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        )]);

        let response = serve_asset(
            assets.path(),
            HeaderValue::from_static("/internal/assets/ab/object"),
            Some(HeaderValue::from_static("bytes=2-5")),
            &headers,
        )
        .await;

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        let bytes = axum::body::to_bytes(response.into_body(), 16)
            .await
            .unwrap();
        assert_eq!(&bytes[..], b"2345");
    }

    #[test]
    fn rejects_invalid_or_multiple_ranges() {
        assert_eq!(parse_single_range("bytes=2-5", 10), Some((2, 5)));
        assert_eq!(parse_single_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(parse_single_range("bytes=4-", 10), Some((4, 9)));
        assert_eq!(parse_single_range("bytes=2-5,7-8", 10), None);
        assert_eq!(parse_single_range("bytes=10-11", 10), None);
    }
}
