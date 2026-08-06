# Changelog

Notable user-visible, compatibility, security, and packaging changes are recorded here. Internal implementation
steps and investigation history belong in pull requests, not release notes.
Dated 0.7.x sections are source milestones during active development; they do not by themselves indicate npm
publication or a stable compatibility baseline. Unsupported pre-stable persistence generations may require a
backup plus reset or a new data root rather than an automatic migration.

## [Unreleased]

### Added

- Human-operated Skill installation now accepts `qi skill install <github-url> --skill <name>` and the matching
  `/skills` GitHub flow. Qi resolves and locks the current commit before installation; source selection precedes
  user/Workspace destination selection in the TUI.
- Marketplace Skills now support manifest-declared nested paths, independent per-Skill enablement, fixed
  user/model invocation policy, and pin-confirmed activation. `/skill:` accepts enabled marketplace Skills;
  `/plugin:` now invokes commands only.
- Enabled plugins now expose model-invocable Skills automatically; Skills marked
  `disable-model-invocation: true` remain user-only and require explicit selection. Users can still explicitly
  disable an otherwise model-invocable Skill per plugin pin.
- Claude-compatible plugin marketplace (ADR-0037): `qi marketplace` / `qi plugin` / `qi agent`, TUI
  `/plugins` · `/plugin:<id>` · `/agents` · `/agent:<id>`, vendored skills/commands/MCP declarations/agents from
  `claude-plugins-official`-shaped catalogs. MCP still requires human bind; hooks/LSP are unsupported.
- Production Skill subsystem: Agent Skills frontmatter, complete bounded resource trees, binary Artifacts,
  immutable Git/GitHub/archive sources and locks, readiness diagnostics, explicit `/skill:<name>` activation,
  and Execute-authorized bounded scripts without dependency installation.
- Production MCP subsystem using the pinned official 2.0 client: inert TOML declarations, stdio/Streamable HTTP/
  explicit legacy SSE, fingerprinted Tools/Resources/Templates/Prompts/instructions review, drift isolation,
  compact `mcp_catalog`/`mcp` proxies, sealed static/OAuth credentials, and CLI/TUI management.
- Separate default-off `publish` and one-use `spend` capabilities with CLI flags and permission controls.
- Project `.agents/skills` is directly active; global `~/.agents/skills` is lock-listed at startup and can be
  activated directly from the `/skills` list (`qi skill enable <name>` remains available for scripts), with state
  under `$QI_HOME/resources` before use.
- `~/.codex/skills` and `~/.claude/skills` are excluded from default `/skills` scanning and require explicit paths
  or configured compatibility roots.
- TUI `/skill:` autocomplete now offers active Skill names with prefix filtering; selecting a name still requires a
  user task before execution.
- Superpowers plugin integration: install from either the `superpowers` self marketplace or
  `claude-plugins-official`, inject the `using-superpowers` bootstrap when structural checks pass, and expose its
  bounded Skills/resources/scripts through the model-facing `plugin_skill` Tool.
- `/skills` → **Install** can remove Qi-managed Skills installed under `$QI_HOME/resources/skills` or
  `<workspace>/.qi/skills` (with confirmation). CLI: `qi skill remove <name> [--scope user|workspace]`;
  slash: `/skill remove [--workspace] <name>`. Global `.agents` Skills stay enable/disable-only and are not
  deleted by this path.
- `/plugins` → **Manage** tab (formerly Add Marketplace) is the marketplace maintenance hub: list sources, add,
  **Sync catalog** (GitHub fetch, same as `qi marketplace sync <name>`), enable/disable, and browse. Sync
  refreshes the marketplace catalog only; re-install a plugin to pick up content pin changes.
- Superpowers bootstrap no longer requires a fixed commit/version pin. An enabled `superpowers` plugin injects
  bootstrap after structural checks (`plugin.json` name + `skills/using-superpowers/SKILL.md`); marketplace sync
  and re-install can refresh content. Missing bootstrap Skill fails closed.

### Fixed

- `/plugins` **All** and **Installed** tabs no longer list plugins from disabled marketplaces. Only enabled
  marketplace catalogs (plus installed rows still declared or orphaned under those sources) appear; caches from
  disabled sources remain on disk under **Manage**.
- `/skills` marketplace tabs now omit disabled plugin marketplaces, matching `/plugins`. Installed Skill caches
  from a disabled source remain on disk but no longer appear as horizontal tabs until the marketplace is
  re-enabled.
- TUI `Add Marketplace` now accepts full `https://github.com/<owner>/<repo>` inputs and stores the canonical
  `owner/repo` source used by the marketplace synchronizer.
- Windows GitHub Skill installs no longer fail while removing a still-open Git pack file (`EBUSY`). Git metadata
  remains isolated until staging cleanup, which now retries transient Windows locks; the TUI immediately shows the
  active Skill installation notice while the source is being resolved.
- GitHub Skill and GitHub Marketplace acquisition preserve credential-free loopback proxy settings (for example
  `127.0.0.1:7890`) for Git transport, while continuing to scrub general child-process environment variables.
- Runtime base leases now authorize read-only `plugin_skill` discovery/loading and the Execute lease covers
  explicitly allowed plugin Skill scripts; installed Superpowers Skills no longer fail closed at the capability
  boundary with `plugin_skill ... denied`.
- TUI `/mcp` capability review collapses multiline remote tool descriptions to a single terminal row, matching
  `ListPanel`, so Context7-style descriptions no longer ghost duplicate pointers when scrolling.

### Changed

- `/plugins` is now a searchable marketplace-first browser with All, Installed, per-marketplace, and Add
  Marketplace tabs. Add Marketplace accepts local-clone or GitHub input; Enter offers install, enable, Skill
  selection, and detail actions. The browser distinguishes available, installed, and enabled plugins; Space
  toggles only installed plugin enablement.
- Marketplace sources now have their own persisted enabled state. Disabled sources are omitted from plugin
  browsing and reject sync/install. Disabling a source also disables its installed plugins while retaining their
  caches; re-enabling a source does not restore plugin enablement.
- `/skills` now uses the same compact horizontal browser pattern with Native, Global Agent, one tab per enabled
  plugin marketplace that has installed Skills, and Install. Disabled marketplaces are omitted (same as
  `/plugins`). Space toggles the selected marketplace Skill directly; Enter opens Skill details or the
  native/global management flow. Marketplace tabs show enabled/total counts and update in place.
- `/plugins` and `/agents` now show every installed plugin with its `name@marketplace`, enabled/installed state,
  source kind, and command/agent marketplace. `/skills` adds a separate plugin-Skill view (still distinct from
  native `/skill:` activation); entries stay single-line so long descriptions do not distort panel row height.
- Long dynamic `/plugin:`, `/agent:`, and `/skill:` autocomplete entries keep their exact completion value while
  using a compact primary label and the full qualified name in the description when the terminal selector's
  32-column label limit would otherwise truncate them.
- Plugin-market MCP declarations under `$QI_HOME/resources/mcp/<marketplace>/` are discovered as a distinct
  server id `name@marketplace` (for example `context7@claude-plugins-official`). They no longer share a slot
  with workspace `.qi/mcp/<name>.toml` or a flat user declaration of the same short name; `/mcp` and
  `qi mcp status|refresh|bind` use the qualified id for the market copy and the short name for workspace/flat.
  Status also surfaces origin (`plugin marketplace` / `workspace` / `user`).
- Plugin-materialized stdio MCP that launches via `npx` or `uvx` writes `connect_timeout_ms = 60000` so first
  package resolve is less likely to hit the 15s default connect timeout.
