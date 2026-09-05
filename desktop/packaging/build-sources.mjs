import { access, cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopRoot, run } from "./verify.mjs";

const repo = resolve(desktopRoot, "..");
const env = { ...process.env, NODE_ENV: "production", VERSION: "2.17.0-desktop.1" };
const clojure = env.PENPOT_BUILD_CLOJURE || "clojure";
const pnpm = env.PENPOT_BUILD_PNPM || "pnpm";
const emsdk = env.PENPOT_BUILD_EMSDK;
const rustToolchain = env.PENPOT_BUILD_RUST_TOOLCHAIN || "1.92.0";

try {
  if (!emsdk) throw new Error("Set PENPOT_BUILD_EMSDK to the Emscripten SDK 4.0.6 directory");
  await access(join(emsdk, "emsdk_env.sh"));
  run(clojure, ["-Sdescribe"], repo, env);
  run("rustup", ["toolchain", "install", rustToolchain, "--profile", "minimal"], repo, env);
  run("rustup", ["target", "add", "--toolchain", rustToolchain, "wasm32-unknown-emscripten"], repo, env);
  run(clojure, ["-T:build", "compile"], join(repo, "common"), env);
  await mkdir(join(repo, "backend/target/classes"), { recursive: true });
  await writeFile(join(repo, "backend/target/classes/version.txt"), `${env.VERSION}\n`);
  await cp(join(repo, "CHANGES.md"), join(repo, "backend/target/classes/changelog.md"));
  run(clojure, ["-T:build", "jar"], join(repo, "backend"), env);

  for (const module of ["frontend", "exporter", "media-processor"]) {
    run(pnpm, ["install", "--frozen-lockfile"], join(repo, module), env);
  }
  // Pass arguments as arguments, never interpolate host paths into shell source.
  const wasmEnv = { ...env, RUSTUP_TOOLCHAIN: rustToolchain };
  for (const target of ["frontend", "export"]) {
    run("bash", ["-c", 'source "$1/emsdk_env.sh" && source ./_build_env "$2" && build && copy_target_artifacts',
      "desktop-wasm", emsdk, target], join(repo, "render-wasm"), wasmEnv);
  }
  run(clojure, ["-M:dev:shadow-cljs", "release", "main", "worker"], join(repo, "frontend"), env);
  run(pnpm, ["run", "build:app:libs"], join(repo, "frontend"), env);
  run(pnpm, ["run", "build:app:assets"], join(repo, "frontend"), env);
  run(clojure, ["-M:dev:shadow-cljs", "release", "main"], join(repo, "exporter"), env);
  run(pnpm, ["run", "build"], join(repo, "media-processor"), env);
} catch (error) {
  console.error(`Desktop source build stopped: ${error.message}`);
  process.exitCode = 1;
}
