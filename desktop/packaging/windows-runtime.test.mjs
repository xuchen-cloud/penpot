import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSevenZipListing, prepareWindowsSource, validateArchiveListing, validateWindowsMetadata } from "./windows-runtime.mjs";

test("validates Windows preparation layouts", () => {
  assert.deepEqual(
    validateWindowsMetadata({
      schemaVersion: 1,
      target: "x86_64-pc-windows-msvc",
      sources: [
        {
          id: "node",
          windows: {
            format: "archive",
            destination: "node",
            stripPrefix: "node-v24-win-x64",
            requiredFiles: ["node.exe"],
          },
        },
      ],
    }),
    [
      {
        id: "node",
        format: "archive",
        destination: "node",
        stripPrefix: "node-v24-win-x64",
        requiredFiles: ["node.exe"],
        extractor: null,
        runtimePath: null,
      },
    ],
  );
});

test("rejects escaping and Windows device archive paths", () => {
  assert.throws(() => validateArchiveListing("../outside.dll\n", "fixture"), /unsafe Windows path segment/);
  assert.throws(() => validateArchiveListing("tools/CON.txt\n", "fixture"), /unsafe Windows path segment/);
  assert.throws(() => validateArchiveListing("C:\\outside.dll\n", "fixture"), /relative path/);
});

test("accepts directory entries with trailing separators", () => {
  assert.deepEqual(validateArchiveListing("runtime/\nruntime/bin/tool.exe\n", "fixture"), [
    "runtime/",
    "runtime/bin/tool.exe",
  ]);
});

test("parses structured 7-Zip listings without treating the archive as an entry", () => {
  assert.equal(
    parseSevenZipListing("Path = C:\\cache\\tools.7z\r\nType = 7z\r\n\r\nPath = tools\r\nPath = tools/magick.exe\r\n"),
    "tools\ntools/magick.exe",
  );
});

test("validates the committed Windows runtime metadata", async () => {
  const metadata = JSON.parse(await readFile(new URL("./runtime-metadata.windows.json", import.meta.url), "utf8"));
  const entries = validateWindowsMetadata(metadata);
  assert.ok(entries.some((entry) => entry.id === "webview2"));
  assert.ok(entries.some((entry) => entry.id === "fontforge" && entry.format === "inno"));
  assert.ok(entries.some((entry) => entry.id === "postgresql" && entry.runtimePath === "postgres"));
});

test("gives a single-file source its declared runtime filename", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "penpot-windows-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "artifact");
  await writeFile(source, "verified payload");
  const prepared = await prepareWindowsSource({
    entry: { id: "webview2", format: "file", destination: "webview2", requiredFiles: ["OfflineInstaller.exe"], stripPrefix: null, extractor: null, runtimePath: null },
    source,
    sha256: "a".repeat(64),
    preparedRoot: join(root, "prepared"),
  });
  assert.equal(await readFile(join(prepared, "OfflineInstaller.exe"), "utf8"), "verified payload");
});