- Host `runHostProcess` timeout/cancel now awaits process-tree termination, escalates to a forced kill, and
  force-settles when exit/`close` cannot be confirmed so finite `shell` Actions cannot hang cancellation forever.
- Browser-style resident CLIs such as `agent-browser open` are guided onto background `task`/Jobs; finite `shell`
  remains for short attaching commands (`snapshot`, `click`, `screenshot`, `session`, `close`), with multi-turn
  reuse and close+reopen after related Workspace mutations.
- Follow-ups: newly queued items are selected (`●`) so Enter send-now / `d` delete work immediately;
  Esc clears selection or cancels edit (does not delete). After a Run settles, queued follow-ups drain
  before auto-opening path-grant panels so the first follow-up is not stranded.
- TUI Working strip token count grows during Thinking via approximate reasoning+text output
  (`context.estimatedTokens + estimatedOutputTokens`), then switches to provider `input+output` after
  `model.completed`. Abbreviations use two fractional digits in the `k` band (for example `10.42k`).
- Plugin-materialized MCP declarations write to `$QI_HOME/resources/mcp/<marketplace>/<name>.json` (for example
  `claude-plugins-official/context7.json`) instead of a flat `resources/mcp/<name>.json`. Discovery accepts that
  one-level marketplace layout; re-enable/install removes a leftover flat file for the same server name.
- When `reasoning_effort` is unset, adapters omit `reasoning.effort` / `reasoning_effort` on the wire so the
  provider API applies its own default. Explicit unsupported levels still fall back to catalog `defaultEffort`.
  The `/model` Thinking effort list includes **不设置（API 默认） / Unset (API default)** to clear a saved
  effort from config.
- DeepSeek and Qianwen catalogs advertise vendor-aligned efforts including `none` (disable thinking): DeepSeek
  Flash Responses `low|medium|high|xhigh|max` (+ `none`); Qwen3.8-Max `low|medium|xhigh` (+ `none`).
- Qianwen `qwen3.8-max` / `qwen3.8-max-preview` thinking efforts are now `low`/`medium`/`xhigh` (default
  `xhigh`), matching the Token Plan / DashScope Responses enum. Portable `xhigh` is first-class; on providers
  that only expose `max`, wire still coerces `xhigh` → `max`.
- TUI `/skills` adds **始终启用的 Skill / Always-on Skills**: lists Workspace and user Qi Skills (plus workspace
  `.agents` Skills) that need no activation toggle, with a `/skill:<name> <task>` invoke hint.
- Web Recent Sessions omit depth-1 Subagent child Sessions (`Delegated: …` catalog titles). Open those children
  from the Subagent Tasks pane; direct Session ID / deep links still work.
- TUI and Web `read_image` cards show `image #N · path|clipboard|url` (matching the user-message attachment
  line) plus crop/size instead of dumping the raw `artifact://` JSON input. Web Run Narrative also lists those
  Session attachments on the Run header.
- Model-facing `qi_session_inspect` is off by default. Enable it with `$QI_HOME/config.toml`
  `[tools] qi_session_inspect = true`. Offline Session extract / `inspectQiSession` are unchanged.
- Task text image detection now accepts bare filenames and prose-embedded paths (for example
  `查看 图片 spider-quiz-full.png`), `file://` local URIs, and unique Workspace/mount basename resolution when the
  typed path is incomplete. Zero or ambiguous hits stay text and do not fail the Run.
- Bound MCP image results are returned as tool-result `artifact` parts so image-capable models can see screenshots
  in the same Run; those Artifacts are not Session attachments and remain outside `read_image` authority.
- `mcp_catalog` search returns an explicit empty-catalog hint and steers agents away from inventing MCP servers or
  using MCP to view local Workspace/Session images.
- MCP stdio declarations now allow explicit `npx` and `uvx` launchers for registry-published servers. Exact
  package versions remain recommended, declared argv participates in transport drift, and discovery/binding/Run
  authority remain separately gated.
- `.qi/skills/**` now uses its dedicated full-tree validator while generic `.qi` declarations remain
  non-executable; Workspace Skill and MCP configuration changes are rejected during an active Run.
- TUI `/mcp` is now a single panel entry, like `/settings` and `/permissions`; server refresh, OAuth, capability
  review, binding, and unbinding are selected from the panel instead of slash subcommands.
- MCP list metadata is normalized to one terminal row so multiline remote tool descriptions cannot corrupt
  arrow-key rendering.
- MCP live action resources are deduplicated before `action.proposed` validation, fixing bound remote tool calls
  that previously failed with `INVALID_MODEL_ACTION`.
- MCP server summaries now distinguish the connection quarantine state from persisted capability bindings
  (`隔离（未连接） · 2/3 已绑定`).
- MCP server capability review is now a compact batch table: Up/Down selects a capability, Left/Right changes its
  pending effect, Enter saves all bind/unbind changes, and Esc discards them. It shows at most seven two-line
  entries while preserving search, scrolling, explicit refresh/OAuth actions, and the position counter.
- Ctrl+O now prioritizes a final reply that was truncated by rendered line count over collapsed Thinking,
  so long Markdown responses can be expanded reliably.

### Fixed

- `/model` now shows catalogued image capability and an Image input setting for providers such as
  `qianwenai/qwen3.8-max`, instead of limiting the control to generic `compatible` endpoints. User-default and
  Session-only saves carry the setting end to end, while catalogued text-only models still deny image input.
- MCP refresh now enumerates only capability classes advertised by each server, so tool-only servers such as
  Playwright no longer fail strict discovery on unsupported `resources/list` or `prompts/list` calls.
- Skill management keeps `/skills` to explicit hub actions—always-on Workspace/user catalog, global activation
  management, and installation—with a permissions-style Space toggle plus Enter apply flow for global Skills;
  individual Skill lists are confined to always-on browse and activation management.
- Global Agent Skill activations are now reconciled during startup and Run refreshes, so an external
  `npx skills remove <name> -g` removes the stale Qi activation record and prevents later Runs from loading it.
- Skill-aware TUI/Web projections now observe model-initiated `skill` Tool calls, hide Skill instruction bodies,
  distinguish failed Skill execution from a fallback Run response, and suggest `.env.example`/`.env.template`
  when a `.env` write is blocked.
- TUI and Web Run views now identify explicitly activated Skills while preserving the original task input; Skill
  instruction bodies remain outside the bounded UI projections.
- Qianwen AI Token Plan now catalogs the formal `qwen3.8-max` model and replays Qwen Responses reasoning
  items with their required `id` and `summary` fields during tool continuations, preventing the provider's
  `summary must be a list for reasoning` 400 response. The replay metadata remains process-local.
- Depth-1 Subagent wall-time limits now keep their abort timer alive until child settlement, avoiding
  unsettled Runs on Node 22 when the model stream has no other active handles.
- TUI CodeAct capability discovery is settled before the first Run builds its tool catalog, so a slow
  Docker/Podman probe cannot make an available `codeact` tool disappear from the initial request.

### Security

- Skill archives, paths, links, sizes, remote identities, scripts, and MCP transports now fail closed at their
  dedicated trust boundaries. MCP annotations/output remain untrusted, exact composite leases gate calls,
  non-read disconnects are never retried, and schema drift disables reviewed bindings.

### Documentation

- Expanded ADR-0004 and added ADR-0036, plus updated Skill/MCP package and CLI contracts with executable
  evidence for six pinned real Skills and all three MCP transports.

## [0.7.3] - 2026-08-03

### Added

- Settings → Subagent / delegate (`/subagent`, `/delegate`): user-config `[delegate]` envelope —
  `wall_time_ms` (default 5m), `max_steps_percent` / `context_tokens_percent` (default 50%), plus fixed
  batch max 4 and depth 1. Writes `$QI_HOME/config.toml` and hot-applies to the next `delegate` Action.

