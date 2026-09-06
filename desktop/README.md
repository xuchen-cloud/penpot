# Penpot Desktop

This module packages Penpot as a self-contained desktop application for macOS
and Windows. The installed application must not download runtime dependencies.

The Rust application owns the local runtime, process lifecycle, loopback gateway,
backup flow, and desktop UI. Penpot services stay isolated on loopback ports.

## Development

```bash
pnpm --dir ../plugins install --frozen-lockfile
pnpm install
pnpm run test:rust
pnpm run dev
```

The runtime binaries are not stored in Git. Release jobs assemble the pinned
runtime under `src-tauri/resources/runtime/<target-triple>/` before packaging.
The checked-in runtime manifest defines the required files for each target.

Runtime downloads use a verified persistent cache at
`desktop/.cache/runtime-downloads/`. A warm preparation reuses an entry only
after its SHA-256 checksum passes. Set `PENPOT_DESKTOP_DOWNLOAD_CACHE` when CI or
a developer needs the same cache contract at another persistent path.
Before using the network, preparation checks the shared local source directory
at `../tools/downloads` (resolved from the project root) and imports a matching
file only when its declared checksum passes. Override that read-only source with
`PENPOT_DESKTOP_DOWNLOAD_SOURCE`.

On the Windows development host, Render WASM uses Emscripten 4.0.6 from
`D:\Program Files\emsdk` by default. Set `PENPOT_BUILD_EMSDK` to use another
verified SDK location; macOS and CI must set it explicitly.

pnpm keeps downloaded package data under `desktop/.cache/pnpm-store/` during
source builds and runtime assembly. Set `PENPOT_PNPM_STORE` only when a shared
CI cache must use another persistent path. Runtime assembly reuses that store
and downloads any missing locked packages during the build. pnpm's
machine-local state is under `desktop/.cache/pnpm-state/`; override it with
`PENPOT_PNPM_STATE`.
Corepack uses
`desktop/.cache/corepack/`; set `PENPOT_COREPACK_HOME` when CI provides that
cache elsewhere.
Clojure uses `desktop/.cache/m2/`, `desktop/.cache/clojure-config/`, and
`desktop/.cache/clojure-cache/` for the same reason. Git dependencies use
`desktop/.cache/gitlibs/`. Existing `CLJ_CONFIG`, `CLJ_CACHE`, and `GITLIBS`
values take precedence.

Prepare selected archives or verify a staged source artifact set with:

```bash
node packaging/runtime-downloads.mjs packaging/runtime-metadata.macos.json node chromium
node packaging/verify-shared-artifacts.mjs target/shared-artifacts/2.17.0-desktop.1
```

Pass two shared artifact roots to the second command to require identical
manifests from two clean builds.

### Windows 11 x64 packaging

完整的重建步骤、代码更新影响检查和已知问题见
[`WINDOWS_BUILD_GUIDE.md`](WINDOWS_BUILD_GUIDE.md)。后续 agent 应先阅读该文档，
再启动 Windows 长构建。

Windows packaging runs natively and does not use Docker or WSL. Visual Studio
2022 C++ build tools are the only system build prerequisite. The preparation
step downloads checksum-pinned archives, builds Garnet as a self-contained
Windows application, builds the WOFF command-line tools, and keeps every input
in the persistent cache:

```powershell
pnpm run prepare:windows
$env:PENPOT_SHARED_ARTIFACT_ROOT = "D:\artifacts\shared-artifacts-repro-a"
pnpm run assemble:windows
pnpm run package:windows
```

The NSIS package uses current-user install mode and embeds the verified
WebView2 offline installer. `package:windows` creates an unsigned engineering
installer by default and marks its provenance as not release-qualified. Set
`PENPOT_RELEASE_QUALIFY=1` only after Authenticode signing; the evidence step
then rejects a missing or invalid signature. It writes SHA-256 checksums,
license inventory, CycloneDX SBOM, and provenance under
`target/release-evidence/x86_64-pc-windows-msvc/`.

