# Issue 1 implementation plan

## Goal

Make Penpot Desktop source artifacts and runtime downloads reproducible for
Windows and macOS packaging. Windows is the first development and verification
host, while shared formats and code must remain usable on macOS without a
second implementation.

This work does not include Windows runtime assembly or NSIS packaging. It also
does not include macOS dylib relocation, signing, notarization, or DMG work.

## Result

Issue 1 is implemented and verified on Windows. The unified source build now
pins its toolchains, uses project-local persistent dependency caches, builds all
six shared components, records dirty-worktree provenance, and stages a verified
portable artifact contract. Two builds from isolated generated-output trees
produce identical manifests, file sets, sizes, and SHA-256 checksums.

The macOS preparation and assembly paths consume the same manifest contract,
and Desktop Node/Rust checks are configured for macOS 14 CI. A full unified
source build has not run on a macOS host, so macOS remains configured but
unverified. Installer assembly, signing, notarization, DMG, MSI, and NSIS work
remain outside Issue 1.

## Work sequence

### 1. Freeze shared contracts

- Add machine-readable toolchain configuration for Rust 1.91.0, Emscripten
  4.0.6, the Skia crate and binary revision, Node 24.19.0, and the declared pnpm
  versions.
- Define a versioned shared artifact manifest for Backend, Frontend, Exporter,
  Media Processor, and both Render WASM consumers.
- Store only portable relative paths in manifests. Record the source revision,
  build command, toolchains, licenses, sizes, and SHA-256 checksums.
- Keep platform-native executables and Node dependencies out of the shared
  artifact set.

### 2. Build the verified download cache on Windows

- Keep the persistent default cache under
  `desktop/.cache/runtime-downloads/`. Ignore its contents in Git and allow CI
  or developers to override the root with `PENPOT_DESKTOP_DOWNLOAD_CACHE`.
- Check `D:/project/tools/downloads` through the portable project-relative
  default before network access. Import an existing package only after its
  declared SHA-256 passes; allow override with
  `PENPOT_DESKTOP_DOWNLOAD_SOURCE`.
- Key cache entries by component, version, target, and expected checksum.
- Download to a partial file, verify the complete SHA-256, and promote it with a
  same-filesystem atomic rename.
- Resume only when partial metadata and the server response match the requested
  object. Restart with a clear reason when resume is unsafe.
- Add connection and inactivity timeouts, bounded retries, backoff, redirect
  limits, and credential-safe errors.
- Add per-target locks with an owner token, PID, host, heartbeat, and guarded
  stale-lock recovery.
- Use Node filesystem and HTTP APIs in the shared implementation. Keep host
  command differences in thin adapters.

### 3. Repair Render WASM through a minimal build path

- Reproduce each target without running Desktop downloads or packaging.
- Capture the actual Rust, Emscripten, and Skia link configuration.
- Select a repository-supported exception and longjmp combination, then store it
  in the pinned configuration.
- Build Frontend and Exporter Render WASM from separate clean output directories.
- Load each generated module and check real exported state.
- Repeat both builds and compare their declared outputs and checksums.

### 4. Produce versioned shared artifacts

- Build all shared source components into a staging directory.
- Check every declared output before generating the artifact manifest.
- Promote the complete version directory only after verification.
- Run the complete source build twice from clean output and compare the output
  manifests.

### 5. Integrate existing platform preparation

- Replace the private Node download path in `prepare-macos.mjs` with the shared
  cache API.
- Make macOS assembly consume and verify the shared artifact manifest.
- Expose the same preparation API for Windows metadata owned by Issue 2.
- Keep Windows and macOS native dependency installation in their platform
  packaging tracks.

### 6. Verify on both hosts

- Use a local HTTP fixture to test cache hits, cache misses, checksum failures,
  interrupted transfers, resume, retry exhaustion, concurrent callers, stale
  partial files, stale locks, and atomic replacement.
- Run the Desktop Node tests in the Windows 2025 and macOS 14 CI jobs.
- Keep the existing Rust tests, Clippy, and format checks.
- Save full logs for long builds and downloads. Use one process per target and
  delegate low-frequency waiting to a Luna agent.

## Cross-platform rules

- Manifest paths use `/`; filesystem access converts them with `node:path`.
- Cache and lock names avoid case-only differences, reserved Windows names, and
  characters rejected by either filesystem.
- Atomic replacement follows Windows' stricter destination behavior.
- Lock recovery never relies on Unix advisory-lock semantics.
- Shared code does not assume `/tmp`, shell scripts, symlinks, executable bits,
  or a case-sensitive filesystem.
- CI must exercise shared behavior on Windows and macOS from the first change.

## Completion conditions

- Cold preparation downloads and verifies every requested fixture.
- Warm preparation performs no network transfer.
- Interrupted or concurrent preparation cannot expose a partial archive as
  complete.
- Frontend and Exporter Render WASM each build twice and pass a load smoke test.
- Two clean source builds produce the same declared file set and checksums.
- Windows and macOS packaging can consume the same shared artifact contract.
- Failures identify the component, target, redacted URL, expected checksum,
  actual result, and next safe action.

## Implementation status

- The persistent verified download cache, resume rules, bounded retry, atomic
  promotion, and whole-target preparation lock are implemented and tested.
- The cache imports matching archives from `D:/project/tools/downloads` before
  network access and keeps runtime, pnpm, Clojure, and Maven caches in the
  project by default.
- The shared artifact manifest, verifier, installer, and repeated-manifest
  comparison are implemented with case-insensitive collision checks.
- Frontend and Exporter Render WASM each pass two independent clean builds,
  real module-load smoke tests, absolute-path scans, and matching SHA-256
  checks.
- Windows Clojure invocation preserves combined aliases, arguments containing
  spaces, and child exit codes through a Base64 argument envelope.
- Module pnpm 12 runs through an explicit Node command, including the nested
  plugin runtime build. The content-addressable store is
  `desktop/.cache/pnpm-store/`; Maven and Git dependencies use
  `desktop/.cache/m2/` and `desktop/.cache/gitlibs/`.
- Frontend asset copying uses Node filesystem APIs instead of `rsync`, and the
  UI CSS copy runs after Vite has written its output.
- Build timestamps come from the source commit. Backend JAR entry times are
  normalized, Google font UUIDs derive from stable font IDs, and Frontend plus
  Exporter disable nondeterministic parallel ClojureScript analysis.
- The final Windows A/B source builds write full logs to
  `.ci-logs/issue-1-build-sources-delivery-a.log` and
  `.ci-logs/issue-1-build-sources-delivery-b.log`. Their comparison log is
  `.ci-logs/issue-1-verify-delivery-a-b.log`.
- Windows and macOS CI run the shared Node packaging tests. The local Windows
  suite passes 47 tests; Rust passes 57 tests with 2 ignored, plus Clippy and
  rustfmt. macOS CI is configured but has not run for this feature branch.
