pub mod bootstrap;
pub mod compatibility;
pub mod config;
pub mod credentials;
pub mod error;
pub mod gateway;
pub mod instance_lock;
pub mod local_stack;
pub mod paths;
pub mod ports;
pub mod runtime;
pub mod runtime_lock;
pub mod runtime_manifest;
pub mod supervisor;

use std::sync::atomic::{AtomicBool, Ordering};

use directories::BaseDirs;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State, WindowEvent};

use crate::config::DesktopConfig;
use crate::credentials::{CredentialStore, SystemCredentialStore};
use crate::error::{DesktopError, Result};
use crate::paths::InstancePaths;
use crate::runtime::LocalRuntime;
use crate::runtime_lock::RuntimeLock;
use crate::runtime_manifest::{RuntimeManifest, current_target};

const RUNTIME_MANIFEST: &str = include_str!("../runtime-manifest.json");

struct AppState {
    quitting: AtomicBool,
    runtime: tokio::sync::Mutex<Option<LocalRuntime>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    phase: RuntimePhase,
    title: &'static str,
    detail: String,
    public_url: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum RuntimePhase {
    NotInitialized,
    Ready,
    Running,
    MissingRuntime,
}

fn instance_paths(_app: &AppHandle) -> Result<InstancePaths> {
    let base = BaseDirs::new().ok_or(DesktopError::MissingDataDirectory)?;
    let root = platform_instance_root(base.data_local_dir(), std::env::consts::OS)?;
    Ok(InstancePaths::from_root(root))
}

fn platform_instance_root(base: &std::path::Path, os: &str) -> Result<std::path::PathBuf> {
    match os {
        "macos" => Ok(base.join("Penpot Desktop")),
        "windows" => Ok(base.join("xuchen-cloud").join("Penpot Desktop")),
        _ => Err(DesktopError::MissingDataDirectory),
    }
}

fn platform_runtime_root(path: std::path::PathBuf, os: &str) -> std::path::PathBuf {
    if os != "windows" {
        return path;
    }
    let value = path.to_string_lossy();
    if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{path}"));
    }
    if let Some(path) = value.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(path);
    }
    path
}

fn manifest() -> Result<RuntimeManifest> {
    let manifest: RuntimeManifest =
        serde_json::from_str(RUNTIME_MANIFEST).map_err(|source| DesktopError::InvalidJson {
            path: "embedded runtime-manifest.json".into(),
            source,
        })?;
    manifest.validate()?;
    Ok(manifest)
}

fn status(app: &AppHandle) -> Result<RuntimeStatus> {
    let paths = instance_paths(app)?;
    if !paths.config_file().is_file() {
        return Ok(RuntimeStatus {
            phase: RuntimePhase::NotInitialized,
            title: "This computer is not initialized",
            detail:
                "Create the private data directories and local runtime configuration to continue."
                    .to_owned(),
            public_url: None,
        });
    }
    DesktopConfig::load(&paths.config_file())?;

    let verification = verify_runtime(app).map(|_| ());
    match verification {
        Ok(()) => Ok(RuntimeStatus {
            phase: RuntimePhase::Ready,
            title: "Runtime bundle is ready",
            detail: "The local services can be started without downloading dependencies."
                .to_owned(),
            public_url: None,
        }),
        Err(error) => Ok(RuntimeStatus {
            phase: RuntimePhase::MissingRuntime,
            title: "Runtime bundle is incomplete",
            detail: error.to_string(),
            public_url: None,
        }),
    }
}

fn verify_runtime(app: &AppHandle) -> Result<(RuntimeManifest, String, std::path::PathBuf)> {
    let target = current_target()?.to_owned();
    let resource_root = platform_runtime_root(
        app.path()
            .resource_dir()
            .map_err(|_| DesktopError::MissingDataDirectory)?
            .join("runtime")
            .join(&target),
        std::env::consts::OS,
    );
    let manifest = manifest()?;
    manifest.verify_bundle(&target, &resource_root)?;
    RuntimeLock::load(&resource_root.join("runtime-lock.json"))?.verify(
        &manifest,
        &target,
        &resource_root,
    )?;
    Ok((manifest, target, resource_root))
}

#[tauri::command]
async fn get_runtime_status(app: AppHandle, state: State<'_, AppState>) -> Result<RuntimeStatus> {
    let mut runtime = state.runtime.lock().await;
    if let Some(runtime) = runtime.as_mut() {
        let processes = runtime.statuses()?;
        if processes
            .iter()
            .all(|process| process.state == crate::supervisor::ProcessState::Running)
        {
            let paths = instance_paths(&app)?;
            let config = DesktopConfig::load(&paths.config_file())?;
            return Ok(running_status(config.public_port));
        }
        return Err(DesktopError::Process(
            "one or more local services exited unexpectedly".to_owned(),
        ));
    }
    status(&app)
}