- Plan-mode parallel depth-1 research: `delegate` accepts `tasks[]` (1–4) via `runDelegatedBatch`; `/tasks`
  tracks Subagent research (Enter opens child projection). Children keep explore tools and gain `fetch` /
  `web_map` when the parent has network. Default child budgets are 50% of parent context/max-steps, 5-minute
  wall clock, and `maxUses = childMaxSteps × maxActionsPerStep` (ADR-0035).

- Cursor-style Subagent briefs: `delegate` accepts optional `focus[]` / `returns[]` / `constraints[]` (per task
  or top-level). Qi expands them into a Focus / Return / Constraints child prompt (research defaults fill gaps);
  `/tasks` detail shows the full brief from the child Run input.

- Web workbench Subagent Tasks pane: selected Run lists depth-1 delegations (title, status including
  `timed_out`) with Open-child to load the child Session read-only; live via `delegation.created` /
  `delegation.returned`.

- Read-only `artifact_get` tool: load Artifact store content by `artifact://` ref (delegate `resultRef` /
  `summaryRef`). Workspace `read` rejects `artifact://` with a clear error.

- `web_map` network tool: discover a bounded same-origin URL list from `sitemap.xml`, text/plain `llms.txt`,
  `robots.txt` Sitemap lines, or HTML anchors (including nav). Registered with `fetch` under the network
  capability; same public-DNS / no-credentials boundary. Prefer `web_map` before batching `fetch` on docs sites.

- Statusline and `/context` surface provider prompt-cache hit rate as `CH%`
  (Run-cumulative `sum(cachedInputTokens)/sum(inputTokens)`; `/context` also shows the latest Step). See
  ADR-0034.

- Settings → Providers → **Add OpenAI-compatible provider**: enter name, API key, base URL, wire API
  (`chat.completions` / `responses`), thinking dialect / Chat output field, plus separate **Model ID**,
  **Context window**, and **Output reserve** fields (token counts accept `256k` / `32k`), then write
  `$QI_HOME/providers/<name>.toml` and seal the key for that provider id. Extra models can be added by
  editing the TOML.

- Qianwen AI Token Plan provider (`qianwenai`): OpenAI-compatible host
  `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` with `QIANWENAI_API_KEY`, default model
  `qwen3.8-max-preview`. Qwen models use Responses (`reasoning.effort`); `glm-5-2` / `deepseek-v4-pro` use
  Chat Completions (`enable_thinking`). Token Plan `sk-sp-…` keys must not be mixed with DashScope
  pay-as-you-go hosts. See ADR-0009 / provider-adapters.
- Volcengine Agent Plan provider (`volcengine-agent-plan`): Responses wire to
  `https://ark.cn-beijing.volces.com/api/plan/v3` with `ARK_API_KEY`, default model `glm-latest`, catalog
  models including `glm-5.2` / `ark-code-latest` / `doubao-seed-2.0-code` (effort `low`/`medium`/`high`) and
  no-thinking models `minimax-m2.7` / `kimi-k2.6` / `kimi-k2.7-code`. Enabled thinking sends
  `thinking: { type: "enabled" }` plus `reasoning: { effort }`; `none` sends `thinking: { type: "disabled" }`.
  Output reserve maps to `max_output_tokens`.
- DeepSeek V4 Flash Responses adaptation: `deepseek-v4-flash` uses the Responses wire API with 1M context,
  effort thinking (`low`/`high`/`max`), and no image/`metadata` fields; `deepseek-v4-pro` stays on Chat
  Completions until the vendor supports Responses. Portable `{ type: "reasoning" }` parts echo committed CoT
  on same-Run tool-call turns so thinking-mode tool continuation does not 400. See ADR-0005 / ADR-0009.
- Session-local 追寻: optional `run.triggered.goalBinding` / `trigger: "goal"`, TurnLoop Goal ContextBlock and
  attempt/token budget accounting, portable `settleGoalBoundTurn` after Goal-bound Runs, and CLI `/goal`
  (plan-like: `/goal <objective>` creates and starts; bare `/goal` opens a status + actions hub including
  human Accept). Model stop cannot complete a Goal; unfinished Goals block Session archive and
  `/reset-workspace`. See ADR-0033.
- Machine-readable baseline/candidate prompt evaluation metrics and `accept:compare-prompts`, with zero-tolerance
  gates for forbidden Actions, test tampering, and false completion.
- Settings and `/max-steps` alias for the existing Step budget; the selected value persists to user config and
  hot-applies to the next Run.
- Settings and `/max-actions-per-step` for the per-Step Action batch limit; persists `max_actions_per_step` to
  user config (1–32, default 6) and applies on the next Run.
- Read-only `git` tool operations: `log` (bounded oneline), `rev-parse`, `show` (metadata + stat), `branch`, and
  `remote`, still under read authority so Ask/Plan can inspect history without execute.
- `qi_session_inspect` `operation=recovery` returns one bounded projection for the newest interrupted
  (or fallback completed) user Run — status, terminal fields, `imageAttachments`, last Step, and problem
  Action summaries — so continue-after-failure does not require chaining runs/steps/actions.

### Changed

- Background ProcessTask operator surface renamed from `/tasks` to `/jobs` (statusline `jobs N`, Web “Background
  Jobs”). `/tasks` now lists Subagent research Tasks. Protocol events remain `task.*`; the model tool stays
  `task`. Old `/tasks stop` prints a redirect notice (ADR-0035).

- Subagent return path: `resultRef` keeps the full child deliverable (capped); `summary`/`summaryRef` stay short
  previews. `delegate` describes the child envelope, injects budget into the child brief, and `parentHint` steers
  parents to `artifact_get(resultRef)` / `contextRefs` instead of truncation-driven extract fan-out (ADR-0035).

- TUI timeline Tasks block collapses to a count header (plus currently running rows); finished Subagent detail
  stays on `/tasks`.

- `qi_session_inspect` surfaces Subagent Tasks: `operation=delegations`, Run `delegationCount` /
  `delegationFacts` (detail lists refs), recovery `problemDelegations`, and `delegate` Action detail with
  `resultRef` / `summaryRef`. Guidance steers parents to `artifact_get(resultRef)` instead of child
  `last-step` modelText.

### Fixed

- Live TUI now receives parent `delegation.created` / `delegation.returned` while `delegate` is still running
  (Coordinator forwards `onEvent`). Previously `/tasks` could show “no Subagent tasks” and the timeline omitted
  the Tasks block until the Action settled, even though Web/store already had child `fetch`/`web_map` work.

- Child wall-time expiry now settles as `timed_out` (not `cancelled`). `delegate` returns per-child `outcome`
  plus a `parentHint` so the parent integrates partial summaries instead of treating the fan-out as a user
  cancel; the TUI card shows `! … timed out` rather than `✓ … rejected`.

- `fetch` HTML responses now include an optional bounded same-origin `links` list (url + anchor text) extracted
  before nav/header/footer/aside stripping, so sidebar directories remain available without flooding page `content`.

- TurnLoop lays out each Step as stable prefix → append-only conversation → control trailer so automatic
  provider prompt caches (DeepSeek V4 Flash and similar) can retain long prefixes across Steps. Work Plan,
  Goal, and budget warning/handoff move to a user-role trailer that freezes after first inclusion in the Run
  (live status/`consumed` updates do not rewrite it); optional Memory/Skills freeze after the first compile.
  See ADR-0034.

