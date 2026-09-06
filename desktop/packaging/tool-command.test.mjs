import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  encodePowerShellFileArguments,
  invokeTool,
  resolveToolCommand,
} from "./tool-command.mjs";

const packagingRoot = dirname(fileURLToPath(import.meta.url));

function encodedPowerShellArgument(value) {
  return `PENPOT_BASE64:${Buffer.from(value, "utf8").toString("base64")}`;
}

test("keeps a portable executable fallback", () => {
  assert.deepEqual(
    resolveToolCommand({
      env: {},
      name: "PENPOT_BUILD_PNPM",
      fallback: "pnpm",
    }),
    ["pnpm"],
  );
});

test("supports a shell-free fallback with prefix arguments", () => {
  assert.deepEqual(
    resolveToolCommand({
      env: {},
      name: "PENPOT_BUILD_CLOJURE",
      fallback: [
        "powershell.exe",
        "-NoProfile",
        "-File",
        "invoke-clojure-windows.ps1",
      ],
    }),
    ["powershell.exe", "-NoProfile", "-File", "invoke-clojure-windows.ps1"],
  );
});

test("accepts a shell-free Windows command with prefix arguments", () => {
  const command = resolveToolCommand({
    env: {
      PENPOT_BUILD_CLOJURE_COMMAND:
        '["powershell.exe","-NoProfile","-File","clojure.ps1"]',
    },
    name: "PENPOT_BUILD_CLOJURE",
    fallback: "clojure",
  });
  const calls = [];
  invokeTool((...args) => calls.push(args), command, ["-Sdescribe"], "repo", {
    TEST: "1",
  });

  assert.deepEqual(calls, [
    [
      "powershell.exe",
      ["-NoProfile", "-File", "clojure.ps1", "-Sdescribe"],
      "repo",
      { TEST: "1" },
    ],
  ]);
});

test("rejects malformed command configuration", () => {
  assert.throws(
    () =>
      resolveToolCommand({
        env: { TOOL_COMMAND: "not-json" },
        name: "TOOL",
        fallback: "tool",
      }),
    /JSON array/,
  );
});

test("encodes PowerShell file arguments without changing their contents", () => {
  assert.deepEqual(
    encodePowerShellFileArguments(["-M:dev:shadow-cljs", "path with spaces"]),
    [
      "PENPOT_BASE64:LU06ZGV2OnNoYWRvdy1jbGpz",
      "PENPOT_BASE64:cGF0aCB3aXRoIHNwYWNlcw==",
    ],
  );
});

test(
  "Windows Clojure adapter preserves aliases, spaces, and exit codes",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "penpot clojure adapter "));
    try {
      const module = join(root, "Fake ClojureTools.psm1");
      await writeFile(
        module,
        `
function Invoke-Clojure {
  [Console]::Out.WriteLine(($args | ConvertTo-Json -Compress))
  & $env:ComSpec /c exit $env:FAKE_CLOJURE_EXIT
}
New-Alias -Name clojure -Value Invoke-Clojure
Export-ModuleMember -Function Invoke-Clojure -Alias clojure
`,
      );
      const args = ["-T:build", "compile", "path with spaces"];
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(packagingRoot, "invoke-clojure-windows.ps1"),
          ...args.map(encodedPowerShellArgument),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_CLOJURE_EXIT: "7",
            JAVA_HOME: root,
            PENPOT_CLOJURE_TOOLS_MODULE: module,
          },
        },
      );

      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), [
        "-T:",
        "build",
        ...args.slice(1),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
