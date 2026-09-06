import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginsRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../plugins",
);
const configured = process.env.PENPOT_BUILD_PNPM_COMMAND;
const command = configured
  ? JSON.parse(configured)
  : [process.platform === "win32" ? "pnpm.cmd" : "pnpm"];
const storeArguments = process.env.PENPOT_PNPM_STORE
  ? ["--store-dir", process.env.PENPOT_PNPM_STORE]
  : [];

function run(args) {
  const result = spawnSync(
    command[0],
    [...command.slice(1), ...storeArguments, ...args],
    {
      cwd: pluginsRoot,
      env: process.env,
      stdio: "inherit",
      shell: false,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args.join(" ")} failed (${result.status ?? result.signal})`,
    );
  }
}

if (
  !Array.isArray(command) ||
  command.length === 0 ||
  command.some((value) => typeof value !== "string" || !value)
) {
  throw new Error(
    "PENPOT_BUILD_PNPM_COMMAND must be a non-empty JSON string array",
  );
}
run(["install", "--frozen-lockfile"]);
run(["run", "build:runtime"]);
