import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";

export const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function nativeTarget(platform = process.platform, architecture = process.arch) {
  if (platform === "darwin" && architecture === "arm64") return "aarch64-apple-darwin";
  if (platform === "win32" && architecture === "x64") return "x86_64-pc-windows-msvc";
  throw new Error(`Unsupported packaging host: ${platform}/${architecture}`);
}

export function run(executable, args, cwd = desktopRoot, env = process.env) {
  const result = spawnSync(executable, args, { cwd, env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status ?? result.signal})`);
}

export function verifyRuntime(target = nativeTarget()) {
  const root = join(desktopRoot, "src-tauri/resources/runtime", target);
  run("cargo", ["run", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--bin", "penpot-runtime-lock", "--",
    "--verify", "src-tauri/runtime-manifest.json", target, root]);
  return root;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { verifyRuntime(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
