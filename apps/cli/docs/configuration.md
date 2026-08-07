# Configuration

Qi uses layered TOML configuration. Secrets never appear in TOML; provider API keys are sealed under
`$QI_HOME` or supplied via environment variables.

## Resolution order

```text
CLI flags  >  project policy.toml  >  user config.toml  >  built-in defaults
```

| Layer | Path | Typical contents |
| --- | --- | --- |
| CLI flags | `qi --permission yolo --allow-write …` | Permission mode, one-shot capability and launch overrides |
| Project policy | `$QI_HOME/projects/<workspace-name>-<hash>/policy.toml` | `[permission]`, `[sandbox]`, mounts, approvals, expert capabilities, sensitive-path grants |
| User config | `$QI_HOME/config.toml` (or `QI_CONFIG` / `--config`) | Language, theme, provider routing, shell, memory, delegate, `[permission].default` |
| Built-ins | code | Permission **manual** + sandbox **auto**; coding lease pack when mode expands |

`QI_HOME` defaults to `%USERPROFILE%\.qi` on Windows and `~/.qi` elsewhere.

## Inspect and validate

```bash
# Effective config (secrets omitted)
qi config show
qi config show --workspace PATH --json

# Parse/validate user + project TOML
qi config validate
qi config validate --config PATH

# Non-interactive diagnostics (exit 1 when issues remain)
qi config doctor
qi config doctor --json
```

In the TUI:

| Slash | Role |
| --- | --- |
| `/about` | Version, platform, auth, paths |
| `/doctor` | Config + auth + capability + discovery checks |
| `/settings` | Interactive hubs (mode, **permission**, shell, model, …) |
| `/permission` | Daily Manual / YOLO / Auto (ADR-0040) |
| `/permissions` / `/shell` / `/model` | Expert caps multi-select; shell; model — live apply + optional persist |

## User config keys (`$QI_HOME/config.toml`)

```toml
version = 1
language = "zh"          # zh | en
theme = "auto"           # dark | light | auto
provider = "openai"
model = "gpt-5.4-mini"
# base_url = "https://…"
# account_alias = "default"
# reasoning_effort = "high"
# context_window_tokens = 128000
# output_reserve_tokens = 16000
# image_input = false
# max_steps = 40
# max_actions_per_step = 8

[ui]
timeline_density = "standard"   # compact | standard | diagnostic

# ADR-0040: default permission mode for new projects / when project omits [permission]
[permission]
default = "manual"       # manual | yolo | auto

# ADR-0041: graded process sandbox (optional user default; project may override)
[sandbox]
policy = "auto"          # auto | srt | low-il | never

# Expert / legacy overrides. When omitted, permission mode expands the coding lease pack.
[capabilities]
# write = true
# verify = true
# …

[shell]
default = "direct"
allowed = ["direct", "pwsh", "cmd", "bash"]

[memory]
enabled = true
auto_accept_project = true

[delegate]
wall_time_ms = 300000
max_steps_percent = 50
context_tokens_percent = 50

[tools]
qi_session_inspect = false
```

### Hot vs restart

| Setting | Apply without full process restart |
| --- | --- |
| Permission mode (`/permission`) | Yes (Session + project `[permission].mode`) |
| Capabilities (`/permissions`) | Yes (Session + project policy; expert path) |
| Shell profiles (`/shell`) | Yes (user config) |
| maxSteps / maxActionsPerStep / delegate | Yes via panels |
| Language / theme / density | Yes via `/settings` |
| Provider routing after `/login` or `/model` | Yes for Session; user default optional |
| External TOML edits on disk | Take effect on launch / in-process Session relaunch |
| Sandbox backend | Launch-time resolve (smoke cached for process lifetime) |

## Project policy

Project `policy.toml` may set:

```toml
version = 1
max_steps = 40

[permission]
mode = "yolo"            # manual | yolo | auto

[sandbox]
policy = "auto"          # auto | srt | low-il | never

# Optional expert override when you need a non-pack capability table:
# [capabilities]
# write = true
# execute = true

[[mounts]]
id = "docs"
path = "D:/reference/docs"
mode = "read"

# Manual approval memory (ADR-0040)
# [[approvals]]
# pattern = "tool:write;effect:write;resource:workspace:file:src/**"
# decision = "allow"
# created_at = "2026-08-07T12:00:00Z"
```

**Shell profiles are user-global only**; project `[shell]` is ignored for authority (ADR-0015).
Mount adds choose **This Session only** vs **Remember for project** in the TUI.

Workspace `.qi/` holds declarations and locks only — never capability authority.

Inspect OS sandbox:

```bash
qi sandbox status
qi sandbox status --json
```

## Environment variables

| Variable | Role |
| --- | --- |
| `QI_HOME` | Machine-private state root |
| `QI_CONFIG` | Override user config.toml path |
| Provider keys (`OPENAI_API_KEY`, `ARK_API_KEY`, …) | Credential source when not sealed via `/login` |
| `NO_COLOR` | Disable ANSI color |

## Headless and print mode

Print mode reuses the same config layers. Writes still need `--allow-write` (or policy), not a silent
`--force`. See [headless.md](headless.md).

## Invalid config

Invalid TOML fails closed with a path and reason (no silent default swap). Fix the file or pass
`--no-config` for a disposable launch without user/project TOML.
