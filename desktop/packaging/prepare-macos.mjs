import { access } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { desktopRoot, run } from "./verify.mjs";
import { prepareRuntimeDownloads } from "./runtime-downloads.mjs";
import { defaultDownloadCacheRoot, withTargetLock } from "./download-cache.mjs";

const target = "aarch64-apple-darwin";
const metadataPath = join(desktopRoot, "packaging/runtime-metadata.macos.json");
const preparedRoot = join(desktopRoot, ".cache/runtime-prepared", target);

function exists(path) {
  return new Promise((resolve) => access(path, (error) => resolve(!error)));
}

async function preparedMatches(root, checksum) {
  try {
    const marker = JSON.parse(
      await readFile(join(root, ".penpot-source.json"), "utf8"),
    );
    return marker.schemaVersion === 1 && marker.sha256 === checksum;
  } catch {
    return false;
  }
}

async function prepareArchive({ component, archive, checksum, extract }) {
  const root = join(preparedRoot, component);
  if (await preparedMatches(root, checksum)) return root;
  await mkdir(preparedRoot, { recursive: true });
  const replaced = (await exists(root))
    ? `${root}.replaced-${randomUUID()}`
    : null;
  if (replaced) await rename(root, replaced);
  const staging = `${root}.staging-${randomUUID()}`;
  try {
    await mkdir(staging);
    extract(archive, staging);
    await writeFile(
      join(staging, ".penpot-source.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          component,
          sha256: checksum,
        },
        null,
        2,
      )}\n`,
    );
    await rename(staging, root);
    if (replaced) await rm(replaced, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (replaced && !(await exists(root))) await rename(replaced, root);
    throw error;
  }
  return root;
}

try {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS runtime preparation requires an Apple Silicon host");
  }
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const sources = Object.fromEntries(
    metadata.sources.map((source) => [source.id, source]),
  );
  const cacheRoot = defaultDownloadCacheRoot();
  await withTargetLock({ cacheRoot, target }, async (lock) => {
    const downloads = await prepareRuntimeDownloads({
      metadataPath,
      selectedIds: ["node", "chromium"],
      cacheRoot,
      lock,
      downloadOptions: {
        onEvent: (event) => console.error(JSON.stringify(event)),
      },
    });
    await prepareArchive({
      component: "node",
      archive: downloads.node,
      checksum: sources.node.sha256,
      extract: (archive, destination) =>
        run("tar", ["-xzf", archive, "-C", destination]),
    });
    await prepareArchive({
      component: "chromium",
      archive: downloads.chromium,
      checksum: sources.chromium.sha256,
      extract: (archive, destination) =>
        run("ditto", ["-x", "-k", archive, destination]),
    });
  });
  console.log(
    `Prepared verified Node and Chromium archives under ${preparedRoot}.`,
  );
} catch (error) {
  console.error(`macOS runtime preparation stopped: ${error.message}`);
  process.exitCode = 1;
}
