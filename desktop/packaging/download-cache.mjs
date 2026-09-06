import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_LOCK_MS = 120_000;
const DEFAULT_CACHE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.cache/runtime-downloads",
);
const DEFAULT_LOCAL_SOURCE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tools/downloads",
);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

function safeSegment(value, label) {
  const windowsDevice = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value === ".." ||
    value.endsWith(".") ||
    !/^[a-zA-Z0-9._-]+$/.test(value) ||
    windowsDevice.test(value)
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function normalizeChecksum(value) {
  const checksum = String(value).toLowerCase();
  if (!CHECKSUM_PATTERN.test(checksum)) {
    throw new Error(`Invalid SHA-256 checksum: ${JSON.stringify(value)}`);
  }
  return checksum;
}

export function redactUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  for (const name of url.searchParams.keys())
    url.searchParams.set(name, "REDACTED");
  return url.toString();
}

function downloadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid download URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported download URL protocol: ${url.protocol}`);
  }
  return url;
}

function persistedRequest(request) {
  return {
    ...request,
    url: redactUrl(request.url),
    urlKey: createHash("sha256").update(request.url).digest("hex"),
  };
}

export function defaultDownloadCacheRoot(env = process.env) {
  return resolve(env.PENPOT_DESKTOP_DOWNLOAD_CACHE || DEFAULT_CACHE_ROOT);
}

export function defaultLocalDownloadSource(env = process.env) {
  return resolve(
    env.PENPOT_DESKTOP_DOWNLOAD_SOURCE || DEFAULT_LOCAL_SOURCE_ROOT,
  );
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function cacheEntryPaths({
  cacheRoot = defaultDownloadCacheRoot(),
  component,
  version,
  target,
  sha256,
}) {
  const root = join(
    cacheRoot,
    "artifacts",
    safeSegment(component, "component"),
    safeSegment(version, "version"),
    safeSegment(target, "target"),
    normalizeChecksum(sha256),
  );
  return {
    root,
    complete: join(root, "artifact"),
    partial: join(root, "artifact.partial"),
    partialMetadata: join(root, "artifact.partial.json"),
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function lockHeartbeatAge(lockRoot) {
  const heartbeat = join(lockRoot, "heartbeat");
  const details = await stat((await exists(heartbeat)) ? heartbeat : lockRoot);
  return Date.now() - details.mtimeMs;
}

async function readLockOwner(lockRoot) {
  try {
    return JSON.parse(await readFile(join(lockRoot, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

async function staleLockCanBeRecovered(lockRoot, staleAfterMs) {
  try {
    if ((await lockHeartbeatAge(lockRoot)) <= staleAfterMs) return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  const owner = await readLockOwner(lockRoot);
  if (!owner) return true;
  if (owner.hostname !== hostname()) return false;
  return !processIsAlive(owner.pid);
}

async function recoverStaleLock(lockRoot) {
  const staleRoot = `${lockRoot}.stale-${randomUUID()}`;
  try {
    await rename(lockRoot, staleRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await rm(staleRoot, { recursive: true, force: true });
  return true;
}

async function acquireTargetLock({
  cacheRoot,
  target,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleAfterMs = DEFAULT_STALE_LOCK_MS,
  pollIntervalMs = 50,
  heartbeatIntervalMs = Math.max(1_000, Math.floor(staleAfterMs / 3)),
}) {
  const safeTarget = safeSegment(target, "target");
  const locksRoot = join(cacheRoot, "locks");
  const lockRoot = join(locksRoot, `${safeTarget}.lock`);
  const token = randomUUID();
  const startedAt = Date.now();
  await mkdir(locksRoot, { recursive: true });

  while (true) {
    let created = false;
    try {
      await mkdir(lockRoot);
      created = true;
      await writeFile(
        join(lockRoot, "owner.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            token,
            pid: process.pid,
            hostname: hostname(),
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        { flag: "wx" },
      );
      await writeFile(join(lockRoot, "heartbeat"), `${token}\n`, {
        flag: "wx",
      });
      break;
    } catch (error) {
      if (created) {
        await rm(lockRoot, { recursive: true, force: true });
        throw error;
      }
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (await staleLockCanBeRecovered(lockRoot, staleAfterMs)) {
        await recoverStaleLock(lockRoot);
        continue;
      }
      if (Date.now() - startedAt >= lockTimeoutMs) {
        const owner = await readLockOwner(lockRoot);
        throw new Error(
          `Timed out waiting for preparation lock for ${safeTarget}; owner=${JSON.stringify(owner)}`,
        );
      }
      await delay(pollIntervalMs);
    }
  }

  let heartbeatError;
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(join(lockRoot, "heartbeat"), now, now).catch((error) => {
      heartbeatError = error;
    });
  }, heartbeatIntervalMs);
  heartbeat.unref();

  async function assertOwned() {
    if (heartbeatError) throw heartbeatError;
    const owner = await readLockOwner(lockRoot);
    if (owner?.token !== token)
      throw new Error(`Lost preparation lock for ${safeTarget}`);
  }

  async function release() {
    clearInterval(heartbeat);
    await assertOwned();
    const releasedRoot = `${lockRoot}.released-${token}`;
    await rename(lockRoot, releasedRoot);
    await rm(releasedRoot, { recursive: true, force: true });
  }

  return { assertOwned, release, target: safeTarget, token };
}

export async function withTargetLock(options, callback) {
  const lock = await acquireTargetLock(options);
  let result;
  let callbackError;
  try {
    result = await callback(lock);
  } catch (error) {
    callbackError = error;
  } finally {
    try {
      await lock.release();
    } catch (releaseError) {
      if (!callbackError) throw releaseError;
    }
  }
  if (callbackError) throw callbackError;
  return result;
}

function compatiblePartial(metadata, request) {
  return (
    metadata?.schemaVersion === 1 &&
    metadata.component === request.component &&
    metadata.version === request.version &&
    metadata.target === request.target &&
    metadata.urlKey === persistedRequest(request).urlKey &&
    metadata.sha256 === request.sha256
  );
}

async function resetPartial(paths, onEvent, reason) {
  if ((await exists(paths.partial)) || (await exists(paths.partialMetadata))) {
    onEvent?.({ type: "partial-discarded", reason });
  }
  await rm(paths.partial, { force: true });
  await rm(paths.partialMetadata, { force: true });
}

function requestStream(
  url,
  headers,
  { connectTimeoutMs, inactivityTimeoutMs, redirectLimit },
) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "http:" ? http : https;
    const request = transport.get(url, { headers }, (response) => {
      clearTimeout(connectTimer);
      if (
        [301, 302, 303, 307, 308].includes(response.statusCode) &&
        response.headers.location
      ) {
        response.resume();
        if (redirectLimit <= 0) {
          reject(
            Object.assign(new Error("Download redirect limit exceeded"), {
              retryable: false,
            }),
          );
          return;
        }
        const redirect = downloadUrl(
          new URL(response.headers.location, url).toString(),
        );
        requestStream(redirect, headers, {
          connectTimeoutMs,
          inactivityTimeoutMs,
          redirectLimit: redirectLimit - 1,
        }).then(resolve, reject);
        return;
      }
      response.setTimeout(inactivityTimeoutMs, () => {
        response.destroy(
          Object.assign(new Error("Download transfer timed out"), {
            retryable: true,
          }),
        );
      });
      resolve(response);
    });
    const connectTimer = setTimeout(() => {
      request.destroy(
        Object.assign(new Error("Download connection timed out"), {
          retryable: true,
        }),
      );
    }, connectTimeoutMs);
    request.once("error", (error) => {
      clearTimeout(connectTimer);
      if (error.retryable === undefined) error.retryable = true;
      reject(error);
    });
  });
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value || "");
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? null : Number(match[3]),
  };
}

function isRetryableTransferError(error) {
  return (
    error?.retryable === true ||
    [
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTFOUND",
      "ETIMEDOUT",
      "ERR_STREAM_PREMATURE_CLOSE",
    ].includes(error?.code) ||
    error?.message === "aborted"
  );
}

async function promoteVerified(paths, request, lock) {
  await lock?.assertOwned();
  const actual = await sha256File(paths.partial);
  if (actual !== request.sha256) {
    const error = new Error(
      `${request.component} for ${request.target} failed SHA-256 verification; URL=${redactUrl(request.url)}; expected=${request.sha256}; actual=${actual}; remove or retain the partial file, then retry safely`,
    );
    error.retryable = false;
    error.actualChecksum = actual;
    throw error;
  }
  if (await exists(paths.complete)) {
    const existing = await sha256File(paths.complete);
    if (existing === request.sha256) {
      await resetPartial(
        paths,
        null,
        "another verified download completed first",
      );
      return;
    }
    await rename(paths.complete, `${paths.complete}.corrupt-${randomUUID()}`);
  }
  await rename(paths.partial, paths.complete);
  await rm(paths.partialMetadata, { force: true });
}

async function seedFromLocalSource(paths, request, localSourceRoot, options) {
  if (!localSourceRoot) return false;
  const fileName = basename(new URL(request.url).pathname);
  if (!fileName) return false;
  const source = join(resolve(localSourceRoot), fileName);
  if (!(await exists(source))) return false;
  const actual = await sha256File(source);
  if (actual !== request.sha256) {
    options.onEvent?.({
      type: "local-source-rejected",
      path: source,
      reason: `checksum mismatch: ${actual}`,
    });
    return false;
  }
  await resetPartial(
    paths,
    options.onEvent,
    "replacing partial file with a verified local source",
  );
  await cp(source, paths.partial, { errorOnExist: true, force: false });
  await writeFile(
    paths.partialMetadata,
    `${JSON.stringify({ schemaVersion: 1, ...persistedRequest(request), localSource: source }, null, 2)}\n`,
  );
  await promoteVerified(paths, request, options.lock);
  options.onEvent?.({ type: "local-source-imported", path: source });
  return true;
}

async function downloadAttempt(request, paths, options) {
  let offset = 0;
  let partialMetadata;
  if (await exists(paths.partial)) {
    try {
      partialMetadata = JSON.parse(
        await readFile(paths.partialMetadata, "utf8"),
      );
    } catch {
      partialMetadata = null;
    }
    if (compatiblePartial(partialMetadata, request)) {
      offset = (await stat(paths.partial)).size;
      if (
        offset > 0 &&
        !partialMetadata.etag &&
        !partialMetadata.lastModified
      ) {
        await resetPartial(
          paths,
          options.onEvent,
          "partial download has no stable server validator",
        );
        offset = 0;
        partialMetadata = null;
      }
    } else {
      await resetPartial(
        paths,
        options.onEvent,
        "partial metadata does not match the requested artifact",
      );
    }
  } else if (await exists(paths.partialMetadata)) {
    await resetPartial(
      paths,
      options.onEvent,
      "partial metadata exists without a partial file",
    );
  }

  const headers = {};
  if (offset > 0) {
    headers.Range = `bytes=${offset}-`;
    if (partialMetadata.etag) headers["If-Range"] = partialMetadata.etag;
    else if (partialMetadata.lastModified)
      headers["If-Range"] = partialMetadata.lastModified;
  }

  const response = await requestStream(new URL(request.url), headers, options);
  if (response.statusCode === 416 && offset > 0) {
    response.resume();
    await promoteVerified(paths, request, options.lock);
    return;
  }
  if (response.statusCode !== 200 && response.statusCode !== 206) {
    response.resume();
    const error = new Error(
      `Download failed with HTTP ${response.statusCode} for ${redactUrl(request.url)}`,
    );
    error.retryable =
      response.statusCode === 408 ||
      response.statusCode === 429 ||
      response.statusCode >= 500;
    throw error;
  }

  let append = false;
  if (response.statusCode === 206) {
    const range = parseContentRange(response.headers["content-range"]);
    if (!range || range.start !== offset) {
      response.resume();
      const error = new Error(
        `Unsafe resume response for ${redactUrl(request.url)}: ${response.headers["content-range"] || "missing Content-Range"}`,
      );
      error.retryable = false;
      throw error;
    }
    const validatorChanged =
      offset > 0 &&
      ((partialMetadata.etag &&
        response.headers.etag !== partialMetadata.etag) ||
        (partialMetadata.lastModified &&
          response.headers["last-modified"] !== partialMetadata.lastModified));
    if (validatorChanged) {
      response.resume();
      await resetPartial(
        paths,
        options.onEvent,
        "server validator changed during resume",
      );
      const error = new Error(
        `Download validator changed while resuming ${redactUrl(request.url)}`,
      );
      error.retryable = true;
      throw error;
    }
    append = offset > 0;
  } else if (offset > 0) {
    options.onEvent?.({
      type: "partial-discarded",
      reason: "server did not honor the range request",
    });
    offset = 0;
  }

  const metadata = {
    schemaVersion: 1,
    ...persistedRequest(request),
    etag: response.headers.etag || null,
    lastModified: response.headers["last-modified"] || null,
  };
  await writeFile(
    paths.partialMetadata,
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await pipeline(
    response,
    createWriteStream(paths.partial, { flags: append ? "a" : "w" }),
  );
  await promoteVerified(paths, request, options.lock);
}

export async function downloadVerified({
  cacheRoot = defaultDownloadCacheRoot(),
  component,
  version,
  target,
  url,
  sha256,
  retries = 2,
  retryDelayMs = 250,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
  redirectLimit = 5,
  localSourceRoot = defaultLocalDownloadSource(),
  lock,
  onEvent,
}) {
  const request = {
    component: safeSegment(component, "component"),
    version: safeSegment(version, "version"),
    target: safeSegment(target, "target"),
    url: downloadUrl(url).toString(),
    sha256: normalizeChecksum(sha256),
  };
  const paths = cacheEntryPaths({ cacheRoot, ...request });
  await mkdir(paths.root, { recursive: true });

  if (await exists(paths.complete)) {
    const actual = await sha256File(paths.complete);
    if (actual === request.sha256) {
      onEvent?.({ type: "cache-hit", path: paths.complete });
      return paths.complete;
    }
    await rename(paths.complete, `${paths.complete}.corrupt-${randomUUID()}`);
    onEvent?.({
      type: "cache-rejected",
      reason: `checksum mismatch: ${actual}`,
    });
  }

  if (
    await seedFromLocalSource(paths, request, localSourceRoot, {
      lock,
      onEvent,
    })
  ) {
    return paths.complete;
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await downloadAttempt(request, paths, {
        connectTimeoutMs,
        inactivityTimeoutMs,
        redirectLimit,
        lock,
        onEvent,
      });
      onEvent?.({ type: "download-complete", path: paths.complete });
      return paths.complete;
    } catch (error) {
      lastError = error;
      if (!isRetryableTransferError(error) || attempt === retries) break;
      onEvent?.({ type: "retry", attempt: attempt + 1, reason: error.message });
      await delay(retryDelayMs * 2 ** attempt);
    }
  }
  throw new Error(
    `Download preparation failed: component=${request.component}; target=${request.target}; URL=${redactUrl(request.url)}; expected=${request.sha256}; reason=${lastError.message}; next action=keep the partial file and retry after checking the source or network`,
    { cause: lastError },
  );
}

export async function prepareDownloads({
  cacheRoot = defaultDownloadCacheRoot(),
  target,
  artifacts,
  lockOptions = {},
  downloadOptions = {},
  localSourceRoot = defaultLocalDownloadSource(),
  lock: existingLock = null,
}) {
  const prepare = async (lock) => {
    if (lock.target !== safeSegment(target, "target")) {
      throw new Error(
        `Preparation lock target mismatch: ${lock.target} != ${target}`,
      );
    }
    const prepared = [];
    for (const artifact of artifacts) {
      prepared.push(
        await downloadVerified({
          cacheRoot,
          target,
          ...artifact,
          ...downloadOptions,
          localSourceRoot,
          lock,
        }),
      );
    }
    return prepared;
  };
  if (existingLock) return prepare(existingLock);
  return withTargetLock({ cacheRoot, target, ...lockOptions }, prepare);
}
