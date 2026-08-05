# `@civaapple/qi-node/plugins`

Claude-compatible plugin marketplace adaptation (ADR-0037).

## Purpose

Register and sync Claude-style marketplaces (`marketplace.json`), install vendored plugins into a pinned
cache under `$QI_HOME/plugins`, enable them without granting authority, and expose:

- commands / skills → `/plugin:<id> <task>`
- root agents → `/agent:<id> <task>`
- `.mcp.json` → inert MCP declarations under `$QI_HOME/resources/mcp/<marketplace>/`
  (discovered as `name@marketplace`; still require human refresh/bind)

## Progress (claude-plugins-official)

| Phase | Scenario | Status |
|--|--|--|
| P0 | Marketplace register / sync / search | **done** |
| P1 | Vendored skills + commands → `/plugin:` | **done** |
| P2 | `.mcp.json` → MCP declarations (no auto-bind) | **done** |
| P3 | Vendored agents → `/agent:` | **done** (profile activation; child lease still Runtime-owned) |
| P4 | Remote `git-subdir` / `url` / `github` / skill-bundles | **not started** |
| — | Hooks / LSP / Workflow ACL | **won't adapt** |

## Unsupported (whole plugin)

- All `*-lsp` plugins
- `explanatory-output-style`, `learning-output-style`, `security-guidance` (hooks-only)

## Partial

- `claude-security`, `hookify`, `ralph-loop`: supported components adapt; hooks ignored (`partial`)

## CLI

```bash
qi marketplace add claude-plugins-official local:D:/path/to/claude-plugins-official
qi marketplace add claude-plugins-official github:anthropics/claude-plugins-official
qi marketplace search claude-plugins-official frontend
qi plugin install claude-plugins-official frontend-design
qi plugin enable frontend-design@claude-plugins-official
qi plugin commands
qi agent list
```

## Invariants

- Enable never grants a Capability Lease and never auto-binds MCP.
- `/plugin:` and `/agent:` inject untrusted procedural context (same class as Skills).
- Catalog entries must surface `supported | partial | unsupported`.

## Evidence

`tests/plugins-marketplace.test.mjs`
