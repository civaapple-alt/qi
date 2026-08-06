# Headless / print mode

Qi supports a Cursor-style one-shot print mode for scripts and CI. The process starts a Session (or resumes
`--session`), runs a single user prompt, projects the outcome to stdout, and exits.

Interactive TUI remains the default when stdin/stdout are TTYs and `-p` is not set.

## Usage

```bash
# Final assistant text only (default format)
qi -p "What does this workspace do?"
qi --print --prompt "Summarize README.md"

# Structured result for jq
qi -p --output-format json "List the main packages"

# NDJSON progress stream
qi -p --output-format stream-json "Review src/"
qi -p --output-format stream-json --stream-partial-output "…"

# Workspace, mode, session, capabilities
qi -p --workspace /path/to/project --mode ask "Explain the architecture"
qi -p --session ses_… "Continue from the prior Session"
qi -p --allow-write --allow-execute "Add a unit test for foo"
```

### Workspace and prompt

| Mode | Workspace | Prompt |
| --- | --- | --- |
| Interactive | positional path or `--workspace` or cwd | typed in TUI / line mode |
| Print (`-p`) | `--workspace` or cwd only | remaining args and/or `--prompt` |

Print mode never treats a bare positional path as the Workspace. Pass `--workspace` when the cwd is wrong.

### Writes and safety

Qi does **not** implement Cursor’s `--force` / yolo flag. Non-read effects still require capability grants:

- CLI: `--allow-write`, `--allow-execute`, `--allow-network`, …
- or project `$QI_HOME/projects/…/policy.toml` / user config

`--safe` disables all optional capabilities. Path grants, Plan review, and `ask_question` **fail closed** in
print mode (they park or fail the Run); they are not auto-approved.

Indeterminate effects are never retried automatically.

## Output formats

### `text` (default)

Only the final assistant message text, plus a trailing newline when non-empty. No tool cards or banners.

### `json`

One JSON object after the Run settles:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 1234,
  "result": "<assistant text>",
  "session_id": "ses_…",
  "run_id": "run_…",
  "status": "completed",
  "model": "…",
  "provider": "…",
  "mode": "ask"
}
```

`subtype` / `status` preserve Qi outcomes: `completed` → `success`; `failed`, `cancelled`, and `parked` remain
distinct (`is_error: true`).

### `stream-json`

Newline-delimited JSON events:

1. `system` / `init` — workspace, session, model, mode  
2. `user` — the prompt  
3. optional `assistant` deltas when `--stream-partial-output` is set (`timestamp_ms` present; cumulative text)  
4. final `assistant` flush with the full text (no `timestamp_ms`)  
5. terminal `result` — same fields as the `json` format  

Tool-call lifecycle events may be added later; today tool work is reflected only in Session storage and final
`status` / text.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Run `completed` |
| `1` | Run `failed`, auth not ready, or unexpected error |
| `2` | Run `parked` (budget / human gate / similar) |
| `130` | Run `cancelled` |

## Auth

Print mode requires a ready provider credential (environment API key or a previously sealed `/login` account).
It does not open the interactive login form. Secrets are never accepted as CLI flags.

## Relationship to other surfaces

| Surface | Role |
| --- | --- |
| TUI / line mode | Interactive control and projection |
| `-p` / `--print` | One-shot scripted Run |
| `qi acp` (planned) | Long-lived JSON-RPC client protocol |
| `apps/web` | Read-only history |

All surfaces share the same Session event stream and capability model; print mode is not a second Runtime.