#[tauri::command]
async fn initialize_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    admin_email: String,
) -> Result<RuntimeStatus> {
    let paths = instance_paths(&app)?;
    paths.create()?;
    let config = if paths.config_file().exists() {
        DesktopConfig::load(&paths.config_file())?
    } else {
        let config = DesktopConfig::new(&admin_email)?;
        config.save(&paths.config_file())?;
        config
    };
    start_configured_runtime(&app, &state, &paths, &config).await
}

#[tauri::command]
async fn start_instance(app: AppHandle, state: State<'_, AppState>) -> Result<RuntimeStatus> {
    let paths = instance_paths(&app)?;
    let config = DesktopConfig::load(&paths.config_file())?;
    start_configured_runtime(&app, &state, &paths, &config).await
}

async fn start_configured_runtime(
    app: &AppHandle,
    state: &State<'_, AppState>,
    paths: &InstancePaths,
    config: &DesktopConfig,
) -> Result<RuntimeStatus> {
    let credential_store = SystemCredentialStore::new(config.installation_id);
    let secrets = credential_store.load_or_create()?;
    let (manifest, target, runtime_root) = verify_runtime(app)?;
    let mut runtime = state.runtime.lock().await;
    if runtime.is_none() {
        *runtime = Some(
            LocalRuntime::start(&manifest, &target, &runtime_root, paths, config, &secrets).await?,
        );
    }
    let processes = runtime
        .as_mut()
        .expect("the runtime was started")
        .statuses()?;
    if processes
        .iter()
        .any(|process| process.state != crate::supervisor::ProcessState::Running)
    {
        return Err(DesktopError::Process(
            "one or more local services exited during startup".to_owned(),
        ));
    }
    Ok(running_status(config.public_port))
}

fn running_status(public_port: u16) -> RuntimeStatus {
    RuntimeStatus {
        phase: RuntimePhase::Running,
        title: "Penpot is running",
        detail: "All local services are ready on this computer.".to_owned(),
        public_url: Some(format!("http://localhost:{public_port}/")),
    }
}

#[tauri::command]
async fn quit_app(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    state.quitting.store(true, Ordering::SeqCst);
    if let Some(runtime) = state.runtime.lock().await.as_mut() {
        runtime.stop().await?;
    }
    app.exit(0);
    Ok(())
}

fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Penpot Desktop", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Penpot Desktop", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    state.quitting.store(true, Ordering::SeqCst);
                    if let Some(runtime) = state.runtime.lock().await.as_mut() {
                        let _ = runtime.stop().await;
                    }
                    app.exit(0);
                });
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(AppState {
            quitting: AtomicBool::new(false),
            runtime: tokio::sync::Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_status,
            initialize_instance,
            start_instance,
            quit_app
        ])
        .setup(|app| {
            install_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Penpot Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_runtime_manifest_is_valid() {
        manifest().unwrap();
    }

    #[test]
    fn embedded_manifest_covers_the_release_targets() {
        let manifest = manifest().unwrap();
        assert!(manifest.targets.contains_key("aarch64-apple-darwin"));
        assert!(manifest.targets.contains_key("x86_64-pc-windows-msvc"));
    }

    #[test]
    fn uses_the_product_data_directory_on_macos() {
        let root =
            platform_instance_root(std::path::Path::new("/Application Support"), "macos").unwrap();
        assert_eq!(
            root,
            std::path::Path::new("/Application Support/Penpot Desktop")
        );
    }

    #[test]
    fn uses_the_vendor_and_product_data_directory_on_windows() {
        let root =
            platform_instance_root(std::path::Path::new("/LocalAppData"), "windows").unwrap();
        assert_eq!(
            root,
            std::path::Path::new("/LocalAppData/xuchen-cloud/Penpot Desktop")
        );
    }

    #[test]
    fn strips_windows_verbatim_prefix_from_the_runtime_root() {
        let root = platform_runtime_root(
            std::path::PathBuf::from(
                r"\\?\D:\Program Files\Penpot Desktop\runtime\x86_64-pc-windows-msvc",
            ),
            "windows",
        );

        assert_eq!(
            root,
            std::path::Path::new(r"D:\Program Files\Penpot Desktop\runtime\x86_64-pc-windows-msvc")
        );
    }

    #[test]
    fn converts_windows_verbatim_unc_runtime_roots() {
        let root = platform_runtime_root(
            std::path::PathBuf::from(r"\\?\UNC\server\share\Penpot Desktop\runtime"),
            "windows",
        );

        assert_eq!(
            root,
            std::path::Path::new(r"\\server\share\Penpot Desktop\runtime")
        );
    }

    #[test]
    fn leaves_non_windows_runtime_roots_unchanged() {
        let root = std::path::PathBuf::from("/Applications/Penpot Desktop.app/Contents/Resources");

        assert_eq!(platform_runtime_root(root.clone(), "macos"), root);
    }
}
