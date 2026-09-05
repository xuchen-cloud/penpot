use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use penpot_desktop_lib::runtime_lock::{ComponentMetadataManifest, RuntimeLock};
use penpot_desktop_lib::runtime_manifest::RuntimeManifest;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> penpot_desktop_lib::error::Result<()> {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.len() == 4 && arguments[0] == "--verify" {
        let path = PathBuf::from(&arguments[1]);
        let bytes = std::fs::read(&path).map_err(|source| {
            penpot_desktop_lib::error::DesktopError::ReadFile {
                path: path.clone(),
                source,
            }
        })?;
        let manifest: RuntimeManifest = serde_json::from_slice(&bytes).map_err(|source| {
            penpot_desktop_lib::error::DesktopError::InvalidJson { path, source }
        })?;
        manifest.validate()?;
        let root = PathBuf::from(&arguments[3]);
        let target = arguments[2].to_string_lossy();
        manifest.verify_bundle(&target, &root)?;
        RuntimeLock::load(&root.join("runtime-lock.json"))?.verify(&manifest, &target, &root)?;
        println!("verified runtime: {}", root.display());
        return Ok(());
    }
    if arguments.len() != 5 {
        eprintln!(
            "usage: penpot-runtime-lock <runtime-manifest.json> <component-metadata.json> <target> <runtime-root> <output>"
        );
        return Err(penpot_desktop_lib::error::DesktopError::RuntimeIntegrity(
            "invalid command arguments".to_owned(),
        ));
    }
    let manifest_path = PathBuf::from(&arguments[0]);
    let metadata_path = PathBuf::from(&arguments[1]);
    let target = arguments[2].to_string_lossy();
    let runtime_root = PathBuf::from(&arguments[3]);
    let output = PathBuf::from(&arguments[4]);
    let manifest_bytes = std::fs::read(&manifest_path).map_err(|source| {
        penpot_desktop_lib::error::DesktopError::ReadFile {
            path: manifest_path.clone(),
            source,
        }
    })?;
    let manifest: RuntimeManifest = serde_json::from_slice(&manifest_bytes).map_err(|source| {
        penpot_desktop_lib::error::DesktopError::InvalidJson {
            path: manifest_path,
            source,
        }
    })?;
    let metadata = ComponentMetadataManifest::load(&metadata_path)?;
    let lock = RuntimeLock::build(&manifest, &metadata, &target, &runtime_root)?;
    lock.save(&output)?;
    lock.verify(&manifest, &target, &runtime_root)?;
    println!("runtime lock: {}", output.display());
    Ok(())
}
