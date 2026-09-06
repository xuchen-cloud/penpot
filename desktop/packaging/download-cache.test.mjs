import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  cacheEntryPaths,
  defaultDownloadCacheRoot,
  defaultLocalDownloadSource,
  downloadVerified,
  prepareDownloads,
} from "./download-cache.mjs";

const TARGET = "x86_64-pc-windows-msvc";

function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function fixture(t, handler) {
  const server = createServer(handler);
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
  return `http://127.0.0.1:${server.address().port}/artifact`;
}

async function temporaryCache(t) {
  const root = await mkdtemp(join(tmpdir(), "penpot-download-cache-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function artifact(url, content, overrides = {}) {
  return {
    component: "node",
    version: "24.19.0",
    url,
    sha256: checksum(content),
    ...overrides,
  };
}

test("keeps the default persistent cache inside the Desktop project", () => {
  assert.equal(
    defaultDownloadCacheRoot({}),
    resolve(import.meta.dirname, "../.cache/runtime-downloads"),
  );
  assert.equal(
    defaultLocalDownloadSource({}),
    resolve(import.meta.dirname, "../../../tools/downloads"),
  );
});

test("rejects path traversal and Windows device names in cache keys", () => {
  const sha256 = checksum("archive");
  assert.throws(
    () =>
      cacheEntryPaths({
        component: "..",
        version: "1.0.0",
        target: TARGET,
        sha256,
      }),
    /Invalid component/,
  );
  assert.throws(
    () =>
      cacheEntryPaths({
        component: "node",
        version: "1.0.0",
        target: "CON",
        sha256,
      }),
    /Invalid target/,
  );
  assert.throws(
    () =>
      cacheEntryPaths({
        component: "node",
        version: "1.0.0.",
        target: TARGET,
        sha256,
      }),
    /Invalid version/,
  );
});

test("imports a verified archive from the shared local downloads directory", async (t) => {
  const content = Buffer.from("existing local installer");
  let requests = 0;
  const url = await fixture(t, (_request, response) => {
    requests += 1;
    response.end(content);
  });
  const cacheRoot = await temporaryCache(t);
  const localSourceRoot = await temporaryCache(t);
  await writeFile(join(localSourceRoot, "artifact"), content);

  const output = await downloadVerified({
    cacheRoot,
    localSourceRoot,
    target: TARGET,
    ...artifact(url, content),
  });

  assert.deepEqual(await readFile(output), content);
  assert.equal(requests, 0);
});

test("rejects a corrupt local archive and downloads the verified source", async (t) => {
  const content = Buffer.from("verified network archive");
  let requests = 0;
  const events = [];
  const url = await fixture(t, (_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Length": content.length });
    response.end(content);
  });
  const cacheRoot = await temporaryCache(t);
  const localSourceRoot = await temporaryCache(t);
  await writeFile(join(localSourceRoot, "artifact"), "corrupt local archive");

  const output = await downloadVerified({
    cacheRoot,
    localSourceRoot,
    target: TARGET,
    ...artifact(url, content),
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(await readFile(output), content);
  assert.equal(requests, 1);
  assert.ok(events.some((event) => event.type === "local-source-rejected"));
});

test("downloads once and reuses a verified cache entry", async (t) => {
  const content = Buffer.from("verified runtime archive");
  let requests = 0;
  const url = await fixture(t, (_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Length": content.length });
    response.end(content);
  });
  const cacheRoot = await temporaryCache(t);
  const input = { cacheRoot, target: TARGET, ...artifact(url, content) };

  const first = await downloadVerified(input);
  const second = await downloadVerified(input);

  assert.equal(first, second);
  assert.deepEqual(await readFile(first), content);
  assert.equal(requests, 1);
});

test("resumes a compatible partial response at the declared byte", async (t) => {
  const content = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
  const split = 13;
  let receivedRange;
  const url = await fixture(t, (request, response) => {
    receivedRange = request.headers.range;
    const remaining = content.subarray(split);
    response.writeHead(206, {
      "Content-Length": remaining.length,
      "Content-Range": `bytes ${split}-${content.length - 1}/${content.length}`,
      ETag: "fixture-v1",
    });
    response.end(remaining);
  });
  const cacheRoot = await temporaryCache(t);
  const input = { cacheRoot, target: TARGET, ...artifact(url, content) };
  const paths = cacheEntryPaths(input);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.partial, content.subarray(0, split));
  await writeFile(
    paths.partialMetadata,
    `${JSON.stringify({
      schemaVersion: 1,
      component: input.component,
      version: input.version,
      target: input.target,
      url: new URL(input.url).toString(),
      urlKey: checksum(new URL(input.url).toString()),
      sha256: input.sha256,
      etag: "fixture-v1",
      lastModified: null,
    })}\n`,
  );

  const output = await downloadVerified(input);

  assert.equal(receivedRange, `bytes=${split}-`);
  assert.deepEqual(await readFile(output), content);
});

test("restarts safely when a server ignores a range request", async (t) => {
  const content = Buffer.from("server sends the complete artifact");
  const split = 8;
  const events = [];
  const url = await fixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Length": content.length });
    response.end(content);
  });
  const cacheRoot = await temporaryCache(t);
  const input = { cacheRoot, target: TARGET, ...artifact(url, content) };
  const paths = cacheEntryPaths(input);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.partial, content.subarray(0, split));
  await writeFile(
    paths.partialMetadata,
    `${JSON.stringify({
      schemaVersion: 1,
      component: input.component,
      version: input.version,
      target: input.target,
      url: new URL(input.url).toString(),
      urlKey: checksum(new URL(input.url).toString()),
      sha256: input.sha256,
      etag: "fixture-v1",
    })}\n`,
  );

  const output = await downloadVerified({
    ...input,
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(await readFile(output), content);
  assert.ok(
    events.some(
      (event) => event.reason === "server did not honor the range request",
    ),
  );
});

test("restarts when the server validator changes during resume", async (t) => {
  const content = Buffer.from("replacement content after a changed validator");
  const split = 7;
  let requests = 0;
  const events = [];
  const url = await fixture(t, (request, response) => {
    requests += 1;
    if (request.headers.range) {
      const remaining = content.subarray(split);
      response.writeHead(206, {
        "Content-Length": remaining.length,
        "Content-Range": `bytes ${split}-${content.length - 1}/${content.length}`,
        ETag: "fixture-v2",
      });
      response.end(remaining);
      return;
    }
    response.writeHead(200, {
      "Content-Length": content.length,
      ETag: "fixture-v2",
    });
    response.end(content);
  });
  const cacheRoot = await temporaryCache(t);
  const input = { cacheRoot, target: TARGET, ...artifact(url, content) };
  const paths = cacheEntryPaths(input);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.partial, content.subarray(0, split));
  await writeFile(
    paths.partialMetadata,
    `${JSON.stringify({
      schemaVersion: 1,
      component: input.component,
      version: input.version,
      target: input.target,
      url: new URL(input.url).toString(),
      urlKey: checksum(new URL(input.url).toString()),
      sha256: input.sha256,
      etag: "fixture-v1",
      lastModified: null,
    })}\n`,
  );

  const output = await downloadVerified({
    ...input,
    retryDelayMs: 1,
    onEvent: (event) => events.push(event),
  });

  assert.equal(requests, 2);
  assert.deepEqual(await readFile(output), content);
  assert.ok(
    events.some(
      (event) => event.reason === "server validator changed during resume",
    ),
  );
});

test("does not resume a partial file without a stable server validator", async (t) => {
  const content = Buffer.from("complete artifact without validators");
  let receivedRange;
  const events = [];
  const url = await fixture(t, (request, response) => {
    receivedRange = request.headers.range;
    response.writeHead(200, { "Content-Length": content.length });
    response.end(content);
  });
  const cacheRoot = await temporaryCache(t);
  const input = { cacheRoot, target: TARGET, ...artifact(url, content) };
  const paths = cacheEntryPaths(input);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.partial, content.subarray(0, 8));
  await writeFile(
    paths.partialMetadata,
    `${JSON.stringify({
      schemaVersion: 1,
      component: input.component,
      version: input.version,
      target: input.target,
      url: new URL(input.url).toString(),
      urlKey: checksum(new URL(input.url).toString()),
      sha256: input.sha256,
    })}\n`,
  );

  const output = await downloadVerified({
    ...input,
    onEvent: (event) => events.push(event),
  });

  assert.equal(receivedRange, undefined);
  assert.deepEqual(await readFile(output), content);
  assert.ok(
    events.some(
      (event) =>
        event.reason === "partial download has no stable server validator",
    ),
  );
});