- CLI and `qi-web` first paint no longer full-replay every Session for catalog/recovery: `peekLifecycle` and
  cheap `listSessions`/`listCatalog` read lifecycle (and `session.created` titles) from SQLite without building
  `SessionView`. CLI `SessionRepository.recover()` only fully loads `*_pending` Sessions; project Memory uses
  deferred incremental catch-up instead of wipe-`rebuild` on every launch; container runtime probe no longer
  blocks TUI start. `qi-web` `/workbench` omits the raw `events` array (`eventCount` instead); Audit loads
  `/history` lazily.
- `/model` save scope labels: **User default** (persist to `~/.qi/config.toml` + sealed credential) vs
  **Current Session only** (apply without changing config), instead of the ambiguous “Account default”.
- Provider catalogs are declarative JSON under `@civaapple/qi-ai` (`src/catalog/`). Wire thinking dialects
  (`ProviderWireHints`) drive Chat Completions / Responses field shapes without `profile.id` branches.
  Operators may overlay or add providers via `$QI_HOME/providers/*.toml` (or `*.json`); same `id` merges onto
  built-ins. Catalog fields cover context window, output reserve, modalities, thinking mode / efforts /
  `allowDisable`, and optional `modelDiscovery = "openai_compatible"` for `GET /models` (authority for
  thinking/effort remains on the catalog). See ADR-0009 / provider-adapters.
- Qianwen Token Plan third-party models use Chat Completions on the Token Plan host: catalog id is
  `glm-5-2` (not `glm-5.2`, which Responses rejects as unsupported), and `deepseek-v4-pro` follows the
  same Chat Completions path with `enable_thinking` / `reasoning_effort`. Qwen models stay on Responses.
- TUI Ctrl+O expands truncated assistant model output before Thinking when both are collapsed on the
  latest Step, and an expanded Step shows the full assistant text from the start instead of another
  tailed window that still hid the report intro. Ordinary long replies now preview from the head at
  Formal Plan scale (200 rendered lines on a terminal Step; 48 mid-Run); only length-boundary CoT dumps
  keep the old 8-line truncated tail.
- Shared reasoning-effort normalization treats `medium` as its own level (no longer aliased to `high`).
  Providers whose catalogs omit `medium` (Kimi K3, DeepSeek V4) still fall back to the model `defaultEffort`
  on the wire when an unsupported level is selected. Session `session.model.configured` accepts `medium`.
- Kimi Code model support aligns with the current Code catalog and Chat Completions contract: K3/K3-256k
  advertise `low`/`high`/`max` effort (default `high`) and send top-level `reasoning_effort`; K2.7 Code models
  keep thinking always on with `thinking.keep=all`. Authenticated `/model` and login forms may refresh the
  model list via `GET /models` and merge it with the static catalog (thinking/effort authority stays catalogued).
- Failed `git` Actions show the full request (`git status · ref HEAD`, `git diff · maxCount 5`) plus the
  validation message in the TUI card and Web target/result, not only `INVALID_GIT_ARGUMENT`.
- TUI statusline shows the effective thinking effort between model and context % (for example
  `deepseek/deepseek-v4-flash · high · 3%`); `/model` and login syncs refresh the footer without restart.
- TUI statusline and `/model` show the selected model's wire API (`responses` / `chat.completions`) so
  mixed-wire providers such as Qianwen Token Plan make the active transport obvious. FormPanel
  descriptions wrap across lines (provider / wire / endpoint) instead of truncating a single long row.
- Plan and Agent (rich TTY) may use in-Run `ask_question`; Ask mode still omits it. Agent mode guidance treats
  structured cards and freeform assistant questions that stop for the next user turn as equally valid
  clarification. `plan_document` remains Plan-only. See ADR-0011.
- Plan and Agent may use `update_plan` Work Todos for multi-step focus (research, drafting, execution, Goal
  slices); Ask still omits it. Snapshots may revise/add/drop items or create a fresh Work Plan for a new slice;
  unfinished Work Plan navigation ContextBlocks inject for Plan and Agent. Work Plans remain navigation only,
  never Goal evidence. See ADR-0011 / ADR-0032.
- `/sessions` shows fewer entries by default (about 3–5, capped at 5) so the multi-line Session cards
  no longer fill a typical TUI height; ↑↓ still scrolls the full list.
- `max_steps` range is now 8–1000 (was 8–100). `/max-steps` and Settings presets are
  16 / 32 / 64 / 100 / 200 / 500 / 1000; TOML and `--max-steps` still accept any integer in range.
- Per-Step Action batch limit is configurable: user `max_actions_per_step` (1–32, default 6), Settings /
  `/max-actions-per-step` presets 2 / 4 / 6 / 8 / 12 / 16, persisted to `~/.qi/config.toml`.
- Provider profiles may override wire API per model (`resolveProviderWireApi`); DeepSeek defaults to Responses
  for Flash while Pro remains Chat Completions. CLI `/login`, config `reasoning_effort`, and `QI_REASONING_EFFORT`
  accept DeepSeek as well as Kimi.
- DeepSeek V4 catalog models recommend a 65,536-token output reserve (thinking shares `max_output_tokens`), so
  the CLI no longer parks high-effort Flash/Pro turns on the generic 16k length boundary as readily.
- `/model` shows and edits **Max output tokens** (output reserve). Account save writes `output_reserve_tokens`
  to `~/.qi/config.toml` (still hard-capped at 1/8 of the context window; catalog default when unset).
- `edit` accepts multi-hunk `edits[]` matched against the original file snapshot in one atomic write (with
  freshness `expectedSha256`), limited fuzzy matching for trailing whitespace / smart quotes / dashes, and
  `EDIT_TARGETS_OVERLAP` for nested hunks. Legacy top-level `oldText`/`newText` still normalize to one hunk.
  Same-Step edit→edit hash rebase remains a fallback; prefer one multi-hunk call. See ADR-0003.
- Goal `attempts` default to the Session `maxSteps` at create time; TurnLoop charges an attempt only for
  Goal-bound Steps that propose a non-`read` Action (research/read Steps no longer burn the envelope). TUI
  handoff distinguishes Goal attempts exhaustion (`/goal` Continue) from Session Step budget parks.
- `/goal` hub adds Re-evaluate… (human pass/fail/unknown → Evidence Ledger), richer Goal/Ledger observation in
  hub status and TUI status tags, and Web Contract/Knowledge read-only Ledger gap projection; Formal Plan and
  Work Plan remain orthogonal and are never auto-created by Goal.
- `/goal` hub **Continue** starts the next Goal-bound Run immediately; **Continue with guidance…** is a separate
  optional form when corrections should become the next Run input (`continueGoal(guidance)`).
- Session-local 追寻 settlement is portable (`settleGoalBoundTurn`); CLI surfaces post-Run Goal notices; Session
  resume demotes `active` Goals to `paused`; `/goal` hub Accept records human evidence toward verified complete
  (acceptance note optional; fail/unknown re-evaluate still requires rationale); Goal ContextBlock states
  bounded-slice / non-narrative completion discipline.
- CLI model context is now assembled as deterministic policy, mode, capability, host, Workspace, Memory, and
  per-Skill blocks. Required policy and advertised Tool schemas reserve budget before whole restored turns;
  one conservative Unicode-aware estimator accounts for blocks, messages, framing, and schemas.
- Accepted Memory enters the model as one bounded user-reference block instead of naked system claims, while
  Skill metadata is independently omittable behind a stable progressive-discovery hint.
- Consecutive Session Runs restore interrupted (`failed` / `cancelled` / non-budget `parked`) final assistant
  narrative in `<qi-interrupted-run>` (media still prefers `<qi-interrupted-media-run>`), surface
  `olderTurnsOmitted=<N>` when history budget drops earlier turns, and inject an unfinished Work Plan
  navigation ContextBlock for Plan and Agent Runs. `update_plan` omitting `workPlanId` while supplying known
  `workItemId` values continues `currentWorkPlanId`. Formal Plan executors remain `historyBudgetTokens: 0`.
  See ADR-0032.
