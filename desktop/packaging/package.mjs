import { join } from "node:path";
import { desktopRoot, nativeTarget, run, verifyRuntime } from "./verify.mjs";

// Verify first: a bootstrap-only installer must never look like a product build.
try {
  const target = nativeTarget();
  const runtime = verifyRuntime(target);
  if (process.platform === "win32") {
    run("cargo", ["build", "--locked", "--release", "--target", target, "--manifest-path", "src-tauri/Cargo.toml", "--bin", "penpot-desktop-compat"]);
  }
  const config = {
    bundle: {
      targets: process.platform === "darwin" ? ["dmg"] : ["nsis"],
      resources: { [runtime]: `runtime/${target}/` },
    },
  };
  if (process.platform === "win32") {
    config.bundle.resources[join(desktopRoot, "src-tauri", "target", target, "release", "penpot-desktop-compat.exe")] = "acceptance/penpot-desktop-compat.exe";
    config.bundle.resources[join(desktopRoot, "compatibility", "plans", `${target}.json`)] = "acceptance/windows-plan.json";
    config.bundle.resources[join(desktopRoot, ".cache/runtime-prepared", target, "webview2/MicrosoftEdgeWebView2RuntimeInstallerX64.exe")] = "MicrosoftEdgeWebView2RuntimeInstallerX64.exe";
    config.bundle.windows = {
      webviewInstallMode: {
        type: "offlineInstaller",
        silent: true,
      },
      nsis: { installMode: "currentUser" },
    };
  }
  run(process.execPath, [join(desktopRoot, "node_modules/@tauri-apps/cli/tauri.js"),
    "build", "--target", target, "--config", JSON.stringify(config), ...process.argv.slice(2)]);
} catch (error) {
  console.error(`Desktop packaging stopped: ${error.message}`);
  process.exitCode = 1;
}
