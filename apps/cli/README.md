# `@civaapple/qi`

Version **0.7.2** (moves with the Qi monorepo release).

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

Selection is observational: `/runs` lists Runs in the current Session (newest first), like `/sessions`;
Enter opens that Run's Steps or Agents (a chooser when both exist); pick a Step to reach its Actions
(type-to-search) without changing the active execution target. The chat transcript is the default surface; `/status` exposes
denser engineering detail.

The rich TTY has three stable regions: a committed同行 timeline, a provisional live status strip, and controls
(composer, follow-ups, attention panels, statusline, and History Center). Provisional Thinking/tool output never
enters Session truth or rewrites settled history. `Ctrl+O` expands the latest or explicitly selected block.
`Ctrl+G` opens the highest-priority pending gate: Run Question, Plan Review, Next Run, then sensitive-path
grant, then outside-Workspace path grant. A new gate
never steals focus while the composer contains text or a follow-up is being edited; it leaves a persistent
attention notice instead.

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

A Plan drafting or revision Run must complete a `write`-effect `plan_document create/edit` Action before it can
finish and offer review. `plan_document read` returns the latest Markdown and SHA for editing but cannot publish
a revision or reopen review.

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
| `/settings` | Settings hub: mode, **permissions**, **shell**, **Step budget**, providers, config, context, theme, language, **timeline density** |
| `/memory [list\|remember\|accept\|correct\|forget\|promote\|pin\|unpin]` | Inspect actual Run injection, pending candidates, Project/User boundaries and provenance; explicitly manage the full Memory lifecycle |
| `/mode [ask\|plan\|agent]` | Show or switch Session mode (`Shift+Tab` cycles when idle) |
| `/ask [prompt]` | Toggle Ask mode (Q&A, read-only); with a prompt, enter Ask and ask that question |
| `/login …` | Provider login; API-key form asks for Key, Base URL (prefilled), and Model. Providers list marks **configured** accounts (sealed key kept). Switch without re-entering the key via Providers → provider → **Switch**, or `/login use <provider>` (e.g. `/login use deepseek`). For **OpenAI Compatible**, also set a **Name** (e.g. `qianwenai` / `zhipu`); multiple names are saved under `[[compatible]]`. Open a saved name for **Switch / Reconfigure / Logout**, or `/login use <name>`. **Kimi** uses a four-model dropdown plus final custom-model input and shows editable effort/context defaults for API-key and device login. Slash: `/login <provider> key <api-key> [name <id>] [model <id>] [base_url <url>] [effort <level>] [context <tokens>]`. |
| `/plan [prompt]` | Create a plan from a prompt (switches to Plan mode); bare `/plan` shows the plan / review options |
| `/plan accept\|revise\|reject …` | Settle a pending Plan review |
| `/skills` | Skills hub: list discovered Skills, or Install → scope → name/path form |
| `/tasks [stop …]` | Interactive background-task list; select a running task and press Enter to stop it |
| `/mounts [add\|unmount …]` | Read-only mounts hub: list / add (path form) / unmount (picker); slash args still work |
| `/permissions` | Select capability grants (Space multi-select; applies to this Session and writes project `policy.toml`) |
| `/shell` | Select global shell profiles (`direct` / `pwsh` / `cmd` / `bash`; applies immediately and writes `$QI_HOME/config.toml`) |
| `/verify` | Guided verification setup: scans `package.json`/`pom.xml`/`AGENTS.md`/`README.md` for command candidates, then writes `.qi/qi.verify.json` after you confirm the selection |
| `/runs` | Session history hub — choose Runs, then Steps or Agents (Actions via Step; chooser when both exist; Enter selects observation; no separate `/steps` / `/actions` / `/agents` shortcuts) |
| `/sessions` | Active/Archived Session list; type-to-search; Enter resumes or restores; `a` archives (with confirm) |
| `/status` | Session/Run/Step/Action engineering detail panel |
| `/model` | Open model picker / reconfigure without re-login (model, thinking effort, and context; scope chosen in panel) |
| `/reset-workspace` | Preflight all active Sessions, archive them, and start a fresh Session |
| `/next [continue\|stop\|plan]` | Next Run panel |
| `/steer <text>` | Queue direction for the next safe Step boundary |
| `/cancel` | Cancel the active Run |
| `/quit` | Cancel active work and exit |

