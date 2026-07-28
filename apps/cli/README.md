# `@civaapple/qi`

Version **0.7.0** (moves with the Qi monorepo release).

Qi's CLI application composes authentication, project policy, persistence, Tools, the local single-writer
Runtime, and the interactive terminal lifecycle. Reusable Session presenters, controls, panels, themes, and
bounded renderers live in [`@civaapple/qi-tui`](../../packages/tui/README.md); this application consumes them rather
than maintaining a second UI implementation.

The installed executable is `qi`, reflecting the project's Chinese name 栖. The confirmed npm distribution
package is `@civaapple/qi`; installing it exposes `qi` through `bin.qi`.

The terminal projects the durable Session event stream; it does not keep a second, UI-only account of Run truth.
It uses `@earendil-works/pi-tui` for differential rendering, synchronized updates, a multi-line editor,
slash-command completion, bracketed paste, and CJK IME cursor support. Piped stdin and non-TTY environments retain
a deterministic line-oriented mode.

## Interaction model

Selection is observational: `/runs` → Runs / Steps / Actions / Agents lists let you pick a history object
without changing the active execution target. The chat transcript is the default surface; `/status` exposes
denser engineering detail.

### Session modes

| Mode | Behavior |
| --- | --- |
| `Ask` | Read-only Q&A and exploration; no Workspace writes, shell/script/verify, background tasks, or Subagents |
| `Plan` | Dedicated Planner: read exploration, optional read-only delegation, rich-TTY `ask_question`, and managed `plan_document`; no implementation |
| `Agent` | Granted implementation tools plus optional `update_plan` Work Todo (never `plan_document` or `ask_question`) |

New Sessions default to `Agent`. A new Formal Plan is self-contained Markdown, not Todo. Accepting its review
atomically enters Agent and starts one whole-plan implementation Run whose conversation history contains only
the accepted document; Workspace instructions, permissions, and tools are still compiled normally. Complex
implementation may use Agent-only `update_plan`; its snapshots appear in the timeline and do not prove
completion. The TUI displays up to 200 rendered lines of the accepted Formal Plan before the Executor timeline,
without showing the machine `<accepted-plan>` envelope. Longer plans show a Collapsed notice and their immutable
local file path instead of an expand control; shorter previews show the same path for direct opening. The
same bounded preview and path appear before the Plan Review choices, so acceptance never precedes document
visibility. The Executor still receives the complete document. Legacy item plans keep their item-per-Run
`/next` behavior.

In a rich TTY, Plan mode advertises `ask_question`. Its blocking panel supports single choice (Enter), multiple
choice (Space then Enter), custom/free text, Esc to persist a skipped question, and Ctrl+C to cancel the Run.
Choice questions include `Other…` by default unless the Planner explicitly marks custom input invalid. After
confirmation, the timeline retains a committed card showing every question and option plus the selected,
custom-text, or skipped result.
Non-TTY Plan mode does not advertise the tool, so the Planner prints all missing-information questions for the
next user turn.

Frequently used commands (default `/help` and autocomplete; aliases remain callable):

| Command | Purpose |
| --- | --- |
| `/help [command\|advanced]` | Shortcuts + common commands; `advanced` lists aliases |
| `/settings` | Settings hub: mode, **permissions**, providers, config, context, theme, **language**, status |
| `/mode [ask\|plan\|agent]` | Show or switch Session mode (`Shift+Tab` cycles when idle) |
| `/ask [prompt]` | Toggle Ask mode (Q&A, read-only); with a prompt, enter Ask and ask that question |
| `/login …` | Provider login; API-key form asks for Key, Base URL (prefilled), and Model. Providers list marks **configured** accounts (sealed key kept). Switch without re-entering the key via Providers → provider → **Switch**, or `/login use <provider>` (e.g. `/login use deepseek`). For **OpenAI Compatible**, also set a **Name** (e.g. `qianwenai` / `zhipu`); multiple names are saved under `[[compatible]]`. Open a saved name for **Switch / Reconfigure / Logout**, or `/login use <name>`. **Kimi** uses a four-model dropdown plus final custom-model input and shows editable effort/context defaults for API-key and device login. Slash: `/login <provider> key <api-key> [name <id>] [model <id>] [base_url <url>] [effort <level>] [context <tokens>]`. |
| `/plan [prompt]` | Create a plan from a prompt (switches to Plan mode); bare `/plan` shows the plan / review options |
| `/plan accept\|revise\|reject …` | Settle a pending Plan review |
| `/skills` | Skills hub: list discovered Skills, or Install → scope → name/path form |
| `/tasks [stop …]` | Interactive background-task list; select a running task and press Enter to stop it |
| `/mounts [add\|unmount …]` | Read-only mounts hub: list / add (path form) / unmount (picker); slash args still work |
| `/permissions` | Select capability grants (Space multi-select; applies to this Session and writes project `policy.toml`) |
| `/verify` | Guided verification setup: scans `package.json`/`pom.xml`/`AGENTS.md`/`README.md` for command candidates, then writes `.qi/qi.verify.json` after you confirm the selection |
| `/runs` | Session history hub → interactive Runs / Steps / Actions / Agents lists (Enter selects observation) |
| `/sessions` | List Workspace Sessions; type-to-search; Enter resumes in-process |
| `/next [continue\|stop\|plan]` | Next Run panel |
| `/steer <text>` | Queue direction for the next safe Step boundary |
| `/cancel` | Cancel the active Run |
| `/quit` | Cancel active work and exit |