Run `acceptance/windows-clean-machine.ps1` on a clean Windows 11 x64 machine.
The harness installs without network access, runs the bundled compatibility
probe, checks Credential Manager and owner-only ACLs, watches all child TCP
connections for non-loopback traffic, tests upgrade/failure paths when given,
uninstalls, and confirms that user data remains.

Windows build tools that need prefix arguments can be supplied without a shell
through JSON arrays. For example, set `PENPOT_BUILD_CLOJURE_COMMAND` to a
PowerShell executable plus the arguments that import or run the Clojure module,
and set `PENPOT_BUILD_PNPM_COMMAND` to Node plus pnpm's JavaScript entry point.
The older `PENPOT_BUILD_CLOJURE` and `PENPOT_BUILD_PNPM` executable-only values
remain supported.
By default, Windows source builds use `invoke-clojure-windows.ps1`; it locates
one cached JDK and ClojureTools module under `desktop/.cache/toolchains/` and
normalizes the combined `-M:`, `-T:`, and `-X:` forms expected by the Unix CLI.
The adapter transports each argument in a Base64 envelope because PowerShell
splits combined Clojure aliases before a `-File` script receives them.

Source builds derive `BUILD_DATE`, `BUILD_TS`, and `SOURCE_DATE_EPOCH` from the
Git revision. Backend JAR entries use that fixed time, and compile-time font IDs
are deterministic. These rules allow two isolated builds on one host to produce
the same shared manifest and checksums.

The stage-one command-line compatibility gate lives in
[`compatibility/`](compatibility/README.md). Run it against each assembled
runtime and resolve failures during stage two; it does not block implementation.

The desktop build first builds Web to Penpot and copies its static files to
`ui/plugins/web-to-penpot/`. Install the plugin from the matching public origin
at `/plugins/web-to-penpot/manifest.json`. The generated directory is ignored;
release builds always replace it from the plugin source.

## Runtime integrity lock

An assembled runtime includes `runtime-lock.json`. It records each component's
version, source, license, target, build recipe, source-archive SHA-256, and a
complete inventory of bundled files and links. The desktop refuses to mark a
runtime ready when the lock is missing, incomplete, for another target, or the
runtime tree has changed.

Generate the lock only after assembly, from CI or an explicit developer
packaging command:

```bash
pnpm run build:runtime-lock
src-tauri/target/debug/penpot-runtime-lock \
  src-tauri/runtime-manifest.json \
  /absolute/path/to/component-metadata.json \
  aarch64-apple-darwin \
  /absolute/path/to/runtime/aarch64-apple-darwin \
  /absolute/path/to/runtime/aarch64-apple-darwin/runtime-lock.json
```

`component-metadata.json` uses this shape and must cover exactly the components
for its target:

```json
{
  "schemaVersion": 1,
  "target": "aarch64-apple-darwin",
  "components": [
    {
      "id": "postgres",
      "version": "15.x",
      "source": "https://approved.example/postgres.tar.gz",
      "license": "PostgreSQL",
      "buildRecipe": "desktop/packaging/build-postgres"
    }
  ],
  "sources": [
    {
      "id": "postgresql-source",
      "version": "15.x",
      "source": "https://approved.example/postgres.tar.gz",
      "license": "PostgreSQL",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "buildRecipe": "desktop/packaging/build-postgres"
    }
  ]
}
```

The example values are not release pins. Packaging must supply exact versions
and approved source URLs.

## Local service configuration

The desktop builds process specifications from the verified target manifest,
the private instance directories, assigned loopback ports, and secrets loaded
into memory. PostgreSQL, the cache, Media Processor, Backend, and Exporter use
absolute bundled paths and bind only to `127.0.0.1`. PostgreSQL has a separate
bundled `pg_ctl` shutdown command; the other services remain contained by the
platform process supervisor.

Secrets are inputs to this process model and are not part of `desktop.json`.
The desktop stores and reuses them through Keychain on macOS and Credential
Manager on Windows.