- `qi_session_inspect` guidance now treats restored conversation history as the default continue path and
  reserves inspection for lifecycle diagnostics (`recovery` preferred over chained runs/steps/actions).
- FormPanel dropdowns start collapsed (current value only); ↑↓ move between fields, ←→ cycle options while
  collapsed, Enter expands fixed-choice lists then advances/submits, and Esc collapses an open dropdown before
  closing the panel.
- `/model` is panel-only: invoke it without slash arguments and configure model/thinking effort in the form
  instead of using the removed argument / `--session` path. `/status` is promoted to primary and removed from
  the settings hub.
- `/settings` hub item labels use the English slash/command names (`/mode`, `/permissions`, `/shell`, …);
  Chinese remains only in descriptions.
- `/settings` no longer links to Session runs history; use `/runs`, `/sessions`, or `/status` instead.
- `/steps`, `/actions`, and `/agents` slash aliases removed from help and autocomplete; use the `/runs` hub
  (typing the old names redirects there with a notice).
- `/runs` Run selection opens Steps or Agents directly when only one kind exists; a two-item chooser when both
  exist; Actions are reached only via Step selection (not from the Run menu).

### Deprecated

### Removed

- Standalone `/effort` command; open `/model` (or a login form) to configure thinking effort.

### Fixed

- `$QI_HOME/config.toml` accepts provider ids from the installed catalog (including
  `$QI_HOME/providers/*.toml` overlays such as `stepfun`), not only the built-in allowlist. Login /
  `/model` user-default persistence no longer fails with `provider must be one of openai, xai, …`.
  Overlay providers with thinking wire hints may also persist `reasoning_effort`.
- Length-truncated model turns (thinking exhausting `max_output_tokens`) no longer flood the interactive
  transcript with a wall of CoT/`text`; the TUI keeps Thinking collapsed and shows a short truncated
  tail unless the Step is expanded. Live `model.reasoning` activity stays in the Working strip only.
- Edit/write TUI cards show the full Workspace-relative path instead of only the last two segments, so they
  match `read` discovery paths when diagnosing `EDIT_TARGET_NOT_FOUND`.
- Absolute paths under the Workspace (and authorized read mounts) are rewritten onto the authorized root for
  shell/script `workdir` and ordinary file Tools, so model-supplied `D:\\…` / `/…` workdirs no longer fail with
  `PATH_OUTSIDE_WORKSPACE` before spawn; paths outside those roots still deny.
- Windows `cmd` script-profile temp `.cmd` files re-encode non-ASCII script text to the process ANSI code page
  before cmd.exe runs them, so Chinese `git commit -m` messages are no longer mojibaked; `host:environment` on
  Windows also steers agents to prefer argv `shell` or `git commit -F` for non-ASCII commit messages.
- Plan-mode Formal Plan guidance and `host:environment` now keep the argv-only `shell` tool separate from
  probed `script` profiles, so executor-background prose must not claim pwsh/cmd/bash are unavailable when
  those profiles are listed as available.
- Parallel `read_image` (and other tool-result image) batches no longer insert synthetic user media
  between `role=tool` responses on Chat Completions / Responses, which previously caused provider 400s
  (`tool_calls` without a matching `tool_call_id`, e.g. `read_image:1`).
- Follow-ups after an interrupted image Run (for example “继续”) restore the prior clipboard/path/URL
  attachments in conversation history, and `qi_session_inspect` now surfaces `imageAttachments` /
  `originalArtifactRef` so recovery uses `read_image` instead of searching mounts for the same screenshot.
- Image-capable models now ingest local Workspace/mount image paths (and absolute paths under those roots)
  as ordered `path` image parts instead of leaving a bare path for the model to mis-route through `fetch`.
- Rich TTY image paste uses `Alt+V` on Windows (kimi-code parity) because terminals often own `Ctrl+V`, and
  also accepts a clipboard file-path / `file://` URI that points at a PNG/JPEG/GIF/WebP file.

### Security

- Write-capable Agent and Plan Runs fail closed on a present unsafe root `AGENTS.md`, read-only mounts no longer
  disclose absolute host paths to the model, and Workspace/Memory/Skill envelopes explicitly cannot grant
  capability or completion evidence.
- Updated the direct `sharp` dependency to `0.35.3`, bringing the bundled libvips security fixes into the release.

### Documentation

- ADR-0009 / provider-adapters / CLI README: custom OpenAI-compatible providers via `$QI_HOME/providers` (Settings
  add-provider form), `config.toml` accepting installed catalog ids (not a fixed allowlist), `/model` user-default
  vs Session-only save scope, and `model_discovery` remote merge semantics.
- Document Volcengine Agent Plan login/config, Responses deep-thinking wire shape, and `medium` effort semantics
  in root README, CLI interaction model, provider adapters, and ADR-0009.
- CLI and agent docs: Plan/Agent clarification via `ask_question` or freeform next-turn questions; Ask still
  omits the tool; Goal Continues inherit Session mode (ADR-0011).
- CLI and agent docs: Plan/Agent Work Todo (`update_plan`) for focus across research and Goal slices; successive
  plans and item revise/add/drop; still not Formal Plan or Evidence Ledger (ADR-0011 / ADR-0032 / ADR-0033).
- Web README and analyze-qi-session skill: Work Todo / ask_question cards are tool-keyed (Plan or Agent); Web
  stays read-only for in-Run Questions.
- CLI interaction-model / README and TUI README document `max_actions_per_step`, `/model` max output tokens
  (`output_reserve_tokens`), compact `/sessions`, Goal Accept optional notes, and length-truncated Thinking
  display bounds.
- Added the CLI model-context composition, precedence, disclosure, and omission contract plus normalized
  Ask/Plan/Agent prompt goldens.
- Corrected the self-model and protocol compatibility links to the current ADR-0014 heading.
- Aligned the public README and design contracts on the 0.7.0 layout boundary, pre-stable persistence policy,
  exact authorized Tool reads versus sealed Qi-managed credentials, K3 `max` effort, and the not-yet-productized
  追寻 / 守望 experiences.

## [0.7.2] - 2026-07-30

### Added

- `/shell` (and Settings → Shell) multi-selects global shell profiles (`direct` / `pwsh` / `cmd` / `bash`),
  persists them to `$QI_HOME/config.toml`, and hot-applies tools/leases without restarting the CLI. First launch
  without `[shell]` probes platform-installed profiles and writes defaults automatically.
- `/exit` is an alias for `/quit` in rich TTY and line mode.
- `/context` now shows per-ContextBlock-kind included token share, included/omitted counts, omitted estimated
  tokens, and a separate conversation/Tool-schema subtotal from replayable aggregate Session facts.
- Added end-to-end image input for Kimi K3 and other image-capable models: rich-TTY clipboard paste, safe image
  URL ingestion, bounded preprocessing, content-addressed original/prepared Artifacts, ordered Session replay,
  and an authorized `read_image` crop/detail Tool.
- Project layout version 2 is a pre-stable development clean break that stores each Session as a self-contained
  directory under `sessions/<session-id>/` (event DB, Effect Journal, Artifacts, Plans, Tasks) with recoverable
  hard archive under `archives/`, plus `/sessions` Active/Archived views, `/reset-workspace`, and Kernel lifecycle
  events (`session.archive.*` / `session.restore.*`).
