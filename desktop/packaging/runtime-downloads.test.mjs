import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareRuntimeDownloads,
  validateRuntimeDownloadManifest,
} from "./runtime-downloads.mjs";

function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

function source(id, content, url = `https://downloads.example/${id}`) {
  return {
    id,
    version: "1.0.0",
    source: url,
    license: "MIT",
    sha256: checksum(content),
    buildRecipe: `build ${id}`,
  };
}

test("selects declared sources from runtime metadata", () => {
  const manifest = {
    schemaVersion: 1,
    target: "x86_64-pc-windows-msvc",
    sources: [source("node", "node"), source("chromium", "chromium")],
  };

  assert.deepEqual(validateRuntimeDownloadManifest(manifest, ["chromium"]), {
    target: "x86_64-pc-windows-msvc",
    artifacts: [
      {
        component: "chromium",
        version: "1.0.0",
        url: "https://downloads.example/chromium",
        sha256: checksum("chromium"),
      },
    ],
  });
});

test("rejects a missing selected source", () => {
  assert.throws(
    () =>
      validateRuntimeDownloadManifest(
        {
          schemaVersion: 1,
          target: "x86_64-pc-windows-msvc",
          sources: [source("node", "node")],
        },
        ["chromium"],
      ),
    /missing selected sources: chromium/,
  );
});

test("prepares selected metadata sources through the shared cache", async (t) => {
  const content = Buffer.from("runtime archive from metadata");
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Length": content.length });
    response.end(content);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(
    () =>
      new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  );
  const temporary = await mkdtemp(
    join(tmpdir(), "penpot-runtime-downloads-test-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const metadataPath = join(temporary, "runtime-metadata.json");
  const url = `http://127.0.0.1:${server.address().port}/node`;
  await writeFile(
    metadataPath,
    `${JSON.stringify({
      schemaVersion: 1,
      target: "x86_64-pc-windows-msvc",
      sources: [source("node", content, url), source("unused", "unused")],
    })}\n`,
  );

  const first = await prepareRuntimeDownloads({
    metadataPath,
    selectedIds: ["node"],
    cacheRoot: join(temporary, "cache"),
  });
  const second = await prepareRuntimeDownloads({
    metadataPath,
    selectedIds: ["node"],
    cacheRoot: join(temporary, "cache"),
  });

  assert.deepEqual(await readFile(first.node), content);
  assert.equal(first.node, second.node);
  assert.equal(requests, 1);
});
