pub mod config;
pub mod error;
pub mod gateway;
pub mod paths;
pub mod ports;
pub mod runtime_manifest;
pub mod supervisor;

use std::sync::atomic::{AtomicBool, Ordering};

use directories::BaseDirs;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State, WindowEvent};

use crate::config::DesktopConfig;
use crate::error::{DesktopError, Result};
use crate::paths::InstancePaths;
use crate::runtime_manifest::{RuntimeManifest, current_target};

const RUNTIME_MANIFEST: &str = include_str!("../runtime-manifest.json");

struct AppState {
    quitting: AtomicBool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    phase: RuntimePhase,
    title: &'static str,
    detail: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum RuntimePhase {
    NotInitialized,
    Ready,
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
        });
    }
    DesktopConfig::load(&paths.config_file())?;

    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|_| DesktopError::MissingDataDirectory)?
        .join("runtime")
        .join(current_target()?);
    match manifest()?.verify_bundle(current_target()?, &resource_root) {
        Ok(()) => Ok(RuntimeStatus {
            phase: RuntimePhase::Ready,
            title: "Runtime bundle is ready",
            detail: "The local services can be started without downloading dependencies."
                .to_owned(),
        }),
        Err(error) => Ok(RuntimeStatus {
            phase: RuntimePhase::MissingRuntime,
            title: "Runtime bundle is incomplete",
            detail: error.to_string(),
        }),
    }
}

#[tauri::command]
fn get_runtime_status(app: AppHandle) -> Result<RuntimeStatus> {
    status(&app)
}

#[tauri::command]
fn initialize_instance(app: AppHandle, admin_email: String) -> Result<RuntimeStatus> {
    let paths = instance_paths(&app)?;
    paths.create()?;
    if !paths.config_file().exists() {
        DesktopConfig::new(&admin_email)?.save(&paths.config_file())?;
    }
    status(&app)
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<'_, AppState>) {
    state.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
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
                app.state::<AppState>()
                    .quitting
                    .store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            quitting: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_status,
            initialize_instance,
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
}