While a Run is active, type normally to **queue follow-ups**. An empty composer shows Cursor-style bordered
placeholder text (`→ Add a follow-up` · `ctrl+c to stop`) with a **static** reverse-video caret on the `A` (no
blinking hardware bar). Idle empty state uses `→ Add a message`. Use ↑ to select/edit a queued item, Enter to
send-now (promote to front), Esc to cancel; after the Run ends, Qi starts the next follow-up automatically.
Slash commands and `/steer` are unchanged.

Hidden aliases (still work; listed by `/help advanced`): `/config`, `/context`, `/max-steps`, `/providers`,
`/add-dir`, `/unmount`, `/skill`, `/task`, `/exit`, plus unimplemented `/coord` `/work` `/gate` `/extensions`.
Typing `/steps`, `/actions`, or `/agents` redirects to the `/runs` hub with a notice to use the hub instead.

UI language defaults to Chinese. Set `language = "zh"` or `language = "en"` in `~/.qi/config.toml`, or
change it under `/settings` → Language (persists to the same file).

Timeline density defaults to `standard`. `/settings` → Timeline density can apply `compact`, `standard`, or
`diagnostic` to only the current Session, or persist the user default:

```toml
[ui]
timeline_density = "standard"
```

Memory capture and retrieval default to enabled:

```toml
[memory]
enabled = true
auto_accept_project = true
```

The model-visible `memory` Tool can only propose a claim with an exact quote from the current user input or a
completed Action result; Qi binds the concrete scope IDs. Public, non-relational Session/Project proposals at
confidence ≥ 0.8 may be accepted without another model call. User, private/secret, relational, correction and
promotion paths wait for an explicit user action. `/memory remember` opens the rich Add Memory form; line mode
supports the same verbs. `--always`/pin is User-only and capped at four. Disabling Memory stops capture and
context injection but keeps list and forget management available. Stored text is plaintext in machine-private
SQLite; credential-like material is rejected before any Memory/source event is written.

Use `/help` in the application for the localized categorized list. The default surface is a compact chat
transcript: a Qi welcome (or short header), full-width user message bars (with vertical padding), plain
Agent replies (narration before tools when the model requested Actions), and a live
`Running · phase · tool · tokens` strip above the composer while a Run is active. Startup probes trusted PATH
`rg` / `fd`; when missing, a dim Tip / 提示 recommends installing them (Node fallback remains active). After
`开始实现`, Plan Todo
(`✔` / `◐` / `○`) appears in the chat transcript (not sticky above the composer). Primary slash inspect commands
(`/settings`, `/plan`, `/skills`, `/tasks`, `/mounts`, `/permissions`, `/shell`, `/runs`, `/sessions`, `/help`) open temporary panels over the
composer (Esc closes / pops a level); they do not write Session events or append into the chat timeline, and
dismissing them does not cancel an active Run or Subagent. Unknown slash commands keep the chat open and show a
short notice (they do not open `/help`). When a Run fails with `INVALID_MODEL_ACTION` because the model called an
unadvertised capability-gated tool (for example `edit` without Write), the handoff and notice point to
`/permissions` to enable the missing grant. Every Run also receives an explicit Workspace Write enabled/disabled
fact: when disabled, a mutation task should stop promptly and request the grant instead of drafting project files
into the machine-private `artifact` store. Artifact persistence never changes the Workspace or proves a Work Plan
item complete. Write/edit Action cards still show unified diffs inline. Non-TTY line mode prints the same panel body after
the transcript. Working/phase always follows the executing Run; history selection in `/runs` remains observational.
Choosing another Session from `/sessions` closes the TUI and relaunches in-process with that `sessionId`
(same AuthSession); **New Session** clears `sessionId`. Archiving the current Session also starts a new one.
Tab switches Active/Archived; restoring an archived Session validates `archive.json` before making it active.
The current Session is marked `← current`.

