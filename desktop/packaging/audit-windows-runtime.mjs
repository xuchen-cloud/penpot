import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SYSTEM_DLLS = new Set(
  [
    "advapi32.dll",
    "bcrypt.dll",
    "bcryptprimitives.dll",
    "bthprops.cpl",
    "cabinet.dll",
    "cfgmgr32.dll",
    "comctl32.dll",
    "comdlg32.dll",
    "credui.dll",
    "crypt32.dll",
    "cryptui.dll",
    "dbghelp.dll",
    "d3d11.dll",
    "d3d12.dll",
    "d3d9.dll",
    "dcomp.dll",
    "dsound.dll",
    "dhcpcsvc.dll",
    "dnsapi.dll",
    "dwrite.dll",
    "dxgi.dll",
    "dwmapi.dll",
    "esent.dll",
    "gdi32.dll",
    "gdi32full.dll",
    "gdiplus.dll",
    "hid.dll",
    "imm32.dll",
    "mf.dll",
    "mfplat.dll",
    "mfreadwrite.dll",
    "mmdevapi.dll",
    "ndfapi.dll",
    "iphlpapi.dll",
    "kernel32.dll",
    "kernelbase.dll",
    "mpr.dll",
    "mscoree.dll",
    "msimg32.dll",
    "msvcrt.dll",
    "mswsock.dll",
    "oleacc.dll",
    "ncrypt.dll",
    "netapi32.dll",
    "ntdll.dll",
    "ole32.dll",
    "oleaut32.dll",
    "opengl32.dll",
    "pdh.dll",
    "powrprof.dll",
    "propsys.dll",
    "psapi.dll",
    "rpcrt4.dll",
    "secur32.dll",
    "setupapi.dll",
    "shell32.dll",
    "shlwapi.dll",
    "sspicli.dll",
    "tbs.dll",
    "uiautomationcore.dll",
    "urlmon.dll",
    "user32.dll",
    "userenv.dll",
    "usp10.dll",
    "uxtheme.dll",
    "version.dll",
    "wevtapi.dll",
    "winhttp.dll",
    "wininet.dll",
    "winmm.dll",
    "winspool.drv",
    "wintrust.dll",
    "winusb.dll",
    "winscard.dll",
    "wldap32.dll",
    "ws2_32.dll",
    "wtsapi32.dll",
    "windowscodecs.dll",
  ].map((value) => value.toLowerCase()),
);

export function importedLibraries(buffer, label = "portable executable") {
  if (buffer.length < 64 || buffer.toString("ascii", 0, 2) !== "MZ") {
    throw new Error(`${label} is not a Windows portable executable`);
  }
  const pe = buffer.readUInt32LE(0x3c);
  if (pe + 24 > buffer.length || buffer.toString("ascii", pe, pe + 4) !== "PE\0\0") {
    throw new Error(`${label} has an invalid PE header`);
  }
  const sectionCount = buffer.readUInt16LE(pe + 6);
  const optionalSize = buffer.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const magic = buffer.readUInt16LE(optional);
  const directory = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
  if (directory < optional) throw new Error(`${label} has an unsupported PE format`);
  const sections = [];
  const sectionTable = optional + optionalSize;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTable + index * 40;
    if (offset + 40 > buffer.length) throw new Error(`${label} has a truncated section table`);
    sections.push({
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      rawSize: buffer.readUInt32LE(offset + 16),
      rawOffset: buffer.readUInt32LE(offset + 20),
    });
  }
  const offsetFor = (rva) => {
    const section = sections.find(
      (candidate) =>
        rva >= candidate.virtualAddress &&
        rva < candidate.virtualAddress + Math.max(candidate.virtualSize, candidate.rawSize),
    );
    if (!section) throw new Error(`${label} references an unmapped RVA 0x${rva.toString(16)}`);
    const offset = section.rawOffset + rva - section.virtualAddress;
    if (offset >= buffer.length) throw new Error(`${label} references data outside the file`);
    return offset;
  };
  const stringAt = (rva) => {
    const offset = offsetFor(rva);
    const end = buffer.indexOf(0, offset);
    if (end === -1) throw new Error(`${label} contains an unterminated DLL name`);
    return buffer.toString("ascii", offset, end);
  };
  const libraries = new Set();
  const readDescriptors = (entry, stride, nameOffset) => {
    if (directory + entry * 8 + 8 > buffer.length) return;
    const rva = buffer.readUInt32LE(directory + entry * 8);
    const size = buffer.readUInt32LE(directory + entry * 8 + 4);
    if (!rva || !size) return;
    let offset = offsetFor(rva);
    const limit = Math.min(buffer.length, offset + size);
    while (offset + stride <= limit) {
      const empty = buffer.subarray(offset, offset + stride).every((value) => value === 0);
      if (empty) break;
      const nameRva = buffer.readUInt32LE(offset + nameOffset);
      if (nameRva) libraries.add(stringAt(nameRva).toLowerCase());
      offset += stride;
    }
  };
  readDescriptors(1, 20, 12);
  readDescriptors(13, 32, 4);
  return [...libraries].sort();
}

