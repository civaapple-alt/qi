# `@civaapple/qi-node/plugins`

Claude-compatible plugin marketplace adaptation (ADR-0037).

## Purpose

Register and sync Claude-style marketplaces (`marketplace.json`), install vendored plugins into a pinned
cache under `$QI_HOME/plugins`, enable them without granting authority, and expose:

- commands / skills → `/plugin:<id> <task>` (public slash activation)
- plugin Skills → model-facing `plugin_skill` Tool (`list`, `load`, `read-resource`, bounded `run-script`)
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
| P4 | Pinned URL sources, dual Superpowers marketplaces, plugin Skill snapshots | **done** |
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
qi marketplace add superpowers-marketplace https://github.com/obra/superpowers.git --ref 44c9b2d6e889982ac18c27d05a19fefe335194e1
qi marketplace search claude-plugins-official frontend
qi plugin install frontend-design@claude-plugins-official
qi plugin enable frontend-design@claude-plugins-official
qi plugin install superpowers@superpowers-marketplace
qi plugin enable superpowers@superpowers-marketplace
qi plugin commands
qi agent list
```

The official Anthropic catalog and Superpowers' self marketplace are both supported. A plugin may be
installed from both, but only one marketplace source for the same plugin name may be enabled at a time;
disable the current source before enabling the other. Superpowers is accepted only at the pinned repository
commit/version and injects its `using-superpowers` bootstrap as required, untrusted user context. Its visual
companion server, hooks, lifecycle commands, and dependency installers remain unavailable.

### Using Superpowers

`plugin install` only places the immutable plugin in the private cache; it does not enable the plugin. Enable
exactly one Superpowers source, then restart the Qi process so the new Run snapshots and capability leases are
created from the updated enablement state:

```bash
qi plugin enable superpowers@superpowers-marketplace
```

The explicit slash entry requires a task and activates the pinned `using-superpowers` instructions for that Run:

```text
/plugin:superpowers:using-superpowers implement the requested feature and verify it
```

For ordinary prompts, an enabled canonical Superpowers plugin automatically contributes its bootstrap. The model
progressively loads individual Skills through the read-only `plugin_skill` Tool, for example with
`operation = "load"`, `pluginKey = "superpowers@superpowers-marketplace"`, and `skill = "using-superpowers"`.
`plugin_skill` discovery/loading does not grant Workspace or host authority; plugin scripts require the separate
Execute capability and remain bounded by the normal Tool and Effect Journal checks.

## Invariants

- Enable never grants a Capability Lease and never auto-binds MCP.
- `/plugin:` and `/agent:` inject untrusted procedural context (same class as Skills).
- Catalog entries must surface `supported | partial | unsupported`.
- Enablement and plugin Skill discovery are pinned per Run; marketplace changes do not mutate an active Run.

## Evidence

`tests/plugins-marketplace.test.mjs`
