import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { resolveToolCommand } from "../packaging/tool-command.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const pluginsRoot = resolve(desktopRoot, "..", "plugins");
const target = resolve(desktopRoot, "ui", "plugins", "web-to-penpot");
const modulePnpm = JSON.parse(
  readFileSync(resolve(pluginsRoot, "package.json"), "utf8"),
).packageManager.split("+")[0];
const pnpmArgs = [
  "--dir",
  pluginsRoot,
  "--filter",
  "web-to-penpot-plugin",
  "copy:offline",
  "--",
  target,
];

export function prepareWebToPenpot({
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
} = {}) {
  // The root workspace pins pnpm 11, while plugins pins pnpm 12. Resolve the
  // module's pinned version before pnpm starts; calling pnpm.cmd here would
  // select the root version and fail the nested module version check.
  const command = resolveToolCommand({
    env,
    name: "PENPOT_BUILD_PNPM",
    fallback:
      platform === "win32"
        ? [env.ComSpec ?? "cmd.exe", "/d", "/c", "corepack.cmd", modulePnpm]
        : ["corepack", modulePnpm],
  });
  const result = spawn(command[0], [...command.slice(1), ...pnpmArgs], {
    env,
    shell: false,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  prepareWebToPenpot();
}
