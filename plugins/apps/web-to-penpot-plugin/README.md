# Web to Penpot

Imports Copy to Design H2D v1 clipboard data into Penpot 2.17 as editable
shapes. The plugin works offline: it only accepts assets embedded in the
clipboard payload and never fetches the source page.

## Development

From the `plugins` directory:

```bash
pnpm install
pnpm --filter web-to-penpot-plugin dev
```

Install `http://localhost:4302/manifest.json` from Penpot's plugin manager after
starting `pnpm --filter web-to-penpot-plugin preview`.

## Offline distribution

Build a static directory and ZIP:

```bash
pnpm --filter web-to-penpot-plugin package
```

Copy the static build into a prepared Penpot desktop web root:

```bash
pnpm --filter web-to-penpot-plugin copy:offline -- \
  /absolute/web-root/plugins/web-to-penpot
```

Users install it once with the same-origin URL:

```text
${PENPOT_PUBLIC_URI}/plugins/web-to-penpot/manifest.json
```

Serve `manifest.json`, `plugin.js`, and `index.html` with `Cache-Control:
no-cache`. Hashed assets under `assets/` may use immutable caching. Upgrades
replace only this static directory and do not change Penpot data or start a
service.

Copy to Design is not included or redistributed. This project implements an
independent reader for its clipboard envelope.