- Workspace `@path` autocomplete validates mentions before submit; slash commands may preserve a multi-line draft
  on the first editor line (`draftPolicy`), and `/model` / `/effort` reconfigure routing without re-entering secrets.

### Changed

- Same-Step `BATCH_WRITE_CONFLICT` now applies only to overlapping `file:*` / `artifact-store:*` mutations.
  Host execute resources (`host-process:*`, `host-workspace:*`, `shell-profile:*`) no longer conflict, so
  sequential `shell`/`script` Actions may share a workdir in one Step. File edit freshness rebasing is unchanged.
- Session lists (TUI `/sessions` and qi:web) now show a truncated first user message as the title when the
  Session still carried the bootstrap `Qi TUI` placeholder; later messages and `›` previews are unchanged.
  Explicit non-bootstrap `session.created` titles are preserved. SQLite `listSessions` reads the projected title
  instead of only `sequence = 1`.
- Kimi K3 now advertises its 1,048,576-token window, image input, `max`-only thinking effort, and `max` default.
  Legacy K3 low/high effort settings fall back to `max`; custom OpenAI-compatible endpoints remain text-only
  unless their `[[compatible]]` entry sets `image_input = true`.
- Chat Completions and Responses adapters now map ordered user media and tool-result images without persisting
  provider data URLs. Image context cost uses dimensions rather than base64 length.
- Agent Runs now receive an explicit Workspace Write permission fact. When Write is disabled, the model is told
  to request `/permissions` instead of using machine-private Artifacts as a substitute for project files.
- Legacy shared project `state/qi.sqlite` / root-level artifacts layouts are left unchanged and rejected without
  automatic migration. Back up and reset that private data or select a new data root; Web and session analysis
  resolve supported Session databases under `sessions/` then `archives/`.
- Rich TUI welcome and line-mode startup headers show the complete complementary `Permissions enabled` /
  `Permissions disabled` partition after `--safe`, config, and CLI overrides.
- ADR-0001 now gates sensitive Workspace paths with human content grants instead of rewriting source-code
  assignment forms before they reach the model; authorized file bodies round-trip for precise `edit`.
- Host-execute guidance prefers one `script` Action for builtins/pipes/multi-statement logic, while allowing
  multiple sequential `shell`/`script` Actions that share a workdir in one Step.
- Shell profiles are user-global only under `$QI_HOME/config.toml`; project `policy.toml` `[shell]` is no longer
  merged into launch authority (ADR-0015). Move project profile selections to `/shell` or the user config.

### Fixed

- Composer `@` mention validation no longer blocks submit when the token is an absent npm-style
  `@scope/package` (for example `@memo/shared-types`); real missing Workspace paths still fail closed.
- Indeterminate-effect parking now carries tool name and Action evidence in `run.parked.detail`, and the TUI
  handoff/tool card surfaces that reason plus explicit no-auto-retry guidance instead of only
  "Tool settlement could not be confirmed".
- Missing or non-directory shell/script `workdir` paths now settle as deterministic `ToolFailure`
  (`PATH_NOT_FOUND` / `NOT_A_DIRECTORY`) instead of parking the Run with an indeterminate effect.
- Plan-mode `ask_question` panels now hard-wrap long CJK prompts by display column width so rich-TTY rendering
  no longer crashes with `Rendered line exceeds terminal width`.
- `/config` cmd profile versions no longer show OEM-codepage mojibake from localized `ver` output; the probe keeps
  an ASCII `Windows <build>` label.
- Distinguished Workspace mutations, Artifact persistence, and other write effects in bounded Session inspection
  while retaining the legacy aggregate counters. Artifact puts now use digest-scoped resources, so independent
  content-addressed writes no longer produce false `BATCH_WRITE_CONFLICT` failures in one Step.
- Fixed rich-TTY multiline user messages so one message receives one top/bottom background pad instead of adding
  padding around every logical line.
- Clarified Web context omissions with their block category and made Artifact-vs-Workspace effects explicit in
  the Run contract instead of presenting every non-read Action as an undifferentiated write.

### Security

- Authorized ordinary Tool content no longer applies a shape-based rewrite to `Authorization: Bearer` strings in
  Session events, Tool feedback, or model context, so source and request examples round-trip exactly. Qi-managed
  provider/OAuth credentials remain sealed and never enter those surfaces; provider tokens, PEM private-key
  blocks, and URL userinfo remain redacted. Historical `safety.redaction.applied` facts with kind
  `authorization` stay valid.
- Sensitive Workspace paths (for example `.env`) now require an explicit human grant before file bodies reach the
  model. Project `sensitive_path_grants` / `[sensitive_paths]` load at CLI startup, rehydrate as Session audit
  facts, and drive a Ctrl+G allow/deny panel on `SENSITIVE_PATH_GRANT_REQUIRED` without collapsing into mount
  `PATH_GRANT_REQUIRED` flow. Authorized reads return raw text so precise `edit` can round-trip; assignment-style
  content redaction (for example `password: &str`) no longer rewrites source for the model.
- Image URLs use the existing DNS-pinned public-network boundary with independent byte limits, MIME plus
  magic-byte verification, HTTPS downgrade prevention, and Network capability enforcement. Image bytes and data
  URLs never enter Session events or SQLite.

### Documentation

- Added ADR-0028 and synchronized protocol, Agent, AI, Node, TUI, and CLI contracts for image ingestion,
  Artifact materialization, replay recovery, model capability gating, and the deferred video boundary.
- Added ADR-0029 for the Workspace-mutation versus private-Artifact boundary, digest-scoped Artifact resources,
  permission preflight, and separated diagnostic write counts.
- Source-release dependency inventory now reviews sharp optional platform packages that ship libvips under
  `LGPL-3.0-or-later` (including Apache/MIT compound SPDX expressions).

## [0.7.1] - 2026-07-29

### Added

- Added end-to-end Memory capture and management: structured Session/Project/User scopes, provenance-backed
  `memory` proposals, `/memory` rich and line-mode lifecycle commands, explicit User promotion/pinning, and
  read-only Web provenance/usage audit.
- Added machine-wide local-user continuity under `$QI_HOME/state`, transactional/versioned Memory indexes,
  exact-scope and CJK retrieval, activation limits, and startup projection recovery.
- Session extract reports may emit `CLAIMED_MUTATION_WITHOUT_ACTIONS` when a responded Run claims a Workspace or
  Formal Plan mutation in prose without any completed write Action, and
  `RESERVED_RUN_FACTS_IN_MODEL_OUTPUT` for legacy internal fact tags committed as model text (diagnostic only;
  Run completion is unchanged).

### Changed

- Unified the TUI into a bounded committed timeline, provisional live strip, and protected control region.
  `standard` is the default of three timeline densities; consecutive same-Step read-only exploration groups
  after settlement, successful process output collapses on completion, exceptional evidence remains visible,
  and older Runs move behind the searchable `/runs` History Center.
- TUI committed facts and in-memory/SQLite Session projections now update incrementally with cold-replay
  fallback. Composer/activity ticks do not scan EventStore history, and process-local caches are discarded on
  discontinuity, failed validation, or transaction rollback without changing Session events or the database.
- Human gates no longer steal focus from a non-empty composer or follow-up editor. A persistent notice points to
  `Ctrl+G`, which opens Run Question → Plan Review → Next Run → path grant in priority order.
- Qi themes now use compatible semantic aliases and degrade through truecolor, ANSI-256, basic ANSI, and
  `NO_COLOR`; state glyphs and labels remain meaningful without color.
- Memory capture and retrieval now default on for new Runs without historical conversation backfill. Project
  claims remain project-local; only explicitly confirmed User claims cross projects. Context compilation
  considers at most 12 optional Memory blocks and records actual inclusion/omission through existing block IDs.
