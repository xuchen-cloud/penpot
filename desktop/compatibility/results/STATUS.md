# Native gate status

Last updated: 2026-09-05

Neither release target has passed the full compatibility check. These reports
are deferred until the matching stage-two runtime can be assembled; they no
longer block implementation.

## macOS arm64

Host used for the first protocol smoke: macOS 27.0 arm64.

| Item | Version or result | Gate status |
| --- | --- | --- |
| Compatibility CLI | Rust 1.94.1, host `aarch64-apple-darwin` | 31 Rust tests passed; non-gating |
| PostgreSQL | Homebrew 15.19 | Not run as a bundled runtime |
| Valkey | Homebrew 9.1.2 | All ten cache checks passed twice; non-gating |
| Node.js | System 22.18.0 | Not run as a bundled runtime |
| Java | Installed JDK is the wrong CPU type | Blocked pending bundled JRE |
| Backend, Exporter, Media Processor, Chromium | No assembled runtime present | Not run |
| PNG, JPEG, WebP, SVG, PDF | No local export fixture/runtime present | Not run |
| TTF, OTF, WOFF, WOFF2 | No assembled media runtime present | Not run |

The Valkey smoke covered strings, hashes, scan, Pub/Sub, blocking lists,
`EVAL`, `EVALSHA`, both checked-in Penpot rate-limit scripts, and the
`RPUSH`/`BLPOP` worker hand-off. It used a system Valkey only to verify the new
protocol client; it does not count as the native bundled-runtime result.

## Windows x64

No Windows 11 x64 host or assembled runtime was available in this worktree.
All native checks, including Garnet with Lua enabled, remain pending.

## Tooling blockers on the current host

Exporter formatting passed. Exporter lint and its focused CLJS test could not
start because this host lacks `clj-kondo` and `clojure`. The existing desktop
CI installs its build tools and will compile the new code on both native target
runners after the branch is pushed by the user.
