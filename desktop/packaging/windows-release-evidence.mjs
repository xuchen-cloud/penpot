import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { desktopRoot } from "./verify.mjs";
import { WINDOWS_TARGET } from "./windows-runtime.mjs";

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function licenseInventory(metadata) {
  return [...metadata.components, ...metadata.sources].map(({ id, version, source, license }) => ({ id, version, source, license }));
}

export function cycloneDx(metadata, installer, installerSha256) {
  const serial = `${installerSha256.slice(0, 8)}-${installerSha256.slice(8, 12)}-${installerSha256.slice(12, 16)}-${installerSha256.slice(16, 20)}-${installerSha256.slice(20, 32)}`;
  return {
    bomFormat: "CycloneDX", specVersion: "1.6", serialNumber: `urn:uuid:${serial}`, version: 1,
    metadata: { component: { type: "application", name: "Penpot Desktop", version: "2.17.0-desktop.1", hashes: [{ alg: "SHA-256", content: installerSha256 }] } },
    components: licenseInventory(metadata).map((value) => ({ type: "library", name: value.id, version: value.version, licenses: [{ license: { name: value.license } }], externalReferences: [{ type: "distribution", url: value.source }] })),
    properties: [{ name: "penpot:installer", value: basename(installer) }, { name: "penpot:target", value: WINDOWS_TARGET }],
  };
}

function signature(path) {
  const escaped = path.replaceAll("'", "''");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; [pscustomobject]@{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject;thumbprint=[string]$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Authenticode inspection failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: resolve(desktopRoot, ".."), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim();
}

export async function generateWindowsReleaseEvidence({ installer, output, engineering = false }) {
  const metadata = JSON.parse(await readFile(join(desktopRoot, "packaging", "runtime-metadata.windows.json"), "utf8"));
  const installerPath = resolve(installer);
  const digest = await sha256(installerPath);
  const signing = signature(installerPath);
  const releaseQualified = signing.status === "Valid";
  if (!releaseQualified && !engineering) throw new Error(`release qualification requires a valid Authenticode signature; status=${signing.status}`);
  await mkdir(output, { recursive: true });
  const provenance = {
    schemaVersion: 1,
    subject: { name: basename(installerPath), sha256: digest },
    source: { repository: "https://github.com/xuchen-cloud/penpot", revision: git(["rev-parse", "HEAD"]) },
    build: { target: WINDOWS_TARGET, engineering, releaseQualified, signing },
  };
  await Promise.all([
    writeFile(join(output, "SHA256SUMS.txt"), `${digest}  ${basename(installerPath)}\n`),
    writeFile(join(output, "licenses.windows.json"), `${JSON.stringify({ schemaVersion: 1, licenses: licenseInventory(metadata) }, null, 2)}\n`),
    writeFile(join(output, "sbom.cdx.json"), `${JSON.stringify(cycloneDx(metadata, installerPath, digest), null, 2)}\n`),
    writeFile(join(output, "provenance.windows.json"), `${JSON.stringify(provenance, null, 2)}\n`),
  ]);
  return provenance;
}

async function main() {
  const engineering = process.argv.includes("--engineering");
  const given = process.argv.slice(2).find((value) => !value.startsWith("--"));
  let installer = given;
  if (!installer) {
    const nsis = join(desktopRoot, "src-tauri", "target", WINDOWS_TARGET, "release", "bundle", "nsis");
    const candidates = (await readdir(nsis)).filter((value) => value.toLowerCase().endsWith("-setup.exe"));
    if (candidates.length !== 1) throw new Error(`expected one NSIS installer under ${nsis}, found ${candidates.length}`);
    installer = join(nsis, candidates[0]);
  }
  const output = join(desktopRoot, "target", "release-evidence", WINDOWS_TARGET);
  const result = await generateWindowsReleaseEvidence({ installer, output, engineering });
  console.log(`${result.build.releaseQualified ? "Release-qualified" : "Engineering-only"} evidence: ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
