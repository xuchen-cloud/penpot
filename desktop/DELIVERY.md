# Desktop delivery milestones

The deliverable is an installer that works without a developer environment or
runtime downloads. A shell build or Rust test run does not meet this goal.
Stage 1 reports do not block development. Native package tests remain required
before a target is marked usable.

## A. Complete runtime assembly (in progress)

- Pin archives and record source, license, checksum, target, and build recipe.
- Build Backend, frontend, both WASM renderers, Exporter, and Media Processor.
- Include native libraries, Node modules, Chromium resources, fonts, and tools.
- Make all paths relocatable; reject links outside the runtime.
- Hash the complete runtime after relocation and nested executable signing.
- Package only the selected target with Tauri; include offline WebView2 on Windows.
- Reject incomplete input before producing a desktop installer.

## B. First usable macOS development package

- Connect secrets in Keychain, instance lock, database bootstrap and migrations.
- Start dependencies with readiness, port retries, failure rollback, and clean exit.
- Implement the loopback gateway, WebSocket, confined assets, and frontend config.
- Connect bootstrap progress, retry, log access, and safe shutdown to the shell.
- Install from the development package in a fresh directory; create an account,
  open the editor, save a document, restart, and reopen it without network access.

## C. Windows parity

- Implement Credential Manager, owner-only ACLs, instance focus, and Job Objects.
- Assemble x64 runtime archives and verify cache authentication, queues, and Lua.
- Install the NSIS package on Windows 11 without developer tools or network access.
- Repeat first-use, save/restart, failure, and uninstall/reinstall data checks.

## D. Offline product, data safety, and release

- Complete roadmap stages 3 and 4: first administrator, invitations, local assets,
  navigation limits, backup/restore, signed offline upgrades, and optional LAN.
- Complete stage 5 user flows, including uploads, imports, exports, collaboration,
  failure recovery, network capture, and no child processes after full exit.
- Produce signed/notarized macOS and signed Windows installers with checksums,
  licenses, SBOM, and provenance. Signing credentials remain external inputs.

## Current evidence (2026-09-05)

- Runtime lock, process specifications, supervisor, gateway, and shell are separate
  modules. The shell now starts the local stack, but no assembled runtime has yet
  proved that path end to end.
- Runtime lock v1 checks entry files only; complete tree coverage remains required.
- No complete runtime or installable product package has been assembled.
- The ARM64 Homebrew JDK at `/opt/homebrew/opt/openjdk/bin/java` works locally;
  the earlier claim that no usable ARM64 JDK exists was too broad.
- Windows native execution and signed release acceptance have not run.