test("does not resume when only a secret URL value changes", async (t) => {
  const content = Buffer.from("token-specific runtime archive");
  let receivedRange;
  const baseUrl = await fixture(t, (request, response) => {
    receivedRange = request.headers.range;
    response.writeHead(200, {
      "Content-Length": content.length,
      ETag: "token-v2",
    });
    response.end(content);
  });
  const oldUrl = `${baseUrl}?token=old-secret`;
  const newUrl = `${baseUrl}?token=new-secret`;
  const cacheRoot = await temporaryCache(t);
  const input = { cacheRoot, target: TARGET, ...artifact(newUrl, content) };
  const paths = cacheEntryPaths(input);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.partial, content.subarray(0, 5));
  await writeFile(
    paths.partialMetadata,
    `${JSON.stringify({
      schemaVersion: 1,
      component: input.component,
      version: input.version,
      target: input.target,
      url: `${baseUrl}?token=REDACTED`,
      urlKey: checksum(new URL(oldUrl).toString()),
      sha256: input.sha256,
      etag: "token-v1",
      lastModified: null,
    })}\n`,
  );

  const output = await downloadVerified(input);

  assert.equal(receivedRange, undefined);
  assert.deepEqual(await readFile(output), content);
});

test("retries transient HTTP failures with a bound", async (t) => {
  const content = Buffer.from("eventual success");
  let requests = 0;
  const url = await fixture(t, (_request, response) => {
    requests += 1;
    if (requests < 3) {
      response.writeHead(503);
      response.end("not ready");
      return;
    }
    response.writeHead(200, { "Content-Length": content.length });
    response.end(content);
  });
  const cacheRoot = await temporaryCache(t);

  const output = await downloadVerified({
    cacheRoot,
    target: TARGET,
    ...artifact(url, content),
    retries: 2,
    retryDelayMs: 1,
  });

  assert.deepEqual(await readFile(output), content);
  assert.equal(requests, 3);
});

