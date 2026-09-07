import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { desktopRoot } from "./verify.mjs";

test("Windows packages remove only stale package-owned runtime directories before upgrades", async () => {
  const packageSource = await readFile(join(desktopRoot, "packaging", "package.mjs"), "utf8");
  const tauriConfig = JSON.parse(await readFile(join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const hooks = await readFile(join(desktopRoot, "src-tauri", "nsis", "installer-hooks.nsh"), "utf8");

  assert.match(packageSource, /installerHooks: join\(desktopRoot, "src-tauri", "nsis", "installer-hooks\.nsh"\)/);
  assert.equal(tauriConfig.bundle.windows.nsis.installerHooks, "nsis/installer-hooks.nsh");
  assert.match(hooks, /!macro NSIS_HOOK_PREINSTALL/);
  assert.match(hooks, /RMDir \/r "\$INSTDIR\\runtime"/);
  assert.match(hooks, /RMDir \/r "\$INSTDIR\\acceptance"/);
  assert.doesNotMatch(hooks, /APPDATA|LOCALAPPDATA|USERPROFILE/i);
});
