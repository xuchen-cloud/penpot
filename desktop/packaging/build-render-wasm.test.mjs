import assert from "node:assert/strict";
import test from "node:test";

import {
  loadRenderWasmConfiguration,
  reproducibleRustFlags,
} from "./build-render-wasm.mjs";

test("pins the supported Render WASM toolchain and both consumers", async () => {
  const config = await loadRenderWasmConfiguration();

  assert.equal(config.toolchains.rust, "1.91.0");
  assert.equal(config.toolchains.emscripten, "4.0.6");
  assert.equal(
    config.toolchains["emscripten-revision"],
    "1ddaae4d2d6dfbb678ecc193bc988820d1fc4633",
  );
  assert.equal(config.toolchains["skia-safe"], "0.93.1");
  assert.equal(config.toolchains["skia-binaries"], "319323662b1685a112f5");
  assert.deepEqual(Object.keys(config.renderWasm.profiles).sort(), [
    "export",
    "frontend",
  ]);
  assert.ok(
    config.renderWasm.commonFlags.includes("-sDISABLE_EXCEPTION_CATCHING=1"),
  );
  assert.ok(
    !config.renderWasm.commonFlags.some((flag) =>
      flag.includes("SUPPORT_LONGJMP"),
    ),
  );
  assert.ok(
    !config.renderWasm.commonFlags.some((flag) =>
      flag.includes("fwasm-exceptions"),
    ),
  );
});

test("remaps host-specific Rust paths with encoded flags", () => {
  const flags = reproducibleRustFlags({
    targetRoot:
      "D:\\project\\penpot\\desktop\\.cache\\build\\render-wasm\\clean-a",
    emsdkRoot: "D:\\Program Files\\emsdk",
    baseEnv: {
      CARGO_HOME: "D:\\project\\tools\\rust\\cargo",
      CARGO_ENCODED_RUSTFLAGS: "-C\x1fdebuginfo=0",
    },
  }).split("\x1f");

  assert.deepEqual(flags.slice(0, 2), ["-C", "debuginfo=0"]);
  assert.ok(flags.some((flag) => flag.endsWith("=/penpot-target")));
  assert.ok(flags.some((flag) => flag.endsWith("=/emsdk")));
  assert.ok(flags.some((flag) => flag.endsWith("=/cargo-home")));
  assert.ok(flags.some((flag) => flag.endsWith("=/penpot-source")));
  assert.equal(flags.at(-1).endsWith("=/penpot-target"), true);
});