While a Run is active, type normally to **queue follow-ups**. An empty composer shows Cursor-style bordered
placeholder text (`→ Add a follow-up` · `ctrl+c to stop`) with a **static** reverse-video caret on the `A` (no
blinking hardware bar). Idle empty state uses `→ Add a message`. Use ↑ to select/edit a queued item, Enter to
send-now (promote to front), Esc to cancel; after the Run ends, Qi starts the next follow-up automatically.
Slash commands and `/steer` are unchanged.

Hidden aliases (still work; listed by `/help advanced`): `/config`, `/context`, `/status`, `/providers`,
`/add-dir`, `/unmount`, `/skill`, `/task`, `/steps`, `/actions`, `/agents`, plus unimplemented `/coord` `/work`
`/gate` `/extensions`.

UI language defaults to Chinese. Set `language = "zh"` or `language = "en"` in `~/.qi/config.toml`, or
change it under `/settings` → Language (persists to the same file).

Use `/help` in the application for the localized categorized list. The default surface is a compact chat
transcript: a Qi welcome (or short header), full-width user message bars (with vertical padding), plain
Agent replies (narration before tools when the model requested Actions), and a live
`Running · phase · tool · tokens` strip above the composer while a Run is active. Startup probes trusted PATH
`rg` / `fd`; when missing, a dim Tip / 提示 recommends installing them (Node fallback remains active). After
`开始实现`, Plan Todo
(`✔` / `◐` / `○`) appears in the chat transcript (not sticky above the composer). Primary slash inspect commands
(`/settings`, `/plan`, `/skills`, `/tasks`, `/mounts`, `/permissions`, `/runs`, `/sessions`, `/help`) open temporary panels over the
composer (Esc closes / pops a level); they do not write Session events or append into the chat timeline, and
dismissing them does not cancel an active Run or Subagent. Unknown slash commands keep the chat open and show a
short notice (they do not open `/help`). When a Run fails with `INVALID_MODEL_ACTION` because the model called an
unadvertised capability-gated tool (for example `edit` without Write), the handoff and notice point to
`/permissions` to enable the missing grant. Write/edit Action cards still show unified diffs inline. Non-TTY line mode prints the same panel body after
the transcript. Working/phase always follows the executing Run; history selection in `/runs` remains observational.
Choosing another Session from `/sessions` closes the TUI and relaunches in-process with that `sessionId`
(same AuthSession); **New Session** clears `sessionId`. The current Session is marked `← current`.

