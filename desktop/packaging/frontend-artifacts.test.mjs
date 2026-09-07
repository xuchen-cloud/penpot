import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resetFrontendOutput,
  validateFrontendOutput,
} from "./frontend-artifacts.mjs";

async function write(path, content = "fixture") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function completeFrontend(t) {
  const root = await mkdtemp(join(tmpdir(), "penpot-frontend-output-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    "index.html",
    "css/main.css",
    "js/main.js",
    "js/worker/main.js",
  ]) {
    await write(join(root, ...path.split("/")));
  }
  return root;
}

test("removes stale frontend output before a source build", async (t) => {
  const root = await completeFrontend(t);
  await write(join(root, "resources/public/css/main.css"), "stale css");

  await resetFrontendOutput(root);

  await assert.rejects(access(root), { code: "ENOENT" });
});

test("accepts one complete frontend output tree", async (t) => {
  const root = await completeFrontend(t);
  await validateFrontendOutput(root);
});

test("rejects nested frontend output", async (t) => {
  const root = await completeFrontend(t);
  await write(join(root, "resources/public/css/main.css"), "stale css");

  await assert.rejects(validateFrontendOutput(root), /nested resources\/public/);
});

test("rejects incomplete frontend output", async (t) => {
  const root = await completeFrontend(t);
  await rm(join(root, "js/worker/main.js"));

  await assert.rejects(validateFrontendOutput(root), /incomplete.*worker\/main\.js/i);
});

test("rejects a second main stylesheet", async (t) => {
  const root = await completeFrontend(t);
  await write(join(root, "legacy/css/main.css"), "stale css");

  await assert.rejects(validateFrontendOutput(root), /duplicate main\.css/);
});
