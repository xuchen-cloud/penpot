import { access, createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { desktopRoot, run } from "./verify.mjs";

const nodeVersion = "22.18.0";
const nodeSha256 = "2c12913cba67af77ded8a399df3fd91c2e7f8628c7079da40bb9ff33bf00dfc0";
const archive = join(tmpdir(), `penpot-node-v${nodeVersion}-darwin-arm64.tar.gz`);
const nodeRoot = join(tmpdir(), `node-v${nodeVersion}-darwin-arm64`);

function exists(path) {
  return new Promise((resolve) => access(path, (error) => resolve(!error)));
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("error", reject).on("data", (data) => hash.update(data)).on("end", () => resolve(hash.digest("hex")));
  });
}

try {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS runtime preparation requires an Apple Silicon host");
  }
  await mkdir(tmpdir(), { recursive: true });
  if (!await exists(archive) || await sha256(archive) !== nodeSha256) {
    await rm(archive, { force: true });
    run("curl", ["--fail", "--location", `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-darwin-arm64.tar.gz`, "--output", archive]);
  }
  const actual = await sha256(archive);
  if (actual !== nodeSha256) throw new Error(`Node archive SHA-256 mismatch: ${actual}`);
  await rm(nodeRoot, { recursive: true, force: true });
  run("tar", ["-xzf", archive, "-C", tmpdir()]);
  run("pnpm", ["--dir", join(desktopRoot, "../exporter"), "exec", "playwright", "install", "chromium"]);
  console.log(`Prepared Node ${nodeVersion} and Playwright Chromium for macOS assembly.`);
} catch (error) {
  console.error(`macOS runtime preparation stopped: ${error.message}`);
  process.exitCode = 1;
}
