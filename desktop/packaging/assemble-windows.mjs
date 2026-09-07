import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { auditWindowsRuntime } from "./audit-windows-runtime.mjs";
import { validateFrontendOutput } from "./frontend-artifacts.mjs";
import { installSharedArtifacts, verifySharedArtifacts } from "./shared-artifacts.mjs";
import { desktopRoot, run } from "./verify.mjs";
import { invokeTool, resolveToolCommand } from "./tool-command.mjs";
import { defaultPreparedRoot, validateWindowsMetadata, WINDOWS_TARGET } from "./windows-runtime.mjs";

const repo = resolve(desktopRoot, "..");
const metadataPath = join(desktopRoot, "packaging", "runtime-metadata.windows.json");
const finalRuntime = join(desktopRoot, "src-tauri", "resources", "runtime", WINDOWS_TARGET);

async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function required(path, label) { if (!(await exists(path))) throw new Error(`${label} is missing: ${path}`); return path; }

async function copy(path, destination) {
  await required(path, "runtime input");
  await mkdir(dirname(destination), { recursive: true });
  await cp(path, destination, { recursive: true, dereference: true });
}

async function pruneUnusedPostgresTools(runtimeRoot) {
  await rm(join(runtimeRoot, "postgres", "pgAdmin 4"), { recursive: true, force: true });
  const libraryRoot = join(runtimeRoot, "postgres", "lib");
  for (const name of await readdir(libraryRoot)) {
    if (/(?:plperl|plpython3|pltcl)\.dll$/i.test(name)) {
      await rm(join(libraryRoot, name), { force: true });
    }
  }
}

async function pruneUnusedFontForgeTests(runtimeRoot) {
  await rm(
    join(runtimeRoot, "tools", "fontforge", "lib", "python3.12", "site-packages", "pkg_resources", "tests"),
    { recursive: true, force: true },
  );
}

async function prunePackagingOnlyFiles(runtimeRoot) {
  const imageMagick = join(runtimeRoot, "tools", "imagemagick");
  for (const name of await readdir(imageMagick)) {
    if (name.toLowerCase().endsWith(".exe") && name.toLowerCase() !== "magick.exe") {
      await rm(join(imageMagick, name), { force: true });
    }
  }
  for (const root of [runtimeRoot, join(runtimeRoot, "frontend")]) {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name.toLowerCase();
      if (name.endsWith(".pdb") || name.endsWith(".lib") || name.endsWith(".map")) {
        await rm(join(entry.parentPath, entry.name), { force: true });
      }
    }
  }
  await rm(join(runtimeRoot, "chromium", "setup.exe"), { force: true });
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows runtime assembly requires a Windows x64 host");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const entries = validateWindowsMetadata(metadata);
  const prepared = defaultPreparedRoot(desktopRoot);
  const version = process.env.VERSION || "2.17.0-desktop.1";
  const sharedRoot = resolve(process.env.PENPOT_SHARED_ARTIFACT_ROOT || join(desktopRoot, "target", "shared-artifacts", version));
  await verifySharedArtifacts(sharedRoot);

  const staging = `${finalRuntime}.staging-${randomUUID()}`;
  const replaced = `${finalRuntime}.replaced-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    for (const entry of entries.filter((value) => value.runtimePath)) {
      await copy(join(prepared, entry.destination), join(staging, entry.runtimePath));
    }
    await pruneUnusedPostgresTools(staging);
    await pruneUnusedFontForgeTests(staging);
    for (const [source, destination] of [
      ["garnet", "garnet"],
      ["woff", "tools/woff"],
      ["woff2", "tools/woff2"],
    ]) await copy(join(prepared, source), join(staging, destination));

    const pnpmStore = process.env.PENPOT_PNPM_STORE || join(desktopRoot, ".cache", "pnpm-store");
    const pnpmState = process.env.PENPOT_PNPM_STATE || join(desktopRoot, ".cache", "pnpm-state");
    const pnpmEnv = {
      ...process.env,
      COREPACK_HOME: process.env.PENPOT_COREPACK_HOME || join(desktopRoot, ".cache", "corepack"),
      NPM_CONFIG_STATE_DIR: pnpmState,
      NPM_CONFIG_STORE_DIR: pnpmStore,
    };
    const pnpm = resolveToolCommand({ env: pnpmEnv, name: "PENPOT_BUILD_PNPM", fallback: "pnpm" });
    for (const module of ["media-processor", "exporter"]) {
      const source = join(repo, module);
      const destination = join(staging, module);
      await mkdir(destination, { recursive: true });
      for (const manifest of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
        await copy(join(source, manifest), join(destination, manifest));
      }
      const bootstrap = [
        "--config.package-manager-strict-version=false",
        "--config.node-linker=hoisted",
        "--store-dir",
        pnpmStore,
        "--state-dir",
        pnpmState,
        "--dir",
        destination,
      ];
      invokeTool(
        run,
        pnpm,
        [...bootstrap, "install", "--prod", "--frozen-lockfile"],
        desktopRoot,
        pnpmEnv,
      );
    }
    await installSharedArtifacts(sharedRoot, staging);
    await validateFrontendOutput(join(staging, "frontend"));
    await prunePackagingOnlyFiles(staging);
    run(process.execPath, [join(desktopRoot, "compatibility", "prepare-runtime.mjs"), staging], desktopRoot);

    const audit = await auditWindowsRuntime(staging);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(staging, "runtime-audit.windows.json"), `${JSON.stringify(audit, null, 2)}\n`));
    if (!audit.passed) {
      const sample = audit.unresolved
        .slice(0, 20)
        .map(({ binary, library }) => `${binary} -> ${library}`)
        .join(", ");
      throw new Error(`Windows runtime has ${audit.unresolved.length} unresolved DLL import(s): ${sample}`);
    }
    run("cargo", ["run", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--bin", "penpot-runtime-lock", "--", "src-tauri/runtime-manifest.json", metadataPath, WINDOWS_TARGET, staging, join(staging, "runtime-lock.json")], desktopRoot);
    run("cargo", ["run", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--bin", "penpot-runtime-lock", "--", "--verify", "src-tauri/runtime-manifest.json", WINDOWS_TARGET, staging], desktopRoot);

    if (await exists(finalRuntime)) await rename(finalRuntime, replaced);
    await rename(staging, finalRuntime);
    await rm(replaced, { recursive: true, force: true });
    console.log(`Assembled ${finalRuntime}`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if ((await exists(replaced)) && !(await exists(finalRuntime))) await rename(replaced, finalRuntime);
    throw error;
  }
}

main().catch((error) => { console.error(`Windows runtime assembly stopped: ${error.message}`); process.exitCode = 1; });
