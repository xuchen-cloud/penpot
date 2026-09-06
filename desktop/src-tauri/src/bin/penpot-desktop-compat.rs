use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use penpot_desktop_lib::compatibility::{
    CompatibilityPlan, PlanRunner, run_cache_compatibility, write_report,
};
use penpot_desktop_lib::credentials::SystemCredentialStore;
use penpot_desktop_lib::paths::InstancePaths;
use penpot_desktop_lib::runtime_manifest::{RuntimeManifest, current_target};

const RUNTIME_MANIFEST: &str = include_str!("../../runtime-manifest.json");

fn main() -> ExitCode {
    match run() {
        Ok(passed) if passed => ExitCode::SUCCESS,
        Ok(_) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> penpot_desktop_lib::error::Result<bool> {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|value| value == "credentials")
    {
        if arguments.len() != 1 {
            eprintln!("usage: penpot-desktop-compat credentials");
            return Ok(false);
        }
        SystemCredentialStore::new(uuid::Uuid::new_v4()).verify_roundtrip()?;
        println!("PASS credential-manager-roundtrip");
        return Ok(true);
    }
    if arguments.first().is_some_and(|value| value == "security") {
        if arguments.len() != 2 {
            eprintln!("usage: penpot-desktop-compat security <work-root>");
            return Ok(false);
        }
        let paths = InstancePaths::from_root(PathBuf::from(&arguments[1]));
        paths.create()?;
        #[cfg(windows)]
        paths.verify_private_acls()?;
        println!("PASS private-instance-acls");
        return Ok(true);
    }
    if arguments.first().is_some_and(|value| value == "cache") {
        if arguments.len() != 3 {
            eprintln!("usage: penpot-desktop-compat cache <host> <port>");
            return Ok(false);
        }
        let host = arguments[1].to_string_lossy();
        let port = arguments[2].to_string_lossy().parse().map_err(|error| {
            penpot_desktop_lib::error::DesktopError::Compatibility(format!(
                "invalid cache port: {error}"
            ))
        })?;
        for check in run_cache_compatibility(&host, port)? {
            println!("PASS {check}");
        }
        return Ok(true);
    }
    if arguments.len() != 4 {
        eprintln!(
            "usage: penpot-desktop-compat <plan.json> <runtime-root> <work-root> <report.json>"
        );
        return Ok(false);
    }
    let plan_path = PathBuf::from(&arguments[0]);
    let runtime_root = PathBuf::from(&arguments[1]);
    let work_root = PathBuf::from(&arguments[2]);
    let report_path = PathBuf::from(&arguments[3]);
    let plan = CompatibilityPlan::load(&plan_path)?;
    let target = current_target()?;
    if plan.target != target {
        return Err(penpot_desktop_lib::error::DesktopError::Compatibility(
            format!(
                "plan target {} does not match this host target {target}",
                plan.target
            ),
        ));
    }
    let manifest: RuntimeManifest = serde_json::from_str(RUNTIME_MANIFEST).map_err(|source| {
        penpot_desktop_lib::error::DesktopError::InvalidJson {
            path: "embedded runtime-manifest.json".into(),
            source,
        }
    })?;
    manifest.validate()?;
    manifest.verify_bundle(target, &runtime_root)?;
    let runner = PlanRunner::new(runtime_root, work_root, &plan.ports)?;
    let report = runner.run(&plan);
    write_report(&report_path, &report)?;
    println!("compatibility report: {}", report_path.display());
    Ok(report.passed)
}