Long pastes collapse to a line/char summary; Agent replies and Plans use a bounded terminal Markdown renderer
(fenced code keeps internal blank lines); wide tables wrap cells and fall back to a vertical field layout when
the terminal cannot preserve useful columns, rather than clipping right-side values. Tool cards appear only
when Actions exist; settlement glyphs stay distinct (`✓` / `!` / `⊘` / `?` / `×` / `●`); shell cards use compact
`$ command duration` with collapsed output and `Ctrl+O` expand. Write/edit cards use Cursor-style
`Edited path +N -M`, a `▎` gutter, nearby context, and no `---`/`+++`/`@@` chrome (`… truncated · Ctrl+O`).
The first Agent `update_plan` call does not require IDs: Qi discards model-supplied provisional Work item IDs,
assigns stable IDs, and returns them for later snapshots. Failed Todo cards show the rejection code and message
instead of only an empty progress ratio.
Composer keystrokes and the Running spinner refresh only the chrome strip; settled Runs reuse a chat fingerprint
cache so long Sessions stay responsive. Streaming model/tool output remains visible as a bounded three-line
Working-strip tail without invalidating the transcript; reasoning uses display-width wrapping so a provider's
single long reasoning line still occupies up to three visible lines, then replays from committed
`model.completed` as a distinct Thinking block. Active Runs also reuse settled-Step formatting caches, collapse prior
Action cards to one-line summaries, and fold older Steps (`… N earlier steps · Ctrl+O`); chrome-only Session
events skip transcript invalidate, while `authority.denied` repaints its visible `⊘` settlement.
A fixed two-line statusline shows `model · context%` and the active mode (`Ask` / `Plan` / `Agent`) on the first
line, and `workspace · branch` on the second. Theme follows dark/light/auto semantic tokens. Ordinary conversation
termination is labeled `responded`; `verified` is reserved for evidence-backed completion. Plan Review and
Next Run use temporary choice panels over the composer; transcript cards stay compact Session projections
([ADR 0011](../../design/decisions.md#adr-0011-make-human-control-and-askplanagent-modes-durable)).

The editor submits with `Enter` and inserts a newline with `Shift+Enter` or `Ctrl+J`; bracketed multi-line paste
is preserved as one message. A compact pixel mark appears before the first Run, then yields attention to the
Session timeline. Each Run injects at most the Workspace-root `AGENTS.md` (≤64 KiB, non-symlink) as bounded
workspace instructions; nested `AGENTS.md` files are not auto-loaded.

CLI flags are parsed by a pure helper that supports credential-free `--help`/`--version`. Bare `qi` uses the
current directory as the Workspace (optional positional `qi PATH` or `--workspace PATH`). `--data PATH`
names the exact Qi project-private data directory; when omitted it defaults to
`~/.qi/projects/<workspace-name>-<path-hash>` (or
`$QI_HOME/projects/...`), e.g. `C:\Users\…\.qi\projects\D-ai-project-qi`. Workspace-local
`.qi` still holds Skills and `qi.verify.json`.

Per-Workspace policy lives in `$QI_HOME/projects/<workspace-name>-<path-hash>/policy.toml`
(`max_steps`, `[capabilities]`, `[shell]`,
`[[mounts]]`), overlaying global `~/.qi/config.toml`; CLI flags still win. `--add-dir PATH` and
`/mounts add` authorize **read-only** mounts (`mount:<id>/…`); mutations stay in the primary Workspace.
Outside-root reads fail with `PATH_GRANT_REQUIRED` and open an allow/deny panel
([ADR 0015](../../design/decisions.md#adr-0015-separate-project-policy-from-session-mount-facts)). Project policy seeds each
launch (including in-process `/sessions` New Session / resume); `/permissions` can also apply capabilities to the
live Session. Mount events are audit facts. Before a
Run, the runtime reconciles additions, removals, and changed mount identities into the Session
([ADR 0015](../../design/decisions.md#adr-0015-separate-project-policy-from-session-mount-facts)).

When host execute is enabled, `[shell]` in user or project TOML selects profiles. `direct` keeps the argv `shell`
tool; `pwsh`, `cmd`, and `bash` are probed at startup and, when available, expose a separate `script` tool.
`/config` shows default/allowed profiles, resolved executables, versions, and unavailable reasons. Profiles are
never chosen from command text. Every Run receives a required host-environment block containing the detected
platform and the available/disallowed profile facts. Direct `shell` is described explicitly as executable plus
argv, without pipes or redirection; on Windows the block warns against POSIX-only
`bash`/`lsof`/`xargs` assumptions. A missing executable or unavailable profile becomes a fact for the rest of
that Run, so the model must change approach instead of repeating the same assumption. The same `execute` grant
also probes for a responding `docker` or `podman`
runtime at startup and, only when one responds, exposes a `codeact` tool that runs a short generated program in a
network-off, read-only-root container; its nested tool calls still pass through normal authorization and Session
events, and it can never call `codeact` or `delegate` itself.

`/verify` proposes verification commands rather than requiring hand-written TOML from the start: it scans
`package.json` scripts, a `pom.xml` presence, and fenced commands under headings in `AGENTS.md`/`README.md`,
marks unresolvable executables as unavailable, and opens a checklist for you to confirm before anything is
written. Applying the selection writes `.qi/qi.verify.json` through the same validation path as automatic
inference and, when Verify authority is already granted, immediately refreshes the live `verify` tool.

Long-lived commands do not use an implicit detached shell mode. With a separate `background` capability, the
model receives a `task` tool for bounded servers and watchers. Each ProcessTask links to its originating
Session/Run/Step/Action, has a hard expiry, stores a redacted private log under `dataRoot/tasks`, survives Run
completion as visible state, and can be stopped by selecting it in `/tasks` and pressing Enter or through
`/tasks stop <N|ID>`. Stop waits for confirmed process-tree exit and escalates after a bounded graceful wait;
terminal tasks remain visible but cannot be selected again. Restarted runtimes mark unowned live-task
records `lost`; normal TUI shutdown stops tasks it owns.

With a separate `delegate` capability (`--allow-delegate` or `capabilities.delegate`), the model may call
`delegate` for a depth-1 isolated Subagent. The child Session receives only an objective plus allowlisted Artifact
context, never the parent transcript, and cannot delegate further. The parent tool result is a short summary plus
Artifact refs. The sticky Running strip shows parent tokens (`waiting on subagent`); child token counts appear on the Subagents
transcript block. Subagent summaries return as `artifact://…` refs stored under `dataRoot/artifacts/` (not in
SQLite). Esc/`ctrl+c` on `/help` and other inspect panels only dismiss the panel — they do not cancel the parent
Run or in-flight Subagent. Unsettled delegations cancel on Session recovery before the parent Run parks
([ADR 0008](../../design/decisions.md#adr-0008-limit-subagent-delegation-to-one-isolated-layer)).

User TOML may set `context_window_tokens`. The TUI reserves up to 16K tokens for model output and shows window,
prompt budget, reserve, current use, and compacted-exchange savings. `/context` projects committed
`context.compacted` events; increasing the window does not turn off compaction or remove its Artifact trail.
Without an explicit override, Kimi model windows resolve from the selected model: `k3` uses 1,048,576 and
`k3-256k`, `kimi-for-coding`, and `kimi-for-coding-highspeed` use 262,144. Kimi defaults to `k3`.
Set `reasoning_effort = "low" | "high" | "max" | "none"` (aliases documented by `@civaapple/qi-ai` are also
accepted), pass `--effort`, or set `KIMI_MODEL_THINKING_EFFORT` / `QI_REASONING_EFFORT`; K3 defaults to `high`.
Disabling thinking may route K3/K2.7 requests to an older model according to the Kimi Code service contract.
An in-process model switch refreshes the model-derived window before the next Run; an explicit
`context_window_tokens` remains authoritative.
Kimi `/login` shows these defaults before authentication and saves the selected model, normalized effort, and
editable window to `~/.qi/config.toml`; the API key remains sealed under `QI_HOME`.

Main Runs default to 32 Steps. `max_steps` accepts 8–100 in user or project TOML, with
`--max-steps` > project > user > default precedence. Step 31 warns that only one executable Step remains; Step
32 is a tool-free handoff and parks the Run for budget with explicit progress, blockers, next actions, and
verification state.

The Skill catalog combines `<workspace>/.qi/skills` and `$QI_HOME/resources/skills`; Workspace wins on a name
collision. Only metadata enters the initial model context. The `skill` tool progressively loads a selected
`SKILL.md` or named resource. `/skills` → **Install skill** picks user vs Workspace scope, then a form for a
compatible Skill name or local path (for example from `~/.codex/skills/.system`); Qi does not search or
download from the network. With write authority, the model can only install to the Workspace and the Action
remains capability-checked and Effect-Journaled.

The same dedicated `skill` Tool can export an existing Workspace Skill to a new ordinary draft directory and
publish a digest-guarded update. Ordinary file tools still cannot access `.qi`. The read-only
`qi_session_inspect` Tool lets Ask, Plan, and Agent inspect bounded Session projections from the current project
EventStore; this capability adds no TUI command, panel, or query API.

See [the interaction contract](docs/interaction-model.md) for projection and rendering boundaries.

## Change guidance

- Add durable facts to protocol/kernel projections rather than inventing them in terminal component state.
- Keep command parsing and presentation testable without a real terminal.
- Render output from committed events; an optimistic spinner may show activity but may not claim settlement.
- Preserve line mode for CI, pipes, redirected input, and accessibility tooling.
- Bound transcript, tool output, diff, and plan rendering before adding more panels.
- Keep composer keystrokes, the Running spinner, streaming activity, and chrome-only Session events
  (`authority.requested` / `authority.granted` / `safety.*` / `context.compiled`) on the chrome path; preserve
  a bounded Working-strip live tail, and repaint transcript-visible settlements such as `authority.denied`.
- For long active Runs, fold older Steps and collapse prior Action cards to one-line summaries rather than
  rebuilding every historical tool card on each event.

Executable evidence lives in `tests/tui-presentation.test.mjs`, `tests/session-mode.test.mjs`,
`tests/tui-e2e.test.mjs`, `tests/tui-input.test.mjs`, `tests/tui-codeact.test.mjs`, and
`tests/tui-verify-setup.test.mjs`.
