import { join } from "node:path";
import { desktopRoot, nativeTarget, run, verifyRuntime } from "./verify.mjs";

// Verify first: a bootstrap-only installer must never look like a product build.
try {
  const target = nativeTarget();
  const runtime = verifyRuntime(target);
  const config = {
    bundle: {
      targets: process.platform === "darwin" ? ["dmg"] : ["nsis"],
      resources: { [runtime]: `runtime/${target}/` },
    },
  };
  run(process.execPath, [join(desktopRoot, "node_modules/@tauri-apps/cli/tauri.js"),
    "build", "--target", target, "--config", JSON.stringify(config), ...process.argv.slice(2)]);
} catch (error) {
  console.error(`Desktop packaging stopped: ${error.message}`);
  process.exitCode = 1;
}
