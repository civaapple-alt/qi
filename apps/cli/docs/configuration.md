# Configuration

Qi uses layered TOML configuration. Secrets never appear in TOML; provider API keys are sealed under
`$QI_HOME` or supplied via environment variables.

## Resolution order

```text
CLI flags  >  project policy.toml  >  user config.toml  >  built-in defaults
```

| Layer | Path | Typical contents |
| --- | --- | --- |
| CLI flags | `qi --allow-write --max-steps …` | One-shot capability and launch overrides |
| Project policy | `$QI_HOME/projects/<workspace-name>-<hash>/policy.toml` | Capabilities, mounts, maxSteps, sensitive-path grants |
| User config | `$QI_HOME/config.toml` (or `QI_CONFIG` / `--config`) | Language, theme, provider routing, shell, memory, delegate, maxSteps |
| Built-ins | code | Safe defaults (optional capabilities off) |

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
| `/settings` | Interactive hubs (mode, permissions, shell, model, …) |
| `/permissions` / `/shell` / `/model` | Live apply + optional persist |

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

[capabilities]
write = false
verify = false
network = false
execute = false
background = false
delegate = false
publish = false
spend = false

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
| Capabilities (`/permissions`) | Yes (Session + project policy) |
| Shell profiles (`/shell`) | Yes (user config) |
| maxSteps / maxActionsPerStep / delegate | Yes via panels |
| Language / theme / density | Yes via `/settings` |
| Provider routing after `/login` or `/model` | Yes for Session; user default optional |
| External TOML edits on disk | Take effect on launch / in-process Session relaunch |

## Project policy

Project `policy.toml` may set `max_steps`, `[capabilities]`, `[mounts]`, sensitive-path grants. **Shell
profiles are user-global only**; project `[shell]` is ignored for authority (ADR-0015).

Workspace `.qi/` holds declarations and locks only — never capability authority.

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
