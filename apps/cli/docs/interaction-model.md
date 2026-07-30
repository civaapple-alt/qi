# TUI interaction contract

## Technology decision

The interactive surface uses [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi/tree/main/packages/tui).
It matches Qi's thin application boundary: components render arrays of terminal lines, while the Session
projection remains the state model. Its differential rendering, synchronized output, editor, paste handling,
autocomplete, and IME support solve terminal mechanics without introducing React application state.

Alternatives considered:

| Option | Useful property | Reason not selected |
| --- | --- | --- |
| React + Ink, as used by Gemini CLI | Mature component ecosystem and test tooling | Adds React/reconciler state and a larger dependency surface to a projection-only application |
| Solid + OpenTUI, as used by OpenCode | Rich full-screen primitives and shared Solid concepts | Oriented around a heavier Bun/native rendering stack than Qi's Node ESM runtime needs |
| readline plus hand-written ANSI updates | No new dependency | Reimplements diff rendering, cursor control, paste, completion, resizing, and IME behavior poorly |

The dependency is a rendering mechanism, not a source of authority or Session truth. Non-TTY execution stays on
the existing readline-compatible path.

Interactive paint cost: composer keystrokes and provisional activity refresh only the Working strip and footer.
The chat transcript component caches its last paint until Session events, expand, or other transcript-affecting
state change. `TuiPresenter.update()` performs cold start/resynchronization; contiguous committed facts use
`applyCommitted()` and invalidate only the affected Run/Step/Action. Live streaming (`onActivity`) updates a bounded three-line model/tool tail in the Working strip
without invalidating the transcript. Chrome-only Session facts (`authority.requested`, `authority.granted`,
`safety.*`, `context.compiled`, mounts/memory/presence) use the same path; `authority.denied` repaints the
transcript because it visibly settles the Action as `⊘`. Inside `TuiPresenter`, Action propose/start/terminal
lookups are indexed during cold replay and advanced per committed event, settled Runs reuse a fingerprint cache, and settled Steps inside an
active Run cache their card/Markdown formatting by width and visible state. Non-final Steps render one-line
Action summaries (no edit gutters); an active Run with more than eight prior Steps folds older Steps into
`… N earlier steps · M actions · Ctrl+O` (inspired by kimi-code fold / pi-tui paint classification — not a
virtual transcript list). The current Run plus 20/12/6 recent settled Runs are retained in
compact/standard/diagnostic density respectively, with a 1200-rendered-line ceiling.

## Projection hierarchy

```text
Session
└── selected Run       /runs History Center → Runs
    ├── Subagents      /runs → Agents   (depth-1 delegation projection)
    └── selected Step  /runs → Steps
        └── Action     /runs → Actions
```

The current Run remains the execution target. Inspecting an older Run changes only the visible projection — pick
it from the interactive `/runs` lists (↑↓ / Enter). A new
event advances the supplied committed projection; a sequence/Session discontinuity requests a one-time
EventStore resynchronization. It never mutates a locally inferred action state.

The default screen is a chat transcript: full-width user bars (with vertical padding), plain Agent text, and tool
cards only when Actions
exist. Within a Step, narration from `model.completed` with `finishReason: actions` (or live model text) renders
before that Step’s Action cards so the timeline reads narration → tools → later Step answers. While a Run is
active, a sticky `Running · <phase> · <tool> · <tokens>` line sits above the composer and always tracks the
executing Run, not an observationally selected older Run. While busy, the composer shows `→ Add a follow-up`;
plain text Enter enqueues a **follow-up** (UI-only until drained). A `follow-ups` panel lists queued items:
`enter send now · ↑ select/edit · esc cancel`, and while editing `editing · enter done · esc close`. After the
current Run settles and no Plan review / Next Run gate is pending, Qi drains the queue FIFO into the next
user Run. Mid-Run direction still uses `/steer` at the next safe Step boundary (system-design §9.3). Plan Todo
is not sticky: after `开始实现` it appears in the chat transcript (`✔` / `◐` / `○`) and updates there as
Plan-bound Runs settle.

Slash inspect and navigate commands (`/config`, `/skills`, `/help`, `/status`, `/runs`, `/sessions`, …) open a
temporary panel that replaces the composer, with a title, horizontal rules, scroll/search when needed, and Esc to
close. Panels are UI-only: they never write to the Session event stream and do not append into the chat transcript.
Unknown slash names stay on the chat surface with a short notice (they do not open `/help`). When a Run fails
because the model requested an unadvertised capability-gated tool (for example `edit` without Write), the handoff
next-step line and the composer notice guide the operator to `/permissions`. Non-TTY line
mode still dumps the panel body after the transcript for pipes and accessibility. Mode changes update the
statusline only; they do not emit a top-of-transcript notice. Transient `notice` lines appear in the strip
above the composer so long chats do not hide them. Operator info notices (login, permissions, unknown slash,
…) expire after four seconds and clear immediately when the next composer submission begins. Run
failure/cancellation notices do not time out; they remain until the operator starts the next interaction or
the Runtime explicitly clears the outcome.

