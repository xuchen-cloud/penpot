import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const compatibilityRoot = join(sourceRoot, "desktop", "compatibility");
const runtimeRoot = resolve(process.argv[2] ?? "");

if (!process.argv[2]) {
  throw new Error("usage: node prepare-runtime.mjs <assembled-runtime-root>");
}

const target = process.platform === "win32" ? "windows" : process.platform;
if (target !== "windows" && target !== "darwin") {
  throw new Error(`unsupported compatibility host ${process.platform}`);
}

const fixtureRoot = join(runtimeRoot, "compat", "fixtures");
await mkdir(fixtureRoot, { recursive: true });
await copyFile(join(compatibilityRoot, "check.mjs"), join(runtimeRoot, "compat", "check.mjs"));
await copyFile(join(sourceRoot, "frontend", "resources", "fonts", "WorkSans-Regular.ttf"), join(fixtureRoot, "font.ttf"));
await copyFile(join(sourceRoot, "frontend", "resources", "fonts", "sourcesanspro-regular.woff"), join(fixtureRoot, "font.woff"));
await copyFile(join(sourceRoot, "frontend", "resources", "fonts", "WorkSans-Regular.woff2"), join(fixtureRoot, "font.woff2"));

const fontforge =
  target === "windows"
    ? join(runtimeRoot, "tools", "fontforge.exe")
    : join(runtimeRoot, "tools", "bin", "fontforge");
const ttf = join(fixtureRoot, "font.ttf").replaceAll("'", "''");
const otf = join(fixtureRoot, "font.otf").replaceAll("'", "''");
await run(fontforge, ["-lang=ff", "-c", `Open('${ttf}'); Generate('${otf}')`]);

function run(executable, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${executable} exited with ${code ?? signal}`));
    });
  });
}
