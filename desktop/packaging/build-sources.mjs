import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { desktopRoot, run } from "./verify.mjs";
import { stageSharedArtifacts } from "./stage-shared-artifacts.mjs";
import {
  encodePowerShellFileArguments,
  invokeTool,
  resolveToolCommand,
} from "./tool-command.mjs";

const repo = resolve(desktopRoot, "..");
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => name.toLowerCase() !== "npm_config_store_dir",
  ),
);
const defaultClojureConfig = join(desktopRoot, ".cache/clojure-config");
const pnpmStore =
  process.env.PENPOT_PNPM_STORE || join(desktopRoot, ".cache/pnpm-store");
const pnpmState =
  process.env.PENPOT_PNPM_STATE || join(desktopRoot, ".cache/pnpm-state");
const sourceDateEpoch = execFileSync(
  "git",
  ["show", "-s", "--format=%ct", "HEAD"],
  {
    cwd: repo,
    encoding: "utf8",
  },
).trim();
const version = process.env.VERSION || "2.17.0-desktop.1";
const env = {
  ...baseEnv,
  BUILD_DATE: new Date(Number(sourceDateEpoch) * 1000).toUTCString(),
  BUILD_TS: sourceDateEpoch,
  CLJ_CACHE: process.env.CLJ_CACHE || join(desktopRoot, ".cache/clojure-cache"),
  CLJ_CONFIG: process.env.CLJ_CONFIG || defaultClojureConfig,
  GITLIBS: process.env.GITLIBS || join(desktopRoot, ".cache/gitlibs"),
  NODE_ENV: "production",
  PENPOT_PNPM_STORE: pnpmStore,
  PENPOT_PNPM_STATE: pnpmState,
  SOURCE_DATE_EPOCH: sourceDateEpoch,
  VERSION: version,
  VERSION_TAG: `${version}-${sourceDateEpoch}`,
};
const defaultClojure =
  process.platform === "win32"
    ? [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(desktopRoot, "packaging/invoke-clojure-windows.ps1"),
      ]
    : "clojure";
const clojure = resolveToolCommand({
  env,
  name: "PENPOT_BUILD_CLOJURE",
  fallback: defaultClojure,
});
const pnpm = resolveToolCommand({
  env,
  name: "PENPOT_BUILD_PNPM",
  fallback: "pnpm",
});
const encodeClojureArguments =
  process.platform === "win32" &&
  !env.PENPOT_BUILD_CLOJURE_COMMAND &&
  !env.PENPOT_BUILD_CLOJURE;
const emsdk =
  env.PENPOT_BUILD_EMSDK ||
  (process.platform === "win32" ? "D:\\Program Files\\emsdk" : undefined);
const toolchainConfig = JSON.parse(
  await readFile(join(desktopRoot, "packaging/toolchains.json"), "utf8"),
);
const rustToolchain = toolchainConfig.toolchains.rust;

function invokeClojure(args, cwd) {
  const commandArguments = encodeClojureArguments
    ? encodePowerShellFileArguments(args)
    : args;
  return invokeTool(run, clojure, commandArguments, cwd, env);
}

function invokePnpm(args, cwd) {
  return invokeTool(run, pnpm, ["--store-dir", pnpmStore, "--state-dir", pnpmState, ...args], cwd, env);
}

try {
  if (!emsdk)
    throw new Error(
      "Set PENPOT_BUILD_EMSDK to the Emscripten SDK 4.0.6 directory",
    );
  await access(join(emsdk, ".emscripten"));
  if (!process.env.CLJ_CONFIG) {
    await mkdir(defaultClojureConfig, { recursive: true });
    const localRepository = join(desktopRoot, ".cache/m2").replaceAll(
      "\\",
      "/",
    );
    await writeFile(
      join(defaultClojureConfig, "deps.edn"),
      `{:mvn/local-repo "${localRepository}"}\n`,
    );
  }
  invokeClojure(["-Sdescribe"], repo);
  run(
    "rustup",
    ["toolchain", "install", rustToolchain, "--profile", "minimal"],
    repo,
    env,
  );
  run(
    "rustup",
    [
      "target",
      "add",
      "--toolchain",
      rustToolchain,
      "wasm32-unknown-emscripten",
    ],
    repo,
    env,
  );
  run("rustc", ["+" + rustToolchain, "--version"], repo, env);
  invokeClojure(["-T:build", "compile"], join(repo, "common"));
  await mkdir(join(repo, "backend/target/classes"), { recursive: true });
  await writeFile(
    join(repo, "backend/target/classes/version.txt"),
    `${env.VERSION}\n`,
  );
  await cp(
    join(repo, "CHANGES.md"),
    join(repo, "backend/target/classes/changelog.md"),
  );
  invokeClojure(["-T:build", "jar"], join(repo, "backend"));

  for (const module of ["plugins", "frontend", "exporter", "media-processor"]) {
    invokePnpm(["install", "--frozen-lockfile"], join(repo, module));
  }
  invokePnpm(["install", "--frozen-lockfile"], join(repo, "render-wasm"));
  invokePnpm(["run", "build:runtime"], join(repo, "plugins"));
  for (const target of ["frontend", "export"]) {
    const output =
      target === "frontend"
        ? join(repo, "frontend/resources/public/js")
        : join(repo, "exporter/resources/wasm");
    run(
      process.execPath,
      [join(desktopRoot, "packaging/build-render-wasm.mjs"), target, output],
      repo,
      env,
    );
  }
  invokeClojure(
    ["-M:dev:shadow-cljs", "release", "main", "worker"],
    join(repo, "frontend"),
  );
  invokePnpm(["run", "build:app:libs"], join(repo, "frontend"));
  invokePnpm(["run", "build:app:assets"], join(repo, "frontend"));
  invokeClojure(
    ["-M:dev:shadow-cljs", "release", "main"],
    join(repo, "exporter"),
  );
  invokePnpm(["run", "build"], join(repo, "media-processor"));
  const artifacts = await stageSharedArtifacts({
    repo,
    artifactVersion: env.VERSION,
    outputRoot: env.PENPOT_SHARED_ARTIFACT_OUTPUT,
  });
  console.log(`Desktop shared artifacts: ${artifacts}`);
} catch (error) {
  console.error(`Desktop source build stopped: ${error.message}`);
  process.exitCode = 1;
}
