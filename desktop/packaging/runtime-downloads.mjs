import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  defaultDownloadCacheRoot,
  prepareDownloads,
} from "./download-cache.mjs";

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function validateRuntimeDownloadManifest(manifest, selectedIds = null) {
  if (manifest?.schemaVersion !== 1)
    throw new Error("Runtime metadata schemaVersion must be 1");
  const target = requiredString(manifest.target, "Runtime metadata target");
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    throw new Error("Runtime metadata sources must be a non-empty array");
  }
  const wanted = selectedIds ? new Set(selectedIds) : null;
  const seen = new Set();
  const artifacts = [];
  for (const [index, source] of manifest.sources.entries()) {
    const prefix = `Runtime metadata source ${index}`;
    const id = requiredString(source?.id, `${prefix} id`);
    if (seen.has(id)) throw new Error(`Runtime metadata repeats source ${id}`);
    seen.add(id);
    if (wanted && !wanted.has(id)) continue;
    requiredString(source.license, `${prefix} license`);
    requiredString(source.buildRecipe, `${prefix} buildRecipe`);
    artifacts.push({
      component: id,
      version: requiredString(source.version, `${prefix} version`),
      url: new URL(
        requiredString(source.source, `${prefix} source`),
      ).toString(),
      sha256: requiredString(source.sha256, `${prefix} sha256`),
    });
  }
  if (wanted) {
    const missing = [...wanted].filter((id) => !seen.has(id));
    if (missing.length)
      throw new Error(
        `Runtime metadata is missing selected sources: ${missing.join(", ")}`,
      );
  }
  if (artifacts.length === 0)
    throw new Error("No runtime sources were selected for download");
  return { target, artifacts };
}

export async function loadRuntimeDownloadManifest(path, selectedIds = null) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  return validateRuntimeDownloadManifest(manifest, selectedIds);
}

export async function prepareRuntimeDownloads({
  metadataPath,
  selectedIds = null,
  cacheRoot = defaultDownloadCacheRoot(),
  localSourceRoot,
  lockOptions,
  downloadOptions,
  lock,
}) {
  const manifest = await loadRuntimeDownloadManifest(metadataPath, selectedIds);
  const paths = await prepareDownloads({
    cacheRoot,
    target: manifest.target,
    artifacts: manifest.artifacts,
    localSourceRoot,
    lockOptions,
    downloadOptions,
    lock,
  });
  return Object.fromEntries(
    manifest.artifacts.map((artifact, index) => [
      artifact.component,
      paths[index],
    ]),
  );
}

async function main() {
  const [, , metadataArgument, ...selectedIds] = process.argv;
  if (!metadataArgument) {
    throw new Error(
      "usage: node runtime-downloads.mjs <runtime-metadata.json> [source-id ...]",
    );
  }
  const prepared = await prepareRuntimeDownloads({
    metadataPath: resolve(metadataArgument),
    selectedIds: selectedIds.length ? selectedIds : null,
    downloadOptions: {
      onEvent: (event) => console.error(JSON.stringify(event)),
    },
  });
  console.log(JSON.stringify(prepared, null, 2));
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
