# Penpot Desktop

This module packages Penpot as a self-contained desktop application for macOS
and Windows. The installed application must not download runtime dependencies.

The Rust application owns the local runtime, process lifecycle, HTTPS gateway,
backup flow, and desktop UI. Penpot services stay isolated on loopback ports.

## Development

```bash
pnpm install
pnpm run test:rust
pnpm run dev
```

The runtime binaries are not stored in Git. Release jobs assemble the pinned
runtime under `src-tauri/resources/runtime/<target-triple>/` before packaging.
The checked-in runtime manifest defines the required files for each target.