- `qi_session_inspect` / `inspectQiSession` and extract-session `--all` now surface Formal Plan short titles and
  bindings, Work Plan snapshots, bounded `modelReasoning`, write/read `actionFacts`, and file-vs-Git diff / process
  summaries; `analyze-qi-session` Skill 1.3.0 documents those diagnostic fields.
- Web Run Narrative now projects committed model reasoning as a Thinking block, shortens Accepted Formal Plan
  titles via `planBinding` metadata (with a bounded Formal Plan preview), and renders specialized cards for
  Work Plan todos, AskQuestion, process output tails, and file-mutation diffs instead of a generic Workspace
  diff fold for every Action.
- TUI `update_plan` Work Plan cards now keep a full ✔/◐/○ Todo list in the chat stream (including mid-Run
  collapsed Steps), with a `Working on N to-dos · M/N done` header instead of a one-line summary.
- Live `shell`/`script`/`verify` tails and failed cards keep up to three bounded evidence lines; settled successes
  collapse to one command-and-duration line unless expanded or shown in diagnostic density.
- Restored cross-Run conversation history now supplies only a local turn ordinal and coarse write settlement class
  in a Runtime-owned system ContextBlock. Durable IDs, Action/read counts, terminal details, paths, and tool
  payloads remain outside automatic model context and are available only through bounded introspection.
- Agent constitution and mode guidance now state that minimizing investigative tool calls does not skip
  `edit`/`write`, and that planned code blocks are not proof of a durable Workspace mutation.
- Executor timelines now render accepted Formal Plans as at most 200 terminal lines without paste
  classification; every preview shows the immutable local path, and longer plans add a Collapsed notice while
  Executor context remains complete. Live model reasoning keeps three display-wrapped lines; settled standard
  density uses an expandable `Thinking · duration` summary with the same bounded excerpt.
- Choice questions in Plan-mode `ask_question` now offer custom `Other…` input by default unless explicitly
  disabled, and confirmed timeline cards retain every question and option with selected, custom, or skipped
  results.
- Formal Plans now appear in the timeline, bounded to 200 rendered lines with their immutable local path, before
  the Plan Review choices are offered.

### Deprecated

### Removed

### Fixed

- Fixed Formal Plan drafting completion so a read-only `plan_document` Action cannot masquerade as a new
  revision; the Run now requires a completed write-effect create/edit before offering review.
- Removed legacy `<qi-run-facts>` tags from restored and committed assistant text so models cannot multiply or
  fabricate internal Session metadata in the visible timeline.
- Made the `plan_document` function parameters compatible with Moonshot/Kimi JSON Schema validation while
  preserving strict per-operation field checks inside the Tool.
- Fixed failed `plan_document` cards so ToolFailure envelopes show the operation, error code, and message instead
  of a nonexistent `rev undefined`.
- Fixed first-call `update_plan` loops by replacing model-supplied provisional Work item IDs with Runtime IDs;
  nonexistent update IDs now return explicit create/update guidance, and failed Todo cards show that reason.

### Security

- Credential-like Memory is rejected before source or candidate persistence, model-provided scope identifiers
  are ignored, and Agents cannot accept, promote, activate, correct, or forget User Memory.

### Documentation

- Added ADR-0027 for Interaction Timeline hierarchy, density, attention, long-session bounds, and incremental
  projection rules; updated the TUI/CLI and storage contracts.
- Documented Memory scope, storage, lifecycle, recovery, CLI/Web behavior, and corrected the
  `SqliteMemoryIndex` import path.

## [0.7.0] - 2026-07-28

### Added

- Added Formal Markdown Plan revisions, immutable SHA-addressed Plan documents, Agent-only `update_plan` Work
  Plans, and Plan-only in-Run AskQuestion with single/multiple/text/custom/skip interaction.
- Added declaration-only plugin contracts and `qi install/update/remove/list` for exact npm, pinned Git, and
  digest-pinned local sources. Installation never runs npm lifecycle scripts and publishes validated content to
  the shared content-addressed package store.
- Introduced `$QI_HOME` layout generation 2 for the 0.7.0 source milestone, with canonical realpath-hash project
  IDs, private `state/` databases, project descriptors, Web discovery, and strict private-root safety checks.
- Added `prewarmTrustedExecutables()` to `@civaapple/qi-node/tools`, priming common PATH-resolved executables for the
  detected language stack (Node.js, Maven) at CLI startup so the first `search`/`find`/`shell`/`script`/`verify`
  call does not pay PATH-walk latency.
- Added `outputRef` to `shell`, `verify`, and `script` Tool output: when a run's stdout/stderr is truncated for
  model-context reasons, the complete stream is stored as a content-addressed Artifact and referenced instead of
  being discarded.
- Added a `codeact` Tool (under the existing `execute` capability) that runs a short generated program inside a
  network-off, read-only-root container; every nested `api.call` still passes through the normal Tool Registry,
  capability authorization, and Session event lifecycle. It registers only when `probeContainerRuntime()` from
  `@civaapple/qi-node/codeact` finds a responding `docker` or `podman` on the host.
- Added `ContainerProgramSandbox` support for inline `programSource` (in addition to `programFile`); the sandbox
  owns staging and cleanup for both, so callers never manage an ad hoc temp-file location themselves.
- Added `allowedTools` to `ControlledToolClient`: nested CodeAct tool calls outside the allowlist fail closed as
  `TOOL_NOT_ALLOWED` before any inspection or Session event.
- Added a guided `/verify` setup wizard: `scanVerificationCandidates()` (new in `@civaapple/qi-node/tools`) proposes
  verification commands from `package.json`, `pom.xml`, `AGENTS.md`, and `README.md`; a human confirms the
  selection in a `MultiSelectPanel`, and `writeVerificationManifest()` writes `.qi/qi.verify.json` through the
  same atomic-write and `loadVerificationProfiles()` validation path used by automatic inference.
- Added model-level Kimi Code profiles for `k3`, `k3-256k`, `kimi-for-coding`, and
  `kimi-for-coding-highspeed`, including 1M/256K context windows, K3 effort normalization, K2.7 thinking
  toggles, and streamed reasoning output.
- Added Kimi `reasoning_effort` user configuration, `--effort` launch override, and
  `KIMI_MODEL_THINKING_EFFORT` / `QI_REASONING_EFFORT` environment support.
- Added terminal dropdown fields with a final custom-input option, used by Kimi `/login` to select a known model
  or enter a future model ID while showing the effective effort and context-window defaults.

### Changed

- Accepting a new Formal Plan now atomically starts one whole-plan Agent Run with zero planning-history budget;
  Formal Plans no longer generate Todo items or `/next` gates. Legacy item plans keep their replay and `/next`
  behavior.
- `plan_document` is now a discriminated `create`/`read`/`edit` document tool with SHA freshness, atomic unique
  text patches, a 64 KiB limit, and rejection of detected secrets and Markdown task-list checkboxes.
- Consolidated 21 runtime publication units into the coordinated `qi-protocol`, `qi-ai`, `qi-agent`, `qi-node`,
  `qi-tui`, and `qi` CLI packages, with controlled subpath exports preserving cohesive module boundaries.
- Workspace `.qi` is now an allowlisted declaration/lock surface only. User Skills moved to
  `$QI_HOME/resources/skills`; project machine policy moved to `policy.toml`.
- `findTrustedExecutable()` now caches PATH resolution per command/Workspace root/PATH triple for the process
  lifetime, including in-flight de-duplication for concurrent lookups of the same executable.
