# `@civaapple/qi-node/plugins`

Claude-compatible plugin marketplace adaptation (ADR-0037).

## Purpose

Register and sync Claude-style marketplaces (`marketplace.json`), install complete plugins into a pinned
cache under `$QI_HOME/plugins`, then separately enable the plugin; model-invocable Skills become available with the
plugin while user-only Skills remain explicitly selectable, without granting authority. Qi exposes:

- commands → `/plugin:<marketplace>:<plugin>:<command> <task>`
- user-invocable plugin Skills → `/skill:<marketplace>:<plugin>:<skill> <task>`
- model-invocable plugin Skills → model-facing `skill` Tool (combined list with native Skills; load via short name or `pluginKey`) and dedicated `plugin_skill` Tool for explicit `pluginKey` workflows
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
qi marketplace add mattpocock https://github.com/mattpocock/skills
qi marketplace add superpowers-marketplace https://github.com/obra/superpowers.git
qi marketplace sync superpowers-marketplace
qi marketplace search claude-plugins-official frontend
qi plugin install frontend-design@claude-plugins-official
qi plugin enable frontend-design@claude-plugins-official
qi skill enable claude-plugins-official:frontend-design:frontend-design
qi plugin install superpowers@superpowers-marketplace
qi plugin enable superpowers@superpowers-marketplace
qi plugin commands
qi agent list
```

Marketplace registration is separate from plugin installation and enablement. The GitHub source accepts
`github:owner/repo`, `owner/repo`, or a full `https://github.com/owner/repo` URL (an optional `.git` suffix is
allowed); local sources use `local:<path>`. The TUI exposes the same flow under `/plugins` → **Manage**:
add a source (GitHub or local clone), then **Sync catalog** / enable/disable / browse. After browsing, install
and enable plugins separately. Enter on a registered source opens maintenance actions including **Sync catalog**
(GitHub fetch, same as `qi marketplace sync <name>`). Sync updates the catalog only; re-install a plugin to
refresh its pinned cache. Disabling a marketplace disables its enabled plugins but retains installed caches.
`/plugins` **All** / **Installed** and per-marketplace tabs only include **enabled** sources; caches from a
disabled marketplace stay hidden until that source is re-enabled under Manage.

The two Claude manifests have different responsibilities. Qi reads the marketplace root's
`.claude-plugin/marketplace.json` only to discover plugin names, descriptions, and `source` roots. After a plugin
is installed, Qi resolves that source root and reads the plugin's own `.claude-plugin/plugin.json`; its `skills`
array is authoritative for Skill discovery (including nested paths such as `./skills/engineering/ask-matt`).
Extra `skills/**/SKILL.md` files that are not listed in `plugin.json` are not exposed by `/skills`, `/skill:`, or
`plugin_skill`. For older plugins without a `skills` array, Qi retains a directory-scan compatibility fallback.

Plugin Skill **ids** always use the Skill **directory** basename
(`marketplace:plugin:dir`). Frontmatter `name` (when different, e.g. dir `taste-skill` with
`name: design-taste-frontend`) is exposed as `declaredName`. In `/skills` marketplace tabs the
compact row is `[*] dir → md-name` plus `both|user|model · description` (marketplace is the tab);
full directory / SKILL.md / invocation detail remains on Enter.

Human `/skill:` prefers a **short unique selector**: `/skill:taste-skill` when only one enabled Skill
has that directory name; otherwise `marketplace:name` or the full `marketplace:plugin:dir` id.
Resolution accepts short name, `marketplace:name`, declared frontmatter name, or full id.

The official Anthropic catalog and Superpowers' self marketplace are both supported. A plugin may be
installed from both, but only one marketplace source for the same plugin name may be enabled at a time;
disable the current source before enabling the other. When an enabled plugin is named `superpowers`, Qi injects
the `using-superpowers` bootstrap as untrusted user context after structural checks
(`.claude-plugin/plugin.json` name + `skills/using-superpowers/SKILL.md`). Commit/version are not pinned, so
`qi marketplace sync` / re-install can refresh the plugin; bootstrap still maps workflows to Qi Tools. Visual
companion server, hooks, lifecycle commands, and dependency installers remain unavailable.

### Using Superpowers

`plugin install` only places the immutable plugin in the private cache; it does not enable the plugin. After the
plugin is enabled, model-invocable Skills (those without `disable-model-invocation: true`) are available to
`plugin_skill` automatically. User-only Skills still require selection in `/skills` or with `qi skill enable`.
Space can explicitly disable an otherwise model-invocable Skill; that opt-out is stored with the plugin pin.
Changes apply to the next Run without changing an active Run snapshot.

The local checkout can be registered as its own marketplace:

```bash
qi marketplace add superpowers-marketplace local:D:/gh-ws/skill-ws/superpowers
qi plugin install superpowers@superpowers-marketplace
qi plugin enable superpowers@superpowers-marketplace
```

This repository's `marketplace.json` declares the `superpowers` plugin, while its `plugin.json` has no `skills`
array; Qi therefore discovers the Skill directories under `skills/` using the compatibility fallback. The
`using-superpowers` Skill is the bootstrap Skill: when the plugin is enabled and the structural path checks pass,
Qi injects that Skill automatically for ordinary prompts. Local checkouts and post-sync revisions are eligible as
long as `plugin.json` names `superpowers` and `skills/using-superpowers/SKILL.md` loads. A missing or misnamed
bootstrap Skill fails closed when Superpowers is enabled.

The explicit Skill entry requires a task and activates the `using-superpowers` instructions for that Run:

```text
/skill:superpowers-marketplace:superpowers:using-superpowers implement the requested feature and verify it
```

For ordinary prompts, an enabled Superpowers plugin that passes structural checks automatically contributes its bootstrap. The model
progressively loads individual Skills through the model-facing `skill` Tool (combined list; load with short name
or `pluginKey`) or the dedicated `plugin_skill` Tool with `pluginKey` / `skill`. Neither path grants Workspace or
host authority; plugin scripts require the separate Execute capability and remain bounded by the normal Tool and
Effect Journal checks.

### Troubleshooting `skill` / `plugin_skill` denied for marketplace Skills

If the model can see plugin Skills in `skill` list (or via `plugin_skill`) but an invocation is denied, check the
runtime state rather than changing the Skill prompt:

1. `qi plugin list --json` must contain the exact enabled key, for example
   `superpowers@superpowers-marketplace` with `enabled: true`.
2. `qi plugin install` and `qi plugin enable` are separate operations; `qi skill enable` is only required for
   user-only Skills or for re-enabling a model Skill that was explicitly disabled.
3. A Skill marked `user-only` by `disable-model-invocation: true` is intentionally absent from model `skill` /
   `plugin_skill` lists; activate it through a human `/skill:` Run instead.
4. For `run-script`, also enable the separate Execute capability; read-only `list`, `load`, and `read-resource`
   do not require it.

Only the enabled marketplace copy contributes Skills to the model catalog; installing the same plugin from a
second marketplace does not make both copies active.

## Invariants

- Enable never grants a Capability Lease and never auto-binds MCP.
- `/plugin:`, `/skill:`, and `/agent:` inject untrusted procedural context (same class as Skills).
- Catalog entries must surface `supported | partial | unsupported`.
- Enablement and plugin Skill discovery are pinned per Run; marketplace changes do not mutate an active Run.

## Evidence

`tests/plugins-marketplace.test.mjs`
