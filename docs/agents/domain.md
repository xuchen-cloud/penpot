# Domain Docs

This repository is a local deployment and localization fork of the upstream Penpot project.

Its domain docs use a multi-context layout, but context boundaries follow the local changes maintained in this fork. They do not mirror every upstream Penpot module.

## Scope

The main local contexts are:

- Deployment, packaging, runtime configuration, and desktop delivery.
- Language translation and localization.
- Project-specific assets, integrations, and small extensions.

Treat Penpot's existing code, documentation, and terminology as the baseline for untouched core product behavior. Do not create replacement domain models for upstream modules that this fork does not change.

If work would alter Penpot's core business rules or concepts, state that change clearly. Do not classify it as a deployment or localization change.

## Before exploring, read these

- Read `CONTEXT-MAP.md` at the repository root when it exists.
- From the map, read each `CONTEXT.md` relevant to the task.
- Read relevant system-wide ADRs under `docs/adr/`.
- Read context-specific ADRs referenced by the map or stored near the affected context.

If a file does not exist, proceed silently. Do not create it only to fill the layout. The domain-modeling workflow creates context files and ADRs when the team resolves terms or decisions that need a durable record.

## File structure

```text
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/                       # Decisions that affect the whole fork
├── docker/
│   ├── CONTEXT.md                 # When deployment terms need documentation
│   └── docs/adr/                  # Deployment-specific decisions
├── desktop/
│   ├── CONTEXT.md                 # When desktop packaging needs its own context
│   └── docs/adr/
└── frontend/
    └── translations/
        ├── CONTEXT.md             # When localization terms need documentation
        └── docs/adr/
```

These paths are examples based on the current repository. `CONTEXT-MAP.md` is the source of truth once context docs exist. Add a context only when the fork owns meaningful rules or terms for that area.

Project-specific assets or extensions should keep their context docs near their existing code. Do not move code merely to match this example.

## Preserve upstream vocabulary

Use Penpot's existing terms for core product concepts. A local context may add deployment, localization, or extension terms, but it should not rename upstream concepts without an explicit decision.

When a needed term is absent, first check whether Penpot already defines it. If the term is specific to this fork, record it through the domain-modeling workflow.

## Flag ADR conflicts

If a proposed change conflicts with an existing ADR or an upstream invariant, state the conflict instead of silently replacing the earlier decision.
