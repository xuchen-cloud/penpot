import { access, cp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { desktopRoot, run } from "./verify.mjs";
import { relocateMacos } from "./relocate-macos.mjs";

const repo = resolve(desktopRoot, "..");
const target = "aarch64-apple-darwin";
const runtime = join(desktopRoot, "src-tauri/resources/runtime", target);
const required = async (path, label) => { try { await access(path); return path; } catch { throw new Error(`${label} is missing: ${path}`); } };
const input = (name, fallback) => process.env[name] || fallback;

async function copy(path, destination) {
  await required(path, "runtime input");
  await mkdir(dirname(destination), { recursive: true });
  await cp(path, destination, { recursive: true, dereference: true });
}

try {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("macOS runtime assembly requires an Apple Silicon host");
  const tools = {
    fontforge: input("PENPOT_FONTFORGE", "/opt/homebrew/bin/fontforge"),
    sfnt2woff: input("PENPOT_SFNT2WOFF", "/opt/homebrew/bin/sfnt2woff"),
    woff2sfnt: input("PENPOT_WOFF2SFNT", "/opt/homebrew/bin/woff2sfnt"),
    woff2_decompress: input("PENPOT_WOFF2_DECOMPRESS", "/opt/homebrew/bin/woff2_decompress"),
    convert: input("PENPOT_CONVERT", "/opt/homebrew/bin/convert"),
    potrace: input("PENPOT_POTRACE", "/opt/homebrew/bin/potrace"),
  };
  for (const [name, path] of Object.entries(tools)) await required(path, name);
  for (const [path, label] of [
    [join(repo, "backend/target/penpot.jar"), "Backend JAR"],
    [join(repo, "frontend/resources/public/index.html"), "frontend"],
    [join(repo, "exporter/target/app.js"), "Exporter"],
    [join(repo, "exporter/resources/wasm/render-wasm.wasm"), "Exporter WASM"],
    [join(repo, "media-processor/dist/index.js"), "Media Processor"],
  ]) await required(path, label);
  await rm(runtime, { recursive: true, force: true });
  await mkdir(runtime, { recursive: true });

  await copy(await realpath(input("PENPOT_POSTGRES_HOME", "/opt/homebrew/opt/postgresql@15")), join(runtime, "postgres"));
  await copy(input("PENPOT_VALKEY", "/opt/homebrew/opt/valkey/bin/valkey-server"), join(runtime, "valkey/bin/valkey-server"));
  await copy(input("PENPOT_NODE", "/tmp/node-v22.18.0-darwin-arm64/bin/node"), join(runtime, "node/bin/node"));
  await copy(input("PENPOT_JDK_HOME", "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home"), join(runtime, "jre"));
  await copy(join(repo, "backend/target/penpot.jar"), join(runtime, "backend/penpot.jar"));
  await copy(join(repo, "frontend/resources/public"), join(runtime, "frontend"));

  const deploy = join(runtime, ".deploy");
  run("pnpm", ["--dir", join(repo, "media-processor"), "deploy", "--prod", join(deploy, "media-processor")]);
  await copy(join(repo, "media-processor/dist/index.js"), join(deploy, "media-processor/index.js"));
  await cp(join(deploy, "media-processor"), join(runtime, "media-processor"), { recursive: true });
  run("pnpm", ["--dir", join(repo, "exporter"), "deploy", "--prod", join(deploy, "exporter")]);
  await copy(join(repo, "exporter/target/app.js"), join(deploy, "exporter/app.js"));
  await copy(join(repo, "exporter/resources/wasm"), join(deploy, "exporter/resources/wasm"));
  await cp(join(deploy, "exporter"), join(runtime, "exporter"), { recursive: true });
  await rm(deploy, { recursive: true, force: true });

  const chromium = input("PENPOT_CHROMIUM_APP", `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app`);
  await copy(chromium, join(runtime, "chromium/Chromium.app"));
  const chromeExecutable = join(runtime, "chromium/Chromium.app/Contents/MacOS/Google Chrome for Testing");
  await copy(chromeExecutable, join(runtime, "chromium/Chromium.app/Contents/MacOS/Chromium"));

  for (const [name, path] of Object.entries(tools)) await copy(path, join(runtime, "tools/bin", name));

  await relocateMacos(runtime);
  const metadataPath = join(desktopRoot, "packaging/runtime-metadata.macos.json");
  JSON.parse(await readFile(metadataPath, "utf8"));
  run("cargo", ["run", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--bin", "penpot-runtime-lock", "--",
    "src-tauri/runtime-manifest.json", metadataPath, target, runtime, join(runtime, "runtime-lock.json")], desktopRoot);
  console.log(`Assembled ${runtime}`);
} catch (error) {
  console.error(`macOS runtime assembly stopped: ${error.message}`);
  process.exitCode = 1;
}
