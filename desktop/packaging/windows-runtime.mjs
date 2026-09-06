import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const WINDOWS_TARGET = "x86_64-pc-windows-msvc";

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function validateWindowsMetadata(metadata) {
  if (metadata?.schemaVersion !== 1) throw new Error("Windows runtime metadata schemaVersion must be 1");
  if (metadata.target !== WINDOWS_TARGET) throw new Error(`Windows runtime metadata target must be ${WINDOWS_TARGET}`);
  const prepared = [];
  for (const source of metadata.sources ?? []) {
    if (!source.windows) continue;
    const id = requiredString(source.id, "Windows runtime source id");
    const format = requiredString(source.windows.format, `${id} Windows format`);
    if (!["archive", "inno", "file"].includes(format)) throw new Error(`${id} has unsupported Windows format ${format}`);
    const destination = requiredString(source.windows.destination, `${id} Windows destination`);
    const requiredFiles = source.windows.requiredFiles;
    if (!Array.isArray(requiredFiles) || requiredFiles.length === 0) throw new Error(`${id} Windows requiredFiles must be non-empty`);
    for (const file of requiredFiles) validateRelativePath(file, `${id} required file`);
    if (source.windows.stripPrefix) validateRelativePath(source.windows.stripPrefix, `${id} stripPrefix`);
    const extractor = source.windows.extractor ?? null;
    if (extractor && extractor !== "sevenzip") throw new Error(`${id} has unsupported Windows extractor ${extractor}`);
    const runtimePath = source.windows.runtimePath ?? null;
    if (runtimePath) validateRelativePath(runtimePath, `${id} runtimePath`);
    prepared.push({ id, format, destination, requiredFiles, stripPrefix: source.windows.stripPrefix ?? null, extractor, runtimePath });
  }
  if (prepared.length === 0) throw new Error("Windows runtime metadata has no prepared sources");
  return prepared;
}

export function validateRelativePath(value, label = "path") {
  requiredString(value, label);
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized || isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith("/")) {
    throw new Error(`${label} must be a relative path: ${value}`);
  }
  const windowsDevice = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  for (const segment of normalized.split("/")) {
    if (!segment || segment === "." || segment === ".." || /[<>:"|?*\x00-\x1f]/.test(segment) || segment.endsWith(".") || segment.endsWith(" ") || windowsDevice.test(segment)) {
      throw new Error(`${label} contains an unsafe Windows path segment: ${value}`);
    }
  }
  return normalized;
}

export function validateArchiveListing(listing, label) {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) throw new Error(`${label} archive is empty`);
  for (const entry of entries) validateRelativePath(entry, `${label} archive entry`);
  return entries;
}

export function parseSevenZipListing(listing) {
  const paths = listing
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Path = "))
    .map((line) => line.slice("Path = ".length));
  return paths.slice(1).join("\n");
}

function execute(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    maxBuffer: options.capture ? 64 * 1024 * 1024 : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  const acceptedStatuses = options.acceptedStatuses ?? [0];
  if (!acceptedStatuses.includes(result.status)) {
    const detail = options.capture ? `: ${(result.stderr || result.stdout).trim()}` : "";
    throw new Error(`${executable} failed (${result.status ?? result.signal})${detail}`);
  }
  return result.stdout ?? "";
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function renameWithRetry(source, destination) {
  let lastError;
  for (const delay of [0, 100, 250, 500, 1_000, 2_000, 4_000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
    }
  }
  throw lastError;
}

async function markerMatches(root, sha256) {
  try {
    const marker = JSON.parse(await readFile(join(root, ".penpot-source.json"), "utf8"));
    return marker.schemaVersion === 1 && marker.sha256 === sha256;
  } catch {
    return false;
  }
}

async function verifyPrepared(root, entry) {
  for (const file of entry.requiredFiles) {
    if (!(await exists(join(root, file)))) throw new Error(`${entry.id} did not provide ${file}`);
  }
}

async function rejectLinks(current) {
  for (const name of await readdir(current)) {
    const path = join(current, name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new Error(`Windows runtime input contains a symbolic link: ${path}`);
    if (details.isDirectory()) await rejectLinks(path);
  }
}

async function extract(entry, archive, extractionRoot, extractors) {
  if (entry.format === "file") {
    await mkdir(extractionRoot, { recursive: true });
    if (entry.requiredFiles.length !== 1) throw new Error(`${entry.id} file source must declare exactly one required file`);
    await cp(archive, join(extractionRoot, entry.requiredFiles[0]));
    return;
  }
  if (entry.format === "archive") {
    const executable = entry.extractor === "sevenzip" ? extractors?.sevenzip : "tar";
    if (!executable) throw new Error(`${entry.id} requires the prepared 7-Zip extractor`);
    const listArguments = entry.extractor === "sevenzip" ? ["l", "-slt", archive] : ["-tf", archive];
    const listing = execute(executable, listArguments, { capture: true });
    const archivePaths = entry.extractor === "sevenzip"
      ? parseSevenZipListing(listing)
      : listing;
    validateArchiveListing(archivePaths, entry.id);
    await mkdir(extractionRoot, { recursive: true });
    if (entry.extractor === "sevenzip") execute(executable, ["x", "-y", `-o${extractionRoot}`, archive]);
    else execute(executable, ["-xf", archive, "-C", extractionRoot]);
    return;
  }
  await mkdir(extractionRoot, { recursive: true });
  if (!extractors?.innounp) throw new Error(`${entry.id} requires the prepared innounp executable`);
  // innounp returns 3 after a successful extraction when an installer contains
  // entries it intentionally skips. Required-file verification remains the gate.
  execute(extractors.innounp, ["-x", "-b", "-y", `-d${extractionRoot}`, archive], {
    acceptedStatuses: [0, 3],
  });
}

export async function prepareWindowsSource({ entry, source, sha256, preparedRoot, extractors }) {
  const root = join(preparedRoot, entry.destination);
  if (await markerMatches(root, sha256)) {
    await verifyPrepared(root, entry);
    return root;
  }
  await mkdir(preparedRoot, { recursive: true });
  const staging = `${root}.staging-${randomUUID()}`;
  const extracted = `${root}.extracted-${randomUUID()}`;
  const replaced = (await exists(root)) ? `${root}.replaced-${randomUUID()}` : null;
  try {
    await extract(entry, source, extracted, extractors);
    await rejectLinks(extracted);
    const content = entry.stripPrefix ? join(extracted, entry.stripPrefix) : extracted;
    await cp(content, staging, { recursive: true, dereference: true });
    await verifyPrepared(staging, entry);
    await writeFile(join(staging, ".penpot-source.json"), `${JSON.stringify({ schemaVersion: 1, source: entry.id, sha256 }, null, 2)}\n`);
    if (replaced) await renameWithRetry(root, replaced);
    await renameWithRetry(staging, root);
    if (replaced) await rm(replaced, { recursive: true, force: true });
    return root;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (replaced && !(await exists(root))) await renameWithRetry(replaced, root);
    throw error;
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}

export function defaultPreparedRoot(desktopRoot) {
  return resolve(desktopRoot, ".cache/runtime-prepared", WINDOWS_TARGET);
}
