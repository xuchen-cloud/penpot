import assert from "node:assert/strict";
import test from "node:test";

import { prepareWebToPenpot } from "../scripts/prepare-web-to-penpot.mjs";

test("uses the configured pnpm command without a shell", () => {
  const calls = [];
  const result = prepareWebToPenpot({
    env: {
      PENPOT_BUILD_PNPM_COMMAND: '["node","pnpm.mjs"]',
    },
    platform: "win32",
    spawn: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.equal(result.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "node");
  assert.deepEqual(calls[0][1].slice(0, 2), ["pnpm.mjs", "--dir"]);
  assert.equal(calls[0][2].shell, false);
});

test("uses the module pnpm version through Corepack by default", () => {
  const calls = [];
  prepareWebToPenpot({
    env: {},
    platform: "win32",
    spawn: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.equal(calls[0][0], "cmd.exe");
  assert.deepEqual(calls[0][1].slice(0, 5), [
    "/d",
    "/c",
    "corepack.cmd",
    "pnpm@12.0.0",
    "--dir",
  ]);
});