`/settings` opens a multi-level panel stack (Mode, Permissions, Providers, Config, Context, Theme, Language,
Timeline density, Status, Session history). Density changes are local presentation state; only an explicit
“save user default” choice writes `[ui].timeline_density` to user config.
`/providers` and empty `/login` open the provider list; selecting a provider offers API-key form or Kimi device
login without writing secrets into Session events or TOML. Esc pops one panel level; an empty stack restores the
composer.

Provider login details:

- API-key providers: Key + Base URL (prefilled) + Model; successful login persists `provider` / `model` /
  `base_url` / `account_alias` into `~/.qi/config.toml`.
- Kimi API-key and device forms replace the free-form Model field with a dropdown for `k3`, `k3-256k`,
  `kimi-for-coding`, and `kimi-for-coding-highspeed`; the final dropdown item exposes a custom model-ID input.
  The same form displays K3's default `high` effort and the selected model's default context window. Both are
  editable, persisted as `reasoning_effort` / `context_window_tokens`, and applied to the live runtime.
- **OpenAI Compatible** (`compatible`): OpenAI Chat Completions gateways. Login requires a display **Name**
  (e.g. `qianwenai` / `zhipu`). Multiple endpoints are stored under `[[compatible]]`. Selecting a saved
  endpoint opens Switch / Reconfigure (API key) / Logout — same pattern as other providers. Slash:
  `/login use <name>`.
- Sealed provider accounts are marked **configured** in Providers. Switch without re-entering the key via
  **Switch to this provider**, or `/login use <provider>` (e.g. `/login use deepseek`). Model/base URL are
  restored from credential metadata. **Switch** only activates another sealed account; **Logout** clears only
  the selected provider or compatible name (other sealed accounts and catalog entries remain).
- **Kimi device/OAuth**: confirm Model / effort / context before the browser authorize step, or use
  `/login kimi device model <id> effort <level> context <tokens>`.

Primary slash commands are intentionally few: overlapping inspect entries live under `/settings`, mount
operations under `/mounts`, capability grants under `/permissions`, skill/task management under `/skills` and
`/tasks`, Session history under `/runs` (height-paged, bounded type-to-search selection; no `/run N` style selectors), and Workspace
Session resume under `/sessions`. List shortcuts `/steps` `/actions` `/agents` remain aliases.
Previous command names that only selected by index/id were removed. UI copy for slash help, settings, and
these hubs follows `language` in `~/.qi/config.toml` (`zh` default, or `en`).

`/status` (alias) opens the denser Session/Run/Step/Action engineering panel. `Ctrl+O` expands or collapses the
latest or explicitly selected Action/activity group/Thinking block, long paste, or Markdown code block.
`Ctrl+G` opens pending gates in Run Question → Plan Review → Next Run → path grant order. New gates never replace
a non-empty composer or follow-up editor; they leave a persistent attention notice. Focus and expansion are
observational; they do not hide committed history.