export function isWindowsSystemLibrary(name) {
  const value = name.toLowerCase();
  return (
    SYSTEM_DLLS.has(value) ||
    value.startsWith("api-ms-win-") ||
    value.startsWith("ext-ms-win-")
  );
}

async function walk(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function portable(root, path) {
  return relative(root, path).split(sep).join("/");
}

function componentFor(path) {
  const segments = path.toLowerCase().split("/");
  return segments[0] === "tools" ? segments.slice(0, 2).join("/") : segments[0];
}

export async function auditWindowsRuntime(runtimeRoot) {
  const root = resolve(runtimeRoot);
  const files = await walk(root);
  const fileByPath = new Map(files.map((path) => [path.toLowerCase(), path]));
  const runtimeSearchFiles = new Map();
  for (const path of files) {
    const name = basename(path).toLowerCase();
    const values = runtimeSearchFiles.get(name) ?? [];
    values.push(path);
    runtimeSearchFiles.set(name, values);
  }
  const portableExecutables = files.filter((path) => [".exe", ".dll"].includes(extname(path).toLowerCase()));
  const byComponent = new Map();
  for (const path of portableExecutables) {
    const component = componentFor(portable(root, path));
    const key = `${component}/${basename(path).toLowerCase()}`;
    const values = byComponent.get(key) ?? [];
    values.push(path);
    byComponent.set(key, values);
  }
  const entries = [];
  const unresolved = [];
  for (const path of portableExecutables) {
    const imports = importedLibraries(await readFile(path), portable(root, path));
    const component = componentFor(portable(root, path));
    const dependencies = imports.map((name) => {
      if (isWindowsSystemLibrary(name)) return { name, resolution: "windows-system" };
      const beside = join(dirname(path), name);
      const candidates = byComponent.get(`${component}/${name}`) ?? [];
      const searchPathCandidates = runtimeSearchFiles.get(name) ?? [];
      const resolved =
        fileByPath.get(beside.toLowerCase()) ??
        candidates[0] ??
        searchPathCandidates[0] ??
        null;
      if (!resolved) unresolved.push({ binary: portable(root, path), library: name });
      return { name, resolution: resolved ? portable(root, resolved) : null };
    });
    entries.push({ path: portable(root, path), dependencies });
  }
  return {
    schemaVersion: 1,
    target: "x86_64-pc-windows-msvc",
    passed: unresolved.length === 0,
    binaries: entries,
    unresolved,
  };
}

async function main() {
  const [, , runtimeRoot, reportPath] = process.argv;
  if (!runtimeRoot || !reportPath) {
    throw new Error("usage: audit-windows-runtime.mjs <runtime-root> <report.json>");
  }
  const report = await auditWindowsRuntime(runtimeRoot);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) {
    throw new Error(`Windows runtime has ${report.unresolved.length} unresolved DLL import(s)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
