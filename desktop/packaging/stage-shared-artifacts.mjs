import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { desktopRoot } from "./verify.mjs";
import { validateFrontendOutput } from "./frontend-artifacts.mjs";
import {
  createSharedArtifactManifest,
  verifySharedArtifacts,
  writeSharedArtifactManifest,
} from "./shared-artifacts.mjs";

const REPOSITORY = "https://github.com/xuchen-cloud/penpot";
const TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function promoteStagingDirectory(
  source,
  destination,
  {
    attempts = 6,
    initialDelayMs = 50,
    renameOperation = rename,
    wait = delay,
  } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await renameOperation(source, destination);
      return;
    } catch (error) {
      if (
        !TRANSIENT_RENAME_ERRORS.has(error?.code) ||
        attempt === attempts - 1
      ) {
        throw error;
      }
      await wait(initialDelayMs * 2 ** attempt);
    }
  }
}

async function required(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
  return path;
}

async function copyRequired(source, destination, label) {
  await required(source, label);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: true });
}

async function optionalCopy(source, destination) {
  try {
    await access(source);
  } catch {
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: true });
}

async function packageVersion(repo, module) {
  return JSON.parse(await readFile(join(repo, module, "package.json"), "utf8"))
    .version;
}

async function loadToolchains(path) {
  const config = JSON.parse(await readFile(path, "utf8"));
  if (config.schemaVersion !== 1 || !config.toolchains)
    throw new Error("Toolchain configuration schemaVersion must be 1");
  return config.toolchains;
}

export async function describeGitSource(repo) {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: repo,
      encoding: "utf8",
    },
  );
  if (!status.trim()) return { repository: REPOSITORY, revision, dirty: false };

  const digest = createHash("sha256");
  digest.update("tracked-diff\0");
  digest.update(
    execFileSync(
      "git",
      ["diff", "--binary", "--no-ext-diff", "HEAD", "--", "."],
      { cwd: repo },
    ),
  );
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    {
      cwd: repo,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const path of untracked) {
    digest.update("\0untracked\0");
    digest.update(path.replaceAll("\\", "/"));
    digest.update("\0");
    digest.update(await readFile(join(repo, ...path.split("/"))));
  }
  return {
    repository: REPOSITORY,
    revision,
    dirty: true,
    worktreeSha256: digest.digest("hex"),
  };
}

export async function stageSharedArtifacts({
  repo = resolve(desktopRoot, ".."),
  artifactVersion = process.env.VERSION || "2.17.0-desktop.1",
  outputRoot = join(desktopRoot, "target/shared-artifacts", artifactVersion),
  sourceRevision = null,
  toolchainsPath = join(desktopRoot, "packaging/toolchains.json"),
} = {}) {
  const output = resolve(outputRoot);
  try {
    await access(output);
    throw new Error(`Shared artifact output already exists: ${output}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(output), { recursive: true });
  const staging = `${output}.staging-${randomUUID()}`;
  await mkdir(staging);
  try {
    await validateFrontendOutput(join(repo, "frontend/resources/public"));
    await copyRequired(
      join(repo, "backend/target/penpot.jar"),
      join(staging, "backend/penpot.jar"),
      "Backend JAR",
    );
    await copyRequired(
      join(repo, "frontend/resources/public"),
      join(staging, "frontend"),
      "Frontend build",
    );
    await copyRequired(
      join(repo, "exporter/target/app.js"),
      join(staging, "exporter/app.js"),
      "Exporter build",
    );
    await copyRequired(
      join(repo, "media-processor/dist/index.js"),
      join(staging, "media-processor/index.js"),
      "Media Processor build",
    );

    const frontendWasmSource = join(repo, "frontend/resources/public/js");
    const frontendWasmTarget = join(staging, "render-wasm/frontend");
    for (const name of ["render-wasm.js", "render-wasm.wasm"]) {
      await copyRequired(
        join(frontendWasmSource, name),
        join(frontendWasmTarget, name),
        `Frontend Render WASM ${name}`,
      );
      await rm(join(staging, "frontend/js", name), { force: true });
    }
    await optionalCopy(
      join(frontendWasmSource, "render-wasm.wasm.map"),
      join(frontendWasmTarget, "render-wasm.wasm.map"),
    );
    await rm(join(staging, "frontend/js/render-wasm.wasm.map"), {
      force: true,
    });
    await copyRequired(
      join(frontendWasmSource, "worker/render.js"),
      join(frontendWasmTarget, "worker/render.js"),
      "Frontend Render WASM worker",
    );
    await rm(join(staging, "frontend/js/worker/render.js"), { force: true });

    await copyRequired(
      join(repo, "exporter/resources/wasm"),
      join(staging, "render-wasm/exporter"),
      "Exporter Render WASM",
    );

    const source = sourceRevision
      ? { repository: REPOSITORY, revision: sourceRevision }
      : await describeGitSource(repo);
    const manifest = await createSharedArtifactManifest({
      artifactRoot: staging,
      artifactVersion,
      source,
      toolchains: await loadToolchains(toolchainsPath),
      components: [
        {
          id: "backend",
          root: "backend",
          installRoot: "backend",
          version: artifactVersion,
          license: "MPL-2.0",
          buildCommand: ["clojure", "-T:build", "jar"],
        },
        {
          id: "exporter",
          root: "exporter",
          installRoot: "exporter",
          version: await packageVersion(repo, "exporter"),
          license: "MPL-2.0",
          buildCommand: ["clojure", "-M:dev:shadow-cljs", "release", "main"],
        },
        {
          id: "exporter-render-wasm",
          root: "render-wasm/exporter",
          installRoot: "exporter/resources/wasm",
          version: await packageVersion(repo, "render-wasm"),
          license: "MPL-2.0",
          buildCommand: [
            "node",
            "desktop/packaging/build-render-wasm.mjs",
            "export",
          ],
        },
        {
          id: "frontend",
          root: "frontend",
          installRoot: "frontend",
          version: await packageVersion(repo, "frontend"),
          license: "MPL-2.0",
          buildCommand: [
            "clojure",
            "-M:dev:shadow-cljs",
            "release",
            "main",
            "worker",
          ],
        },
        {
          id: "frontend-render-wasm",
          root: "render-wasm/frontend",
          installRoot: "frontend/js",
          version: await packageVersion(repo, "render-wasm"),
          license: "MPL-2.0",
          buildCommand: [
            "node",
            "desktop/packaging/build-render-wasm.mjs",
            "frontend",
          ],
        },
        {
          id: "media-processor",
          root: "media-processor",
          installRoot: "media-processor",
          version: await packageVersion(repo, "media-processor"),
          license: "MPL-2.0",
          buildCommand: ["pnpm", "run", "build"],
        },
      ],
    });
    await writeSharedArtifactManifest(staging, manifest);
    await verifySharedArtifacts(staging, manifest);
    await promoteStagingDirectory(staging, output);
    return output;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const output = await stageSharedArtifacts({
    outputRoot: process.env.PENPOT_SHARED_ARTIFACT_OUTPUT,
  });
  console.log(`Staged verified shared artifacts at ${output}`);
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
