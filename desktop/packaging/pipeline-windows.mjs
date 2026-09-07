import { join } from "node:path";

import { desktopRoot, run } from "./verify.mjs";

try {
  const scripts = ["prepare-windows.mjs"];
  if (!process.env.PENPOT_SHARED_ARTIFACT_ROOT) scripts.push("build-sources.mjs");
  scripts.push("assemble-windows.mjs", "package.mjs", "windows-release-evidence.mjs");
  for (const script of scripts) {
    const arguments_ = [join(desktopRoot, "packaging", script)];
    if (script === "windows-release-evidence.mjs" && process.env.PENPOT_RELEASE_QUALIFY !== "1") arguments_.push("--engineering");
    run(process.execPath, arguments_, desktopRoot, process.env);
  }
} catch (error) {
  console.error(`Windows desktop pipeline stopped: ${error.message}`);
  process.exitCode = 1;
}