test("resumes an interrupted transfer on the bounded retry", async (t) => {
  const content = Buffer.from(
    "a sufficiently long archive body for an interrupted response",
  );
  const split = 21;
  let requests = 0;
  let resumedAt;
  const url = await fixture(t, (request, response) => {
    requests += 1;
    if (requests === 1) {
      response.writeHead(200, {
        "Content-Length": content.length,
        ETag: "interrupted-v1",
      });
      response.write(content.subarray(0, split), () => {
        setTimeout(() => response.destroy(), 10);
      });
      return;
    }
    resumedAt = request.headers.range;
    assert.match(resumedAt, /^bytes=\d+-$/);
    const offset = Number(/^bytes=(\d+)-$/.exec(resumedAt)[1]);
    const remaining = content.subarray(offset);
    response.writeHead(206, {
      "Content-Length": remaining.length,
      "Content-Range": `bytes ${offset}-${content.length - 1}/${content.length}`,
      ETag: "interrupted-v1",
    });
    response.end(remaining);
  });
  const cacheRoot = await temporaryCache(t);

  const output = await downloadVerified({
    cacheRoot,
    target: TARGET,
    ...artifact(url, content),
    retries: 1,
    retryDelayMs: 1,
    connectTimeoutMs: 500,
    inactivityTimeoutMs: 1_000,
  });

  assert.match(resumedAt, /^bytes=[1-9]\d*-$/);
  assert.deepEqual(await readFile(output), content);
  assert.equal(requests, 2);
});

test("reports checksum failures without URL credentials", async (t) => {
  const expected = Buffer.from("expected");
  const received = Buffer.from("received");
  const baseUrl = await fixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Length": received.length });
    response.end(received);
  });
  const unsafeUrl = new URL(baseUrl);
  unsafeUrl.username = "build-user";
  unsafeUrl.password = "secret-password";
  unsafeUrl.searchParams.set("token", "secret-token");
  const cacheRoot = await temporaryCache(t);
  const input = {
    cacheRoot,
    target: TARGET,
    ...artifact(unsafeUrl.toString(), expected),
  };

  await assert.rejects(downloadVerified(input), (error) => {
    assert.match(error.message, /failed SHA-256 verification/);
    assert.match(error.message, /token=REDACTED/);
    assert.doesNotMatch(
      error.message,
      /build-user|secret-password|secret-token/,
    );
    return true;
  });
  const metadata = await readFile(
    cacheEntryPaths(input).partialMetadata,
    "utf8",
  );
  assert.match(metadata, /token=REDACTED/);
  assert.match(metadata, /"urlKey": "[a-f0-9]{64}"/);
  assert.doesNotMatch(metadata, /build-user|secret-password|secret-token/);
});

