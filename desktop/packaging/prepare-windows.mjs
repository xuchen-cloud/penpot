import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultDownloadCacheRoot, withTargetLock } from "./download-cache.mjs";
import { prepareRuntimeDownloads } from "./runtime-downloads.mjs";
import { desktopRoot } from "./verify.mjs";
import {
  defaultPreparedRoot,
  prepareWindowsSource,
  validateWindowsMetadata,
  WINDOWS_TARGET,
} from "./windows-runtime.mjs";
import { buildWindowsRuntimeTools } from "./build-windows-runtime-tools.mjs";

const metadataPath = join(desktopRoot, "packaging/runtime-metadata.windows.json");

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Windows runtime preparation requires a Windows x64 host");
  }
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const entries = validateWindowsMetadata(metadata);
  const sources = new Map(metadata.sources.map((source) => [source.id, source]));
  const cacheRoot = defaultDownloadCacheRoot();
  const preparedRoot = defaultPreparedRoot(desktopRoot);
  await withTargetLock({ cacheRoot, target: WINDOWS_TARGET }, async (lock) => {
    const downloads = await prepareRuntimeDownloads({
      metadataPath,
      selectedIds: entries.map((entry) => entry.id),
      cacheRoot,
      localSourceRoot: process.env.PENPOT_DESKTOP_DOWNLOAD_SOURCE,
      lock,
      downloadOptions: { onEvent: (event) => console.error(JSON.stringify(event)) },
    });
    for (const entry of entries) {
      const extractors = {
        sevenzip: join(preparedRoot, "sevenzip", "7zr.exe"),
        innounp: join(preparedRoot, "innounp", "innounp.exe"),
      };
      await prepareWindowsSource({
        entry,
        source: downloads[entry.id],
        sha256: sources.get(entry.id).sha256,
        preparedRoot,
        extractors,
      });
    }
    await buildWindowsRuntimeTools(preparedRoot);
  });
  console.log(`Prepared verified Windows runtime inputs under ${preparedRoot}.`);
}

main().catch((error) => {
  console.error(`Windows runtime preparation stopped: ${error.message}`);
  process.exitCode = 1;
});
