# Penpot Desktop

This module packages Penpot as a self-contained desktop application for macOS
and Windows. The installed application must not download runtime dependencies.

The Rust application owns the local runtime, process lifecycle, HTTPS gateway,
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

The desktop build first builds Web to Penpot and copies its static files to
`ui/plugins/web-to-penpot/`. Install the plugin from the matching public origin
at `/plugins/web-to-penpot/manifest.json`. The generated directory is ignored;
release builds always replace it from the plugin source.