test("quarantines a corrupt complete entry before atomic promotion", async (t) => {
  const content = Buffer.from("replacement archive");
  const url = await fixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Length": content.length });
    response.end(content);
  });
  const cacheRoot = await temporaryCache(t);
  const input = { cacheRoot, target: TARGET, ...artifact(url, content) };
  const paths = cacheEntryPaths(input);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.complete, "corrupt archive");

  const output = await downloadVerified(input);
  const entries = await (await import("node:fs/promises")).readdir(paths.root);

  assert.deepEqual(await readFile(output), content);
  assert.ok(entries.some((name) => name.startsWith("artifact.corrupt-")));
});

test("serializes concurrent preparation for the same target", async (t) => {
  const content = Buffer.from("one transfer for concurrent callers");
  let requests = 0;
  const url = await fixture(t, (_request, response) => {
    requests += 1;
    setTimeout(() => {
      response.writeHead(200, { "Content-Length": content.length });
      response.end(content);
    }, 30);
  });
  const cacheRoot = await temporaryCache(t);
  const options = {
    cacheRoot,
    target: TARGET,
    artifacts: [artifact(url, content)],
    lockOptions: { pollIntervalMs: 5 },
  };

  const [first, second] = await Promise.all([
    prepareDownloads(options),
    prepareDownloads(options),
  ]);

  assert.equal(first[0], second[0]);
  assert.equal(requests, 1);
});

test("reuses an existing target lock without nested acquisition", async (t) => {
  const content = Buffer.from("prepared under an outer target lock");
  const url = await fixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Length": content.length });
    response.end(content);
  });
  const cacheRoot = await temporaryCache(t);
  let ownershipChecks = 0;
  const [output] = await prepareDownloads({
    cacheRoot,
    target: TARGET,
    artifacts: [artifact(url, content)],
    lock: {
      target: TARGET,
      async assertOwned() {
        ownershipChecks += 1;
      },
    },
  });

  assert.deepEqual(await readFile(output), content);
  assert.ok(ownershipChecks > 0);
  await assert.rejects(stat(join(cacheRoot, "locks")), { code: "ENOENT" });
});

test("recovers a stale lock only after its local owner is gone", async (t) => {
  const content = Buffer.from("stale lock recovery");
  const url = await fixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Length": content.length });
    response.end(content);
  });
  const cacheRoot = await temporaryCache(t);
  const lockRoot = join(cacheRoot, "locks", `${TARGET}.lock`);
  await mkdir(lockRoot, { recursive: true });
  await writeFile(
    join(lockRoot, "owner.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      token: "dead-owner",
      pid: -1,
      hostname: (await import("node:os")).hostname(),
    })}\n`,
  );
  const heartbeat = join(lockRoot, "heartbeat");
  await writeFile(heartbeat, "dead-owner\n");
  const old = new Date(Date.now() - 10_000);
  await utimes(heartbeat, old, old);

  const [output] = await prepareDownloads({
    cacheRoot,
    target: TARGET,
    artifacts: [artifact(url, content)],
    lockOptions: { staleAfterMs: 10, pollIntervalMs: 1 },
  });

  assert.deepEqual(await readFile(output), content);
  await assert.rejects(stat(lockRoot), { code: "ENOENT" });
});

test("does not steal a stale-looking lock from a live local owner", async (t) => {
  const content = Buffer.from("must not be downloaded");
  let requests = 0;
  const url = await fixture(t, (_request, response) => {
    requests += 1;
    response.end(content);
  });
  const cacheRoot = await temporaryCache(t);
  const lockRoot = join(cacheRoot, "locks", `${TARGET}.lock`);
  await mkdir(lockRoot, { recursive: true });
  await writeFile(
    join(lockRoot, "owner.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      token: "live-owner",
      pid: process.pid,
      hostname: (await import("node:os")).hostname(),
    })}\n`,
  );
  const heartbeat = join(lockRoot, "heartbeat");
  await writeFile(heartbeat, "live-owner\n");
  const old = new Date(Date.now() - 10_000);
  await utimes(heartbeat, old, old);

  await assert.rejects(
    prepareDownloads({
      cacheRoot,
      target: TARGET,
      artifacts: [artifact(url, content)],
      lockOptions: { staleAfterMs: 10, lockTimeoutMs: 15, pollIntervalMs: 1 },
    }),
    /Timed out waiting for preparation lock/,
  );
  assert.equal(requests, 0);
});
