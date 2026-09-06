import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { buildEmscriptenEnvironment } from "./emscripten-environment.mjs";

async function fakeSdk(t, platform) {
  const root = await mkdtemp(join(tmpdir(), "penpot-emsdk-environment-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const python =
    platform === "win32" ? "python/3.9/python.exe" : "python/3.9/bin/python3";
  const node =
    platform === "win32" ? "node/20/bin/node.exe" : "node/20/bin/node";
  for (const path of [python, node, ".emscripten"]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "");
  }
  await mkdir(join(root, "upstream/emscripten"), { recursive: true });
  await mkdir(join(root, "upstream/bin"), { recursive: true });
  return root;
}

test("builds a Windows Emscripten environment without running emsdk_env.bat", async (t) => {
  const root = await fakeSdk(t, "win32");
  const cacheRoot = join(root, "project-cache");

  const env = await buildEmscriptenEnvironment({
    emsdkRoot: root,
    cacheRoot,
    baseEnv: { PATH: "existing" },
    platform: "win32",
  });

  assert.equal(env.EMSDK, resolve(root));
  assert.equal(env.EM_CACHE, resolve(cacheRoot));
  assert.equal(env.EM_CONFIG, join(resolve(root), ".emscripten"));
  assert.match(env.EMSDK_PYTHON, /python\.exe$/);
  assert.match(env.EMSDK_NODE, /node\.exe$/);
  assert.match(env.PATH, /;existing$/);
});

test("uses the same contract for a Unix Emscripten layout", async (t) => {
  const root = await fakeSdk(t, "darwin");

  const env = await buildEmscriptenEnvironment({
    emsdkRoot: root,
    cacheRoot: join(root, "project-cache"),
    baseEnv: { PATH: "existing" },
    platform: "darwin",
  });

  assert.match(
    env.EMSDK_PYTHON.replaceAll("\\", "/"),
    /python\/3\.9\/bin\/python3$/,
  );
  assert.match(env.EMSDK_NODE.replaceAll("\\", "/"), /node\/20\/bin\/node$/);
  assert.match(env.PATH, /:existing$/);
});
