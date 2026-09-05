import { join } from "node:path";

import { desktopRoot, run } from "./verify.mjs";

try {
  for (const script of ["prepare-macos.mjs", "build-sources.mjs", "assemble-macos.mjs", "package.mjs"]) {
    run(process.execPath, [join(desktopRoot, "packaging", script)], desktopRoot, process.env);
  }
} catch (error) {
  console.error(`macOS desktop pipeline stopped: ${error.message}`);
  process.exitCode = 1;
}