Session mode is durable (`ask` / `plan` / `agent`). Plan mode records managed Formal Markdown
`plan_document` revisions; a Formal Plan is not a Todo. Review offers `开始实现` / `修改计划` / `拒绝计划`.
Accept settles review, switches to Agent, and starts one whole-plan Run
([ADR 0011](../../../design/decisions.md#adr-0011-make-human-control-and-askplanagent-modes-durable)). The
Executor receives the accepted document plus ID/revision/SHA but none of the planning conversation.
The generated `<accepted-plan>` input remains machine context; the chat projection instead renders up to 200
terminal lines of the bound Formal Plan Markdown without paste classification. Longer plans end with a
Collapsed notice instead of `Ctrl+O`; every preview names the immutable local file path, and the Executor
context still contains the complete document. The same preview is visible in the timeline before the Plan
Review choices appear, so the user can inspect exactly what will be accepted.
Revision reads the latest document and uses SHA-checked `plan_document edit`; each edit creates an immutable
revision and reopens review. A drafting Run cannot finish on `plan_document read`: it must complete a
`write`-effect create/edit Action in that Run, otherwise the Loop asks for the missing mutation or parks for
review without claiming a new revision.

Rich TTY Plan Runs may block on `ask_question`. Its panel supports single/multiple/text/custom answers, Esc skip
per question, and Ctrl+C Run cancellation; choice questions expose `Other…` unless `allowText: false` is
explicitly supplied. The answer resumes the same Action and Run, and its committed timeline card keeps all
questions/options visible with selected, custom-text, and skipped results. Non-TTY omits this tool, so the
Planner emits a normal next-turn question list. Legacy item plans alone retain the Next Run panel and `/next`.
`/work` and `/todo` are intentionally absent; Work Todo snapshots live in the conversation timeline.

## Tool rendering

Settlement glyphs stay distinct: `✓` completed, `!` failed, `⊘` denied, `?` indeterminate, `×` cancelled, `●`
running, `○` other. The TUI must not collapse these into a binary error flag.
Markdown tables wrap cell content within adaptively allocated columns. When the terminal is too narrow to keep
every column useful, the renderer switches to a per-row vertical field layout so right-side values are retained.

- Shell/script/verify: a settled success is one compact `$ command duration` line (or script/verify equivalent).
  Expansion or diagnostic density reveals cwd and a bounded stdout/stderr window. A failure automatically keeps
  at most three evidence lines; timeout remains explicit. Indeterminate cards also keep the durable settlement
  reason and reconciliation hint (for example a missing `workdir` path), and parked-run handoff text prefers
  that Action evidence over a bare "settlement could not be confirmed" phrase. Elapsed time comes only from
  committed event timestamps.
  Live tails use a flat `·` prefix (also up to three lines) rather than box-drawing chrome.
- Read: header-only (`path · N lines`); file contents are never echoed into the transcript.
- Write/edit: completed cards read `Edited <path> +N -M` (Cursor-style). The body uses a `▎` gutter, shows
  change lines with nearby context, and omits `---`/`+++`/`@@` chrome. Long patches collapse surplus middle as
  `… truncated (N more lines) · Ctrl+O`; short patches are never stats-only. Full unified diffs remain on the
  durable Action card / Artifact reference.
- `plan_document`: create/read/edit card for a complete Formal Plan; SHA-checked edits publish immutable
  `plans/<planId>/<sha256>.md` revisions. Durable truth remains under `/plan`.
- `update_plan`: Codex-style Todo snapshot with stable Work item IDs and at most one `in_progress`. Timeline cards
  keep the full ✔/◐/○ item list in the chat stream (including mid-Run collapsed Steps), with a
  `Working on N to-dos · M/N done` header — not a sticky footer. It is implementation navigation, not completion
  evidence. On create, Qi assigns the Work Plan and Work item IDs even if the model supplied provisional item IDs;
  later calls use only IDs returned by a successful snapshot. Failed cards retain the rejection code and
  actionable message.
- Consecutive same-Step read-only discovery Actions (`read/list/tree/find/search/git`) settle as
  `Explored N actions`. Expansion and the History Center preserve every durable child. Any failed, denied,
  cancelled, or indeterminate child expands the group automatically.
- Delegate: parent timeline shows a Subagents progress block (`Running` / `Finished` per depth-1 delegation) with
  child context tokens on each Subagent row; the sticky Running strip keeps parent-agent tokens only
  (`waiting on subagent` while `delegate` is in flight). Child transcripts stay in the child Session
  (`runtime.childView` / `/agents`). Inspect panels (`/help`, …) dismiss with Esc and must not cancel the parent
  Run or in-flight Subagents. The UI never invents parallel fan-out beyond durable running delegations
  (Plan Subagents remain serial).
- Legacy Plan Todo: historical item revisions still project progress and `/next`; Formal Plans never derive Todo
  from Markdown sections.
- Network, Skill, Artifact, and ProcessTask Actions use separate compact card grammars. One card changes lifecycle
  state instead of emitting unrelated start/completed rows.

Model deltas and process pipes may arrive before their durable terminal events. The TUI shows only a redacted,
bounded, process-local tail labelled `live`; it never treats this provisional channel as settlement or evidence.
Model reasoning uses the same boundary: the Working strip keeps three display-wrapped lines, and
`model.completed.reasoning` replays in standard density as `Thinking · duration`; expansion/diagnostic shows a
bounded three-line excerpt, while compact hides settled Thinking. Reasoning remains explanatory model
output rather than completion evidence. Committed terminal output replaces the live interpretation. See
[ADR 0005](../../../design/decisions.md#adr-0005-keep-provisional-activity-outside-durable-session-truth).

## Composer and background work

The composer uses `Enter` to submit and the pi-tui defaults `Shift+Enter` or `Ctrl+J` to insert a newline.
Bracketed multi-line paste remains one submission; long pastes collapse in the timeline until `Ctrl+O` expands
them. An empty composer paints Cursor-style placeholder chrome (`→ Add a message` when idle, `→ Add a follow-up`
while a Run is active, `ctrl+c to stop|quit` on the right) with a **static** reverse-video caret on the first
letter after `→` (e.g. `A` in Add); the terminal hardware cursor stays hidden so it does not blink as a second
vertical bar while typing. A fixed two-line
statusline under the editor reports phase, model, context %, changed files, workspace, capabilities, and active
ProcessTask count.

Finite `shell` Actions wait for exit. Long-lived servers and watchers require the separate `background`
capability and `task` tool. `task.started`, `task.stop.requested`, `task.exited`, and `task.lost` make ownership and
recovery durable while output remains a bounded live/log channel. `/tasks` opens an interactive list: Enter
stops the selected running task, while terminal tasks remain visible and disabled. `/tasks stop <N|ID>` is the
non-interactive equivalent. Stop waits for process-tree exit and escalates after a bounded graceful wait; it
reports `lost` rather than claiming success if exit still cannot be confirmed. Tasks have a hard expiry and
runtime-owned tasks stop on TUI exit. See
[ADR 0006](../../../design/decisions.md#adr-0006-represent-long-lived-processes-as-bounded-processtasks).

The Kernel still records response-only terminal Runs as `run.completed` with `completionKind: response`. The TUI
renders this as `responded`, not `completed`; `verified` is reserved for evidence-backed completion.

## Context rendering

Every Step shows `estimatedTokens / budgetTokens` from `context.compiled`. Optional block omissions are listed
directly. Cross-Run history compaction records each omitted Run as `history:omitted:<runId>`; the TUI therefore
reports compaction only after the runtime has recorded it.

Every Run also receives a required `host:environment` constitution block generated from startup probes. It
states the host platform, direct-command semantics, and every available/disallowed shell profile. On Windows it
explicitly rejects POSIX-only assumptions such as `bash`, `lsof`, `xargs`, and `/dev/null` unless a corresponding
profile was actually probed. A missing executable or unavailable-profile failure is treated as an environment
fact for the remainder of that Run; the model must change approach instead of retrying the same assumption.

The effective configuration distinguishes the provider/model window, prompt working budget, and output reserve.
Within a Run, `/context` lists reclaimed estimated tokens from committed `context.compacted` events. A settled
exchange remains complete for its first model consumer, then may become an Artifact-backed causal summary under
pressure. If required context still cannot fit, the Run parks at the safe Step boundary with reason `budget`.
When the selected Step has `context.compiled.blockStats`, the same panel lists each ContextBlock kind's included
token share, included/omitted counts, and omitted estimated tokens. Conversation messages and advertised Tool
schemas are shown as one separate non-block subtotal because they are part of prompt use but are not
ContextBlocks.

## Read-only directory mounts

Cross-directory reads use human-gated mounts, not model-owned authority. Project policy lives at
`$QI_HOME/projects/<workspace-name>-<path-hash>/policy.toml`
(`[capabilities]`, `[[mounts]]`); capability merge order is
CLI flags > project TOML > global `$QI_HOME/config.toml`. **Shell profiles** live only in
`$QI_HOME/config.toml` (project `[shell]` is ignored); first launch without `[shell]` probes and writes
installed defaults. `/mounts add <path>`, `/mounts`, and
`/mounts unmount <id>` manage mounts in-session. `/permissions` (also under `/settings`) lists effective Session
capabilities with Space multi-select, applies the selection to the current Session (tool catalog + leases)
immediately when no Run is active, and writes `[capabilities]` into the project config. `/shell` multi-selects
`direct` / `pwsh` / `cmd` / `bash`, hot-applies tools and leases, and writes `[shell]` into `$QI_HOME/config.toml`.
In-process New Session / resume re-reads project capabilities (CLI `--allow-*` / `--safe` from the original
launch still win) and re-ensures user shell config.
External project-TOML edits during a live Runtime still wait for relaunch; `/shell` and `/permissions` are the
in-session apply paths.
When a read/discovery tool hits a path outside the primary Workspace and
mounts, the Action fails with `PATH_GRANT_REQUIRED` and the TUI offers allow (persist read mount) or deny.
Authorized paths use `mount:<id>/…`; write/edit/move/remove remain confined to the primary Workspace. See
[ADR 0015](../../../design/decisions.md#adr-0015-separate-project-policy-from-session-mount-facts).

## Skill discovery and installation

`/skills` projects the current merged catalog from Workspace and user roots. Scope and same-name shadowing are
visible rather than silently flattened. Catalog metadata may enter the Run context; full instructions and
resources enter only after a `skill` Action requests them.

`/skills` → **Install skill** opens a scope list (user vs Workspace) then a form for a Skill name or local path.
Installation is disabled while a Run or another TUI management action is active. A model does not receive
global-install authority: its `skill install-workspace` operation requires the
write lease, settles as an ordinary Action, and can only publish a Workspace draft or a named Skill from a
configured local compatibility root.
