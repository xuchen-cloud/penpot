import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildEmscriptenEnvironment } from "./emscripten-environment.mjs";
import { invokeTool, resolveToolCommand } from "./tool-command.mjs";
import { desktopRoot } from "./verify.mjs";

const repo = resolve(desktopRoot, "..");
const renderRoot = join(repo, "render-wasm");
const defaultEmsdkRoot =
  process.platform === "win32" ? "D:\\Program Files\\emsdk" : undefined;

function run(executable, args, cwd, env) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${executable} failed (${result.status ?? result.signal})`);
}

function output(executable, args, cwd, env) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${executable} failed (${result.status ?? result.signal}): ${result.stderr}`,
    );
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
}

function requireVersion(actual, expected, label) {
  if (!actual.includes(expected))
    throw new Error(`${label} does not match ${expected}: ${actual}`);
}

export function reproducibleRustFlags({ targetRoot, emsdkRoot, baseEnv }) {
  const existing = (baseEnv.CARGO_ENCODED_RUSTFLAGS || "")
    .split("\x1f")
    .filter(Boolean);
  const cargoHome = resolve(baseEnv.CARGO_HOME || join(homedir(), ".cargo"));
  const mappings = [
    [targetRoot, "/penpot-target"],
    [resolve(emsdkRoot), "/emsdk"],
    [cargoHome, "/cargo-home"],
    [repo, "/penpot-source"],
  ].sort(([left], [right]) => left.length - right.length);
  return [
    ...existing,
    ...mappings.map(
      ([source, destination]) => `--remap-path-prefix=${source}=${destination}`,
    ),
  ].join("\x1f");
}

async function required(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
  return path;
}

async function findFiles(root, name) {
  const matches = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) matches.push(...(await findFiles(path, name)));
    else if (entry.isFile() && entry.name === name) matches.push(path);
  }
  return matches;
}

export async function loadRenderWasmConfiguration(
  path = join(desktopRoot, "packaging/toolchains.json"),
) {
  const config = JSON.parse(await readFile(path, "utf8"));
  if (
    config.schemaVersion !== 1 ||
    config.toolchains?.rust !== "1.91.0" ||
    config.toolchains?.emscripten !== "4.0.6"
  ) {
    throw new Error(
      "Render WASM requires pinned Rust 1.91.0 and Emscripten 4.0.6",
    );
  }
  if (
    !config.renderWasm?.profiles?.frontend ||
    !config.renderWasm?.profiles?.export
  ) {
    throw new Error(
      "Render WASM configuration must define frontend and export profiles",
    );
  }
  return config;
}

export async function smokeTestRenderWasm(modulePath, wasmPath) {
  const wasmBinary = await readFile(wasmPath);
  const moduleUrl = `${pathToFileURL(modulePath).href}?smoke=${Date.now()}`;
  const { default: createModule } = await import(moduleUrl);
  const instance = await createModule({ wasmBinary });
  if (
    !(instance.HEAPU8 instanceof Uint8Array) ||
    instance.HEAPU8.byteLength === 0
  ) {
    throw new Error("Render WASM smoke test did not expose initialized memory");
  }
  const exports = Object.keys(instance).filter(
    (name) => name.startsWith("_") && typeof instance[name] === "function",
  );
  if (!exports.includes("_init") || exports.length < 2) {
    throw new Error(
      "Render WASM smoke test did not expose the expected functions",
    );
  }
  return { memoryBytes: instance.HEAPU8.byteLength, exports: exports.length };
}