- `TurnLoop` now authorizes and executes a Step's maximal consecutive runs of `read`-effect Actions concurrently
  instead of one at a time; write/execute/publish/spend effects remain strictly sequential, and model-facing
  tool-result feedback still preserves the model's original request order.
- Kimi Code now defaults to `k3`; without an explicit `context_window_tokens`, CLI context budgeting follows
  the selected Kimi model profile.
- Kimi API-key and device `/login` now persist the selected `model`, `reasoning_effort`, and editable
  `context_window_tokens` into user `config.toml` and apply all three to the live runtime without restart.

### Deprecated

### Removed

- Removed the 0.5 public package names and automatic reuse of 0.5 local data roots. Qi does not migrate or delete
  an old non-empty `$QI_HOME`.

### Fixed

- The active Working strip now retains the latest three model/tool stream lines; transient operator notices
  expire after four seconds and clear on the next submission, while Run outcome notices remain actionable.
- Terminal Markdown tables now wrap adaptively and fall back to vertical row fields on narrow screens instead
  of truncating long or right-side columns.
- Every Run now receives probed host-platform and shell-profile facts, including explicit Windows guidance and
  a same-Run rule against retrying an executable/profile assumption after the environment rejects it.
- `/tasks` now opens an interactive ProcessTask list where Enter stops the selected running task, terminal tasks
  are visibly disabled, and process-tree termination escalates after a bounded graceful wait.
- The Web workbench now keeps durable background ProcessTasks visible after their originating Run completes,
  refreshes their lifecycle over SSE, and reports command, PID, working directory, and expiry.
- Shell guidance now directs package-manager commands through the direct argument vector plus `workdir`, documents
  the Windows `NUL` device, and decodes identifiable UTF-16LE host diagnostics before bounded capture.
- Shell now validates executable paths and classifies malformed command strings and confirmed spawn-start errors
  as deterministic failures instead of parking the Run with an indeterminate effect.
- Shell and script children that explicitly disable color no longer inherit a conflicting `FORCE_COLOR` value
  that caused Node.js to emit a warning on stderr.
- Host-process children no longer inherit npm's lifecycle-exported `npm_config_allow_scripts`, so a Qi runtime
  launched through `npm run qi` can execute nested project-scoped npm commands without an ambient
  `EALLOWSCRIPTS` failure.

### Security

- Declarative package and `.qi` validation rejects secrets, executable/binary file types, path traversal,
  symlinks/junction escapes, oversize trees, lifecycle scripts, and same-layer resource ambiguity. Package
  registration never grants a Capability Lease.

### Documentation

- Documented six-package ownership, state/event responsibility, the generation-2 private layout, `.qi`
  boundaries, package trust flow, and executable-plugin deferral in the design map and ADRs.

## [0.5.1] - 2026-07-27

### Added

- Added configurable 8–100 Step budgets (default 32), a tool-free final handoff Step, and explicit
  `step.completed.finishReason = handoff` continuation history.
- Added digest-guarded Workspace Skill draft export/update through the dedicated Skill service, including sibling
  staging, backup, stale-draft detection, and indeterminate recovery markers.
- Added bounded Session/Run/Step/Action queries and the read-only `qi_session_inspect` Tool in
  `@civaapple/qi-introspection`, plus matching analyze-qi-session filters.
- Added `npm run verify:focused -- tests/<name>.test.mjs …` for build-once targeted iteration.
- Added bounded 1-based line-range reads whose freshness metadata continues to cover the complete file.
- Added durable, pre-authority freshness rebasing for safe same-Step `edit → edit` chains.

### Changed

- Development verification now favors affected tests during iteration, one full typecheck/test pass for
  cross-package completion, and package/CLI gates only when those surfaces change; releases still run all gates.
- Active TUI transcripts retain bounded Diffs for completed mutations in the visible eight-Step window.

### Deprecated

### Removed

### Fixed

- Plan/Ask mode Kernel projection now allows the read-only `qi_introspect` tool, matching capability mode
  policy. Previously a Plan-mode model call to inspect self-model sections failed the whole Run with
  `INVALID_MODEL_ACTION` / `MODE_TOOL_DENIED`.
- Ask/Plan mode tool or effect denials are recovered as `model.action.rejected` (`TOOL_INPUT`) feedback so the
  model can correct course. Kernel and capability mode allowlists are exported and lockstep-tested so dual-copy
  drift is caught in CI.
- Failed shell/script/verification cards now unwrap exit, stderr/stdout, timeout, and Workspace-change evidence
  from structured Tool failure details.

### Security

- Generic file tools continue to deny `.qi`, `.git`, and `.artifacts`; only the authorized, Effect-Journaled
  Skill service can update `.qi/skills`, and uncertain updates cannot auto-retry.

### Documentation

- Documented budget handoff recovery, Session self-inspection, and the Workspace Skill update boundary.

## [0.5.0] - 2026-07-27

### Added

- MIT licensing and public-package metadata for the CLI and 21 Runtime packages.
- Isolated package consumers, release-candidate auditing, and installable CLI preview checks.
- `@civaapple/qi-agent`, `@civaapple/qi-introspection`, and reusable `@civaapple/qi-tui` package surfaces.
- Provenance-bearing GitHub Actions publishing with a post-bootstrap migration to tokenless npm trusted
  publishing.

### Changed

- Renamed the application directory from `apps/tui` to `apps/cli`.
- Changed the installed executable to `qi`.
- Adopted `@civaapple/qi` for the CLI and `@civaapple/qi-*` for Runtime packages.
- Set `civaapple-alt/qi` as the canonical repository.
- Unified product identity, environment variables, local data paths, Session actors, evidence types, and public
  APIs under `Qi`, `QI_*`, `.qi`, and `qi.*`.
- Consolidated public design documentation around the current architecture, decisions, and roadmap.

### Deprecated

### Removed

- Removed the local Jekyll/Docker documentation site and chronological design/process documents from the public
  repository.

### Fixed

- Made CodeAct container staging paths portable across Windows, Linux, and macOS.

### Security

- Expanded ignored-file protection for local credentials, registry configuration, logs, Runtime artifacts,
  packed archives, and editor state.
- Kept the monorepo root private and metadata-only when packed accidentally.

### Documentation

- Replaced iteration-oriented notes with concise contributor-facing architecture and release documentation.
- Restored the foundational product vision around life-like continuity, human-Agent coexistence,
  同行/追寻/守望, and bounded Turn/Goal/Time/Proactive control.
- Added the Contributor Covenant and a private maintainer email as the security disclosure channel.

## [0.4.0] - 2026-07-24

### Added

- Append-only Session events, Kernel projection, SQLite persistence, committed SSE streaming, and crash recovery.
- Provider-neutral model adapters, bounded context compilation, credential handles, and secret redaction.
- Default-deny capability leases, typed Tool phases, precise file mutation, read-only mounts, Effect Journal
  settlement, and bounded ProcessTasks.
- Ask/Plan/Agent modes, durable Questions and Plan review, terminal UI controls, and a read-only Web workbench.
- Goal/evidence evaluation, provenance-backed memory, Skills, MCP quarantine, CodeAct, graph governance,
  depth-1 delegation, and bounded scheduling.
- CLI/package build, replay fixtures, deterministic tests, and live-provider acceptance harnesses.

### Changed

- Completion now distinguishes a model response, a terminal Run, and evidence-backed verification.
- Provisional model/process activity is observable without becoming durable Session truth.
- TUI transcript work is bounded through paint classification, caching, and reversible history folding.

### Security

- Authority grants and Action start facts persist before executor entry.
- Non-read effects use idempotent settlement and are never automatically retried when indeterminate.
- Protected Runtime/VCS paths remain outside ordinary Agent file authority.
