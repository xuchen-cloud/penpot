import assert from "node:assert/strict";
import test from "node:test";

import { runtimeAction } from "./status.js";

test("starts a verified runtime and opens a running runtime", () => {
  assert.deepEqual(runtimeAction({ phase: "ready" }), { command: "start_instance" });
  assert.deepEqual(
    runtimeAction({ phase: "running", publicUrl: "http://localhost:9001/" }),
    { publicUrl: "http://localhost:9001/" },
  );
});

test("does not act on setup and error states", () => {
  assert.equal(runtimeAction({ phase: "not_initialized" }), null);
  assert.equal(runtimeAction({ phase: "missing_runtime" }), null);
});

test("rejects a running status without a public URL", () => {
  assert.throws(
    () => runtimeAction({ phase: "running" }),
    /running desktop status has no public URL/,
  );
});