export async function buildRenderWasm(
  target,
  {
    emsdkRoot = process.env.PENPOT_BUILD_EMSDK || defaultEmsdkRoot,
    cargoTargetRoot = process.env.PENPOT_RENDER_WASM_TARGET_DIR ||
      join(desktopRoot, ".cache/build/render-wasm", target),
    outputRoot = null,
    version = process.env.VERSION || "2.17.0-desktop.1",
    pnpm = resolveToolCommand({
      env: process.env,
      name: "PENPOT_BUILD_PNPM",
      fallback: "pnpm",
    }),
  } = {},
) {
  const config = await loadRenderWasmConfiguration();
  const profile = config.renderWasm.profiles[target];
  if (!profile) throw new Error(`Unknown Render WASM target: ${target}`);
  if (!emsdkRoot)
    throw new Error(
      "Set PENPOT_BUILD_EMSDK to the Emscripten SDK 4.0.6 directory",
    );
  const targetRoot = resolve(cargoTargetRoot);
  const baseEnv = {
    ...process.env,
    NODE_ENV: "production",
    RENDER_TARGET: target,
    RUSTUP_TOOLCHAIN: config.toolchains.rust,
    CARGO_TARGET_DIR: targetRoot,
    CARGO_BUILD_TARGET: config.renderWasm.cargoTarget,
    SKIA_BINARIES_URL: config.renderWasm.skiaBinariesUrl,
    EMCC_CFLAGS: [...profile.emccFlags, ...config.renderWasm.commonFlags].join(
      " ",
    ),
  };
  baseEnv.CARGO_ENCODED_RUSTFLAGS = reproducibleRustFlags({
    targetRoot,
    emsdkRoot,
    baseEnv,
  });
  delete baseEnv.RUSTFLAGS;
  const env = await buildEmscriptenEnvironment({
    emsdkRoot,
    cacheRoot: join(desktopRoot, ".cache/emscripten"),
    baseEnv,
  });
  requireVersion(
    output("rustc", ["--version"], renderRoot, env),
    `rustc ${config.toolchains.rust}`,
    "Rust toolchain",
  );
  requireVersion(
    output(
      env.EMSDK_PYTHON,
      [join(resolve(emsdkRoot), "upstream/emscripten/emcc.py"), "--version"],
      renderRoot,
      env,
    ),
    `${config.toolchains.emscripten} (${config.toolchains["emscripten-revision"]})`,
    "Emscripten toolchain",
  );
  if (process.versions.node !== config.toolchains.node) {
    throw new Error(
      `Node toolchain does not match ${config.toolchains.node}: ${process.versions.node}`,
    );
  }
  run(
    "cargo",
    [
      "build",
      "--locked",
      "--target",
      config.renderWasm.cargoTarget,
      ...profile.cargoArguments,
    ],
    renderRoot,
    env,
  );
  const buildRoot = join(
    targetRoot,
    config.renderWasm.cargoTarget,
    profile.cargoProfile,
  );
  const modulePath = await required(
    join(buildRoot, "render_wasm.js"),
    "Render WASM JavaScript",
  );
  const wasmPath = await required(
    join(buildRoot, "render_wasm.wasm"),
    "Render WASM binary",
  );
  const smoke = await smokeTestRenderWasm(modulePath, wasmPath);
  if (!outputRoot) return { modulePath, wasmPath, smoke };

  const destination = resolve(outputRoot);
  await mkdir(destination, { recursive: true });
  for (const name of [
    "render-wasm.js",
    "render-wasm.wasm",
    "render-wasm.wasm.map",
  ]) {
    await rm(join(destination, name), { force: true });
  }
  let moduleSource = await readFile(modulePath, "utf8");
  moduleSource = moduleSource.replaceAll(
    "render_wasm.wasm",
    `render-wasm.wasm?version=${version}`,
  );
  await writeFile(join(destination, "render-wasm.js"), moduleSource);
  await cp(wasmPath, join(destination, "render-wasm.wasm"));
  try {
    await cp(
      join(buildRoot, "render_wasm.wasm.map"),
      join(destination, "render-wasm.wasm.map"),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const shared = await findFiles(
    join(targetRoot, config.renderWasm.cargoTarget),
    "render_wasm_shared.js",
  );
  if (shared.length === 0) throw new Error("render_wasm_shared.js is missing");
  const sharedContents = await Promise.all(
    shared.map((path) => readFile(path)),
  );
  if (
    new Set(sharedContents.map((content) => content.toString("base64")))
      .size !== 1
  ) {
    throw new Error(
      `Found ${shared.length} different render_wasm_shared.js files`,
    );
  }
  const sharedDestination =
    target === "frontend"
      ? join(repo, "frontend/src/app/render_wasm/api/shared.js")
      : join(repo, "exporter/src/app/wasm/shared.js");
  await cp(shared[0], sharedDestination);
  if (target === "frontend") {
    await mkdir(join(destination, "worker"), { recursive: true });
    invokeTool(
      run,
      pnpm,
      [
        "exec",
        "esbuild",
        modulePath,
        "--log-level=error",
        `--outfile=${join(destination, "worker/render.js")}`,
        "--platform=neutral",
        "--format=iife",
        "--global-name=WasmModule",
      ],
      renderRoot,
      env,
    );
  }
  return {
    modulePath: join(destination, "render-wasm.js"),
    wasmPath: join(destination, "render-wasm.wasm"),
    smoke,
  };
}

async function main() {
  const [, , target, outputRoot] = process.argv;
  if (!target)
    throw new Error(
      "usage: node build-render-wasm.mjs <frontend|export> [output-directory]",
    );
  const result = await buildRenderWasm(target, {
    outputRoot: outputRoot || null,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
