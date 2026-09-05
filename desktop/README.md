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
