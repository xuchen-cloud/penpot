# Penpot Desktop implementation roadmap

## Product boundary

Penpot Desktop is a new offline distribution of Penpot for macOS 14 or newer
on Apple Silicon and Windows 11 on x86-64. It uses Tauri 2 and native processes.
The target computer must not need Docker, Kubernetes, WSL, Java, Node.js, a
database installation, or any runtime download.

The installed application contains PostgreSQL 15, a JRE, Node.js, Playwright's
matching Chromium, media tools, and the built Penpot applications. macOS uses
Valkey. Windows uses Garnet after its compatibility suite passes.

The first release does not support Intel Macs, Windows 10, Linux installers,
high availability, migration of an existing Docker database, automatic online
updates, or third-party identity and mail services. It supports `.penpot` file
import and export as the data interchange path.

## Runtime topology

All private services bind to loopback. The public gateway is the only entry
point and defaults to local-only access.

```text
Tauri shell and Rust supervisor
  |-- gateway and static frontend
  |-- PostgreSQL 15
  |-- Valkey (macOS) or Garnet (Windows)
  |-- media processor
  |-- JVM backend
  `-- Node exporter and bundled Chromium
```

The supervisor starts dependencies in manifest order, writes separate service
logs, rolls back a partial start, and stops complete process trees. macOS uses
process groups. Windows uses a Job Object with `KILL_ON_JOB_CLOSE`.

## Delivery stages

### 1. Cross-platform compatibility gate — incomplete

Build a command-line prototype with no installer UI and run it natively on
both release targets before continuing the full local-stack implementation:

- Initialize PostgreSQL, run all backend migrations, stop it cleanly, and
  start it again with the same data.
- Start Valkey on macOS and run the full Garnet compatibility suite on Windows.
  The Windows suite must cover strings, hashes, scan, Pub/Sub, blocking lists,
  `EVAL`/`EVALSHA`, Penpot rate-limit scripts, and exporter queue behavior.
- Start the backend, exporter, and media processor from the proposed bundled
  runtimes and prove that Playwright Chromium starts without a network.
- Export PNG, JPEG, WebP, SVG, and PDF files.
- Upload and convert TTF, OTF, WOFF, and WOFF2 fonts.

Record the native executable versions and test results for macOS arm64 and
Windows x64. If Garnet fails the queue or Lua checks, evaluate a maintained
Windows-compatible Valkey build instead; do not rewrite the Penpot queue.

The following runtime foundation landed early and supports the prototype, but
does not complete this gate:

- Tauri workspace, configuration, tray, and application-data layout.
- Runtime manifest validation for both release targets.
- Loopback port reservation and static gateway health endpoint.
- Process supervision, log capture, rollback, and process-tree containment.
- First administrator email capture without persisting credentials in the
  ordinary desktop configuration.
- A native macOS and Windows Rust CI workflow.

### 2. Bootable local stack — blocked by stage 1

- Pin and assemble every runtime archive with SHA-256 verification.
- Record component version, source, license, target, checksum, and build recipe
  in a machine-readable bill of materials. CI is the only place allowed to
  download runtime archives; installation and startup must work without a
  network connection.
- Initialize PostgreSQL without a system installation.
- Configure PostgreSQL with an explicit bundled `pg_ctl` shutdown command so
  normal application exit does not rely on terminating its process tree.
- Run the existing backend migrations on first start and every compatible
  upgrade. Prove that a cold database migrates successfully and that rerunning
  startup against an up-to-date database is safe.
- Store the database password, cache password, Penpot secret, and local
  management key in the operating-system credential store. Persist only
  non-secret identifiers in `desktop.json`.
- Create the documented data layout under
  `~/Library/Application Support/Penpot Desktop` on macOS and
  `%LOCALAPPDATA%\xuchen-cloud\Penpot Desktop` on Windows. Apply owner-only
  permissions or ACLs and keep all persistent data outside the signed,
  read-only application directory.
- Generate process arguments and environment from desktop configuration.
- Reserve internal ports on loopback, detect public-port conflicts before
  startup, and never expose an internal service on a wildcard address. Avoid a
  check-then-bind race wherever a child process can accept an inherited socket;
  otherwise retry from a bounded port allocation loop.
- Add readiness probes, bounded restart policy, and diagnostic reporting.
- Add an exclusive per-user instance lock before database initialization or
  service startup. A second launch must focus the existing window instead of
  starting a second database.
- Proxy backend, WebSocket, asset, and exporter routes through the Rust gateway.
- Replace `X-Accel-Redirect` with a path-normalized asset response confined to
  the configured asset root, including range and cache behavior.
- Serve generated frontend configuration without changing signed resources.
- Generate the local certificate material and start the gateway at
  `https://localhost:9001`. Keep its private key in the operating-system
  credential store. The desktop WebView must trust only this installation's
  certificate without weakening TLS validation for other origins.
