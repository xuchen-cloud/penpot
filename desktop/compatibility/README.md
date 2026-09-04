# Desktop native compatibility gate

This directory contains the stage-one command-line prototype. It has no Tauri
or installer UI. It starts only executables from an assembled runtime and writes
a JSON report with each command, duration, result, and failure.

Passing Rust tests does not pass this gate. Keep stage two blocked until reports
from both `aarch64-apple-darwin` and `x86_64-pc-windows-msvc` have `passed: true`.

## Runtime inputs

Assemble the runtime outside the target computer, then run
`prepare-runtime.mjs` while still in CI or the developer packaging environment:

```bash
node desktop/compatibility/prepare-runtime.mjs /absolute/path/to/runtime
```

This copies the protocol driver and the checked-in TTF, WOFF, and WOFF2 test
fonts, then uses the bundled FontForge to make the OTF test font. The runtime
must pass `desktop/src-tauri/runtime-manifest.json`; the CLI does not download or
search for missing files.

Before a native run, put five export request files in `<work>/fixtures`:

```text
export-png.json
export-jpeg.json
export-webp.json
export-svg.json
export-pdf.json
```

Each file describes a real Exporter request made against a fixture project in
the local Backend:

```json
{
  "path": "/api/export",
  "method": "POST",
  "headers": {
    "content-type": "application/json",
    "cookie": "auth-token=<fixture-session>"
  },
  "body": {},
  "artifactUrlField": "uri",
  "artifactBaseUrl": "http://127.0.0.1:<backend-port>",
  "artifactHeaders": {
    "cookie": "auth-token=<fixture-session>"
  }
}
```

The fixture setup must replace the example values with a valid local session,
file, page, and object IDs and set the body type for that file. Do not use a
mock Exporter response: the output signature checks prove that the five real
artifacts came back. Keep credentials limited to the disposable work directory
and remove that directory after collecting the report.

## Native run

Build the CLI on the target host, disconnect public network access, and run the
matching plan:

```bash
cd desktop
pnpm run build:compat
src-tauri/target/debug/penpot-desktop-compat \
  compatibility/plans/aarch64-apple-darwin.json \
  /absolute/path/to/runtime \
  /absolute/path/to/disposable-work \
  /absolute/path/to/report.json
```

On Windows, use `penpot-desktop-compat.exe` and the
`x86_64-pc-windows-msvc.json` plan. Use a new work directory for each run because
`initdb` rejects an existing database directory.

The plans record PostgreSQL, cache, Java, Node.js, and Chromium versions. They
then check:

- PostgreSQL initialization, Backend migrations, clean `pg_ctl` stop, restart,
  and persisted data;
- strings, hashes, scan, Pub/Sub, blocking lists, `EVAL`, `EVALSHA`, both Penpot
  rate-limit scripts, and Penpot's `RPUSH`/`BLPOP` worker hand-off;
- Media Processor, Backend, Exporter, and local-only Chromium startup;
- PNG, JPEG, WebP, SVG, and PDF artifacts;
- TTF, OTF, WOFF, and WOFF2 uploads with a real conversion for each source.

Garnet starts with `--lua`. If its report fails `cache.compatibility`, preserve
the report and cache log, then test a maintained Windows Valkey build with the
same plan and checks. Do not change Penpot's queue behavior to fit Garnet.
For a focused cache rerun against an already running server, use:

```bash
src-tauri/target/debug/penpot-desktop-compat cache 127.0.0.1 6379
```

## Report handling

Keep the two JSON reports with the runtime checksums used for each run. A failed
step stops the plan, stops remaining child processes, and leaves service logs in
`<work>/logs`. The report contains no command environment, which keeps the
disposable fixture session and shared keys out of it.
