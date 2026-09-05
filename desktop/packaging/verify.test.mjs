import assert from "node:assert/strict";
import test from "node:test";

import { nativeTarget } from "./verify.mjs";

test("maps each supported packaging host to its Rust target", () => {
  assert.equal(nativeTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(nativeTarget("win32", "x64"), "x86_64-pc-windows-msvc");
});

test("rejects unsupported packaging hosts", () => {
  assert.throws(() => nativeTarget("linux", "x64"), /Unsupported packaging host: linux\/x64/);
});