- Show Penpot only after all required probes pass. On failure, identify the
  component, keep its redacted logs, and offer retry, open-log-folder, and safe
  shutdown actions.

Do not start the full stage 2 implementation until stage 1 passes on both
targets. Stage 2 is complete only when both target platforms can initialize,
start, stop, and restart the full stack from bundled artifacts while
disconnected. Invitation and LAN tests remain gates in later stages, but their
required executables must already be present in the bundle.

### 3. Offline product behavior

- Finish the one-time administrator registration flow.
- Pass the configured first-user email through the existing `PENPOT_ADMINS`
  mechanism (or an equivalent explicit administrator role) and test that the
  first user receives administrator permissions while invited users do not.
- Keep public registration disabled while accepting valid pending invitations.
- Disable telemetry and all optional public-network integrations in standalone
  mode, and reject conflicting settings in the backend.
- Permit a user-entered external URL as an explicit action, with a short
  timeout and a clear offline error; do not let it weaken the default no-
  background-network policy.
- Bundle templates, fonts, plugins, and help content; remove runtime fallbacks to
  public URLs.
- Restrict desktop navigation and exporter browser requests to approved local
  origins.

### 4. Data safety, LAN access, and upgrades

- Add clean crash recovery metadata around the stage 2 instance lock and make
  upgrades take the same exclusive lock.
- Create consistent PostgreSQL and asset backups before each upgrade.
- Verify backup manifests and provide restore tooling.
- Accept signed full offline upgrade packages; never update individual runtime
  parts in place.
- Keep user data on uninstall unless the user explicitly chooses removal.
- Retain the three most recent verified upgrade backups and check free disk
  space before copying data or running a migration.
- Extend the local CA only when LAN access is enabled, issue certificates for a
  selected concrete address, export the public certificate, and remove the
  Windows private-network firewall rule when LAN access is disabled. An IP
  change must require explicit certificate regeneration and restart; it must
  not broaden the bind address automatically.

### 5. Release qualification

- Build, sign, and notarize a macOS DMG and sign a Windows NSIS installer.
- Keep the application identifier and Windows upgrade GUID stable. Version
  releases as `<penpot-version>-desktop.<revision>`.
- Generate the dependency license report, SBOM, installer checksums, and build
  provenance beside each release artifact.
- Test fresh offline install, first admin, restart persistence, invitation flow,
  image and font upload, `.penpot` import/export, and all export formats.
- Open a built-in template without network access and verify two-window editing
  over WebSocket before qualifying either platform.
- Test window close-to-tray behavior separately from full application exit, and
  prove that full exit leaves no child process behind.
- In LAN mode, expose only the gateway. Install the exported local CA on a
  second device, accept an invitation there, and verify collaborative editing.
- Reject expired, revoked, and email-mismatched invitations in the offline
  end-to-end suite.
- Run the Garnet Redis-compatibility suite on Windows.
- Capture DNS and TCP attempts during the offline end-to-end suite and fail on
  unexpected public-network access.
- Test port conflicts, low disk space, database startup failure, abrupt process
  termination, a second application launch, migration failure, restore, and
  uninstall/reinstall data retention.

## Release gate

The project is not ready for end users until stages 2 through 5 pass on clean,
disconnected machines. A successful source build alone does not prove offline
installation: CI must assemble and test the complete signed installers.

Release signing needs external inputs that cannot live in the repository:
Apple Developer ID and notarization credentials, a Windows code-signing
certificate, the permanent Windows upgrade GUID, and an approved publisher
name. Unsigned development artifacts may be used for engineering tests but do
not satisfy the release gate.
