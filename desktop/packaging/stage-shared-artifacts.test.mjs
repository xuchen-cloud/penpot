import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifySharedArtifacts } from "./shared-artifacts.mjs";
import {
  describeGitSource,
  promoteStagingDirectory,
  stageSharedArtifacts,
} from "./stage-shared-artifacts.mjs";

async function write(path, content) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function fakeRepository(t) {
  const root = await mkdtemp(join(tmpdir(), "penpot-stage-shared-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [module, version] of [
    ["frontend", "1.0.0"],
    ["exporter", "1.0.0"],
    ["media-processor", "1.0.0"],
    ["render-wasm", "1.20.0"],
  ]) {
    await write(
      join(root, module, "package.json"),
      `${JSON.stringify({ version })}\n`,
    );
  }
  await write(join(root, "backend/target/penpot.jar"), "backend");
  await write(join(root, "frontend/resources/public/index.html"), "frontend");
  await write(join(root, "frontend/resources/public/js/app.js"), "app");
  await write(
    join(root, "frontend/resources/public/js/render-wasm.js"),
    "frontend wasm js",
  );
  await write(
    join(root, "frontend/resources/public/js/render-wasm.wasm"),
    "frontend wasm",
  );
  await write(
    join(root, "frontend/resources/public/js/worker/render.js"),
    "frontend worker",
  );
  await write(join(root, "exporter/target/app.js"), "exporter");
  await write(
    join(root, "exporter/resources/wasm/render-wasm.js"),
    "exporter wasm js",
  );
  await write(
    join(root, "exporter/resources/wasm/render-wasm.wasm"),
    "exporter wasm",
  );
  await write(join(root, "media-processor/dist/index.js"), "media processor");
  await write(
    join(root, "toolchains.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      toolchains: { node: "24.19.0", rust: "1.91.0" },
    })}\n`,
  );
  return root;
}

test("retries transient Windows directory promotion errors", async () => {
  const delays = [];
  let calls = 0;
  await promoteStagingDirectory("staging", "output", {
    initialDelayMs: 25,
    renameOperation: async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("busy"), { code: "EPERM" });
    },
    wait: async (milliseconds) => delays.push(milliseconds),
  });

  assert.equal(calls, 3);
  assert.deepEqual(delays, [25, 50]);
});

test("does not retry non-transient directory promotion errors", async () => {
  const failure = Object.assign(new Error("missing"), { code: "ENOENT" });
  let calls = 0;

  await assert.rejects(
    promoteStagingDirectory("staging", "output", {
      renameOperation: async () => {
        calls += 1;
        throw failure;
      },
      wait: async () => assert.fail("non-transient errors must not wait"),
    }),
    failure,
  );
  assert.equal(calls, 1);
});

test("stages each shared output under one non-overlapping component", async (t) => {
  const repo = await fakeRepository(t);
  const output = join(repo, "desktop-output/shared");

  const result = await stageSharedArtifacts({
    repo,
    artifactVersion: "2.17.0-desktop.1",
    outputRoot: output,
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    toolchainsPath: join(repo, "toolchains.json"),
  });
  const manifest = await verifySharedArtifacts(result);

  assert.equal(result, output);
  assert.deepEqual(
    manifest.components.map((component) => component.id),
    [
      "backend",
      "exporter",
      "exporter-render-wasm",
      "frontend",
      "frontend-render-wasm",
      "media-processor",
    ],
  );
  assert.equal(
    await readFile(
      join(output, "render-wasm/frontend/render-wasm.wasm"),
      "utf8",
    ),
    "frontend wasm",
  );
  await assert.rejects(readFile(join(output, "frontend/js/render-wasm.wasm")), {
    code: "ENOENT",
  });
});

test("does not replace an existing shared artifact output", async (t) => {
  const repo = await fakeRepository(t);
  const output = join(repo, "desktop-output/shared");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "owned.txt"), "keep");

  await assert.rejects(
    stageSharedArtifacts({
      repo,
      outputRoot: output,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      toolchainsPath: join(repo, "toolchains.json"),
    }),
    /output already exists/,
  );
  assert.equal(await readFile(join(output, "owned.txt"), "utf8"), "keep");
});

test("records a stable digest for dirty tracked and untracked source", async (t) => {
  const repo = await fakeRepository(t);
  execFileSync("git", ["init", "-b", "develop"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "test fixture",
    ],
    { cwd: repo },
  );

  const clean = await describeGitSource(repo);
  assert.equal(clean.dirty, false);
  await writeFile(
    join(repo, "frontend/package.json"),
    `${JSON.stringify({ version: "2.0.0" })}\n`,
  );
  await writeFile(join(repo, "new-source.txt"), "new source");
  const first = await describeGitSource(repo);
  const second = await describeGitSource(repo);

  assert.equal(first.dirty, true);
  assert.match(first.worktreeSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(first, second);
  await writeFile(join(repo, "new-source.txt"), "changed source");
  assert.notEqual(
    (await describeGitSource(repo)).worktreeSha256,
    first.worktreeSha256,
  );
});
