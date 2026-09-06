import assert from "node:assert/strict";
import test from "node:test";

import { importedLibraries, isWindowsSystemLibrary } from "./audit-windows-runtime.mjs";

function fixturePe(imports, delayed = []) {
  const buffer = Buffer.alloc(2048);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write("PE\0\0", 0x80, "ascii");
  buffer.writeUInt16LE(0x8664, 0x84);
  buffer.writeUInt16LE(1, 0x86);
  buffer.writeUInt16LE(240, 0x94);
  const optional = 0x98;
  buffer.writeUInt16LE(0x20b, optional);
  const directory = optional + 112;
  const section = optional + 240;
  buffer.write(".rdata\0\0", section, "ascii");
  buffer.writeUInt32LE(1024, section + 8);
  buffer.writeUInt32LE(0x1000, section + 12);
  buffer.writeUInt32LE(1024, section + 16);
  buffer.writeUInt32LE(512, section + 20);
  let cursor = 800;
  const rva = (offset) => 0x1000 + offset - 512;
  const writeNames = (names, table, stride, nameOffset) => {
    if (!names.length) return;
    buffer.writeUInt32LE(rva(table), directory + (stride === 20 ? 1 : 13) * 8);
    buffer.writeUInt32LE((names.length + 1) * stride, directory + (stride === 20 ? 1 : 13) * 8 + 4);
    for (const [index, name] of names.entries()) {
      buffer.writeUInt32LE(rva(cursor), table + index * stride + nameOffset);
      cursor += buffer.write(`${name}\0`, cursor, "ascii");
    }
  };
  writeNames(imports, 600, 20, 12);
  writeNames(delayed, 700, 32, 4);
  return buffer;
}

test("reads normal and delayed PE imports", () => {
  assert.deepEqual(
    importedLibraries(fixturePe(["KERNEL32.dll", "VCRUNTIME140.dll"], ["delay.dll"])),
    ["delay.dll", "kernel32.dll", "vcruntime140.dll"],
  );
});

test("recognizes only declared Windows system libraries", () => {
  assert.equal(isWindowsSystemLibrary("KERNEL32.dll"), true);
  assert.equal(isWindowsSystemLibrary("api-ms-win-core-file-l1-2-0.dll"), true);
  assert.equal(isWindowsSystemLibrary("d3d11.dll"), true);
  assert.equal(isWindowsSystemLibrary("mfplat.dll"), true);
  assert.equal(isWindowsSystemLibrary("mscoree.dll"), true);
  assert.equal(isWindowsSystemLibrary("mswsock.dll"), true);
  assert.equal(isWindowsSystemLibrary("uiautomationcore.dll"), true);
  assert.equal(isWindowsSystemLibrary("vcruntime140.dll"), false);
});

test("rejects non-PE input", () => {
  assert.throws(() => importedLibraries(Buffer.from("not a PE")), /not a Windows portable executable/);
});