Long pastes collapse to a line/char summary; Agent replies and Plans use a bounded terminal Markdown renderer
(fenced code keeps internal blank lines); wide tables wrap cells and fall back to a vertical field layout when
the terminal cannot preserve useful columns, rather than clipping right-side values. Tool cards appear only
when Actions exist; settlement glyphs stay distinct (`✓` / `!` / `⊘` / `?` / `×` / `●`); shell cards use compact
`$ command duration`, with successful output available through `Ctrl+O` and bounded failure evidence retained.
Consecutive same-Step read-only `read` / `list` / `tree` / `find` / `search` / `git` Actions settle as
`Explored N actions`; diagnostic, selected, and exceptional groups show every durable child. Write/edit cards use Cursor-style
`Edited path +N -M`, a `▎` gutter, nearby context, and no `---`/`+++`/`@@` chrome (`… truncated · Ctrl+O`).
The first Agent `update_plan` call does not require IDs: Qi discards model-supplied provisional Work item IDs,
assigns stable IDs, and returns them for later snapshots. Failed Todo cards show the rejection code and message
instead of only an empty progress ratio.
Composer keystrokes and provisional activity refresh only the chrome strip; settled Runs reuse a chat fingerprint
cache and committed facts apply incrementally. The main timeline retains the current Run plus a density-specific
recent settled window (`compact` 20, `standard` 12, `diagnostic` 6), capped at 1200 rendered lines; older Runs
collapse behind one `/runs` anchor. Streaming model/tool output remains visible as a bounded three-line
Working-strip tail without invalidating the transcript; reasoning uses display-width wrapping so a provider's
single long reasoning line still occupies up to three visible lines, then replays from committed
`model.completed` as an expandable `Thinking · duration` item. Static waits do not spin; finite Actions show
elapsed time after two seconds and “still running” after thirty. Active Runs also reuse settled-Step formatting caches, collapse prior
Action cards to one-line summaries, and fold older Steps (`… N earlier steps · Ctrl+O`); chrome-only Session
events skip transcript invalidate, while `authority.denied` repaints its visible `⊘` settlement.
A fixed two-line statusline shows `model · context%` and the active mode (`Ask` / `Plan` / `Agent`) on the first
line, and `workspace · branch` on the second. Theme follows dark/light/auto semantic tokens and degrades through
truecolor, ANSI-256, basic ANSI, and `NO_COLOR`; glyph/text always carries status meaning. Ordinary conversation
termination is labeled `responded`; `verified` is reserved for evidence-backed completion. Plan Review and
Next Run use temporary choice panels over the composer; transcript cards stay compact Session projections
([ADR 0011](../../design/decisions.md#adr-0011-make-human-control-and-askplanagent-modes-durable)).

The editor submits with `Enter` and inserts a newline with `Shift+Enter` or `Ctrl+J`; bracketed multi-line paste
is preserved as one message. A rendered multi-line user message receives one shared top/bottom padding pair,
not separate card spacing for every logical line. A compact pixel mark appears before the first Run, then yields attention to the
Session timeline. Each Run injects at most the Workspace-root `AGENTS.md` (≤64 KiB, non-symlink) as bounded
workspace instructions; nested `AGENTS.md` files are not auto-loaded.

In a rich TTY, `Ctrl+V` (and `Alt+V` on Windows, where terminals often own `Ctrl+V`) first checks the system
clipboard for an image — including a copied image file path — and otherwise inserts clipboard text.
Successful image paste inserts `[image #N (W×H)]`; deleting or changing that exact placeholder detaches the
image. Multiple text/image parts and queued follow-ups retain their order. Line mode has no clipboard entry but
recognizes Markdown image URLs, standalone URLs, embedded URLs with a known image extension, and local image
paths (`mount:<id>/…`, Workspace-relative, or absolute paths under the Workspace / authorized mounts). URL
ingestion requires Network permission; path ingestion requires the file to resolve inside an authorized root.
Both verify magic bytes before preprocessing; a failed explicit candidate leaves the editor text intact and
blocks submission.

Image preprocessing defaults can be set globally:

```toml
[image]
max_edge_px = 2000
read_byte_budget = 262144

[[compatible]]
name = "my-vision-endpoint"
base_url = "https://example.com/v1"
model = "vision-model"
image_input = true
```

OpenAI-compatible endpoints are text-only without `image_input = true`. A Turn supports at most eight images and
20 MiB of prepared image data. The timeline displays committed metadata rather than maintaining a separate UI
attachment truth.

CLI flags are parsed by a pure helper that supports credential-free `--help`/`--version`. Bare `qi` uses the
current directory as the Workspace (optional positional `qi PATH` or `--workspace PATH`). `--data PATH`
names the exact Qi project-private data directory; when omitted it defaults to
`~/.qi/projects/<workspace-name>-<path-hash>` (or
`$QI_HOME/projects/...`), e.g. `C:\Users\…\.qi\projects\D-ai-project-qi`. Workspace-local
`.qi` still holds Skills and `qi.verify.json`.

Per-Workspace policy lives in `$QI_HOME/projects/<workspace-name>-<path-hash>/policy.toml`
(`max_steps`, `[capabilities]`, `[shell]`,
`[[mounts]]`, `sensitive_path_grants`, `[sensitive_paths]`), overlaying global `~/.qi/config.toml`; CLI flags still win. `--add-dir PATH` and
`/mounts add` authorize **read-only** mounts (`mount:<id>/…`); mutations stay in the primary Workspace.
Outside-root reads fail with `PATH_GRANT_REQUIRED` and open an allow/deny panel
([ADR 0015](../../design/decisions.md#adr-0015-separate-project-policy-from-session-mount-facts)). Sensitive Workspace
files (for example `.env`) fail with `SENSITIVE_PATH_GRANT_REQUIRED` before any file body reaches the model and open a
separate allow/deny panel; Allow persists `sensitive_path_grants` and emits Session audit facts
([ADR 0001](../../design/decisions.md#adr-0001-gate-sensitive-paths-before-content-reaches-the-model)). Project policy seeds each
launch (including in-process `/sessions` New Session / resume); `/permissions` can also apply capabilities to the
live Session. Mount and sensitive-path events are audit facts. Before a
Run, the runtime reconciles additions, removals, and changed mount identities into the Session
([ADR 0015](../../design/decisions.md#adr-0015-separate-project-policy-from-session-mount-facts)).

When host execute is enabled, `[shell]` in **`$QI_HOME/config.toml`** (or `QI_CONFIG`) selects profiles.
`direct` keeps the argv `shell` tool; `pwsh`, `cmd`, and `bash` are probed and, when allowed and available,
expose a separate `script` tool. Project `policy.toml` `[shell]` is ignored. On first launch without `[shell]`,
Qi probes platform-installed profiles and writes defaults (`direct` plus installed candidates) into the user
config. `/shell` (also under `/settings`) multi-selects profiles and hot-applies them without restarting.
`/config` shows default/allowed profiles, resolved executables, versions, and unavailable reasons. Profiles are
never chosen from command text. Every Run receives a required host-environment block containing the detected
platform and the available/disallowed profile facts. Direct `shell` is described explicitly as executable plus
argv, without pipes or redirection; models are told to use at most one `shell`/`script` per workdir per Step and
to probe multiple host tools in one `script` Action when a profile is available. On Windows the block warns against
POSIX-only `bash`/`lsof`/`xargs` assumptions. A missing executable or unavailable profile becomes a fact for the
rest of that Run, so the model must change approach instead of repeating the same assumption. The same `execute`
grant also probes for a responding `docker` or `podman`
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
`context.compacted` events and committed per-kind ContextBlock statistics. The block view shows included token
share, included/omitted counts, omitted estimated tokens, and a separate subtotal for conversation messages plus
advertised Tool schemas. Older Steps without aggregate facts remain readable but report that the block mix is
unavailable. Increasing the window does not turn off compaction or remove its Artifact trail.
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
`--max-steps` > project > user > default precedence. `/settings` → **Step budget** and the `/max-steps` alias
open the same panel (no args), persist the user default to `~/.qi/config.toml`, and hot-apply on the next Run.
Step 31 warns that only one executable Step remains; Step 32 is a tool-free handoff and parks the Run for budget
with explicit progress, blockers, next actions, and verification state.

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
The cross-package timeline and attention decision is
[ADR 0027](../../design/decisions.md#adr-0027-project-one-bounded-interaction-timeline-with-protected-human-attention).

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
