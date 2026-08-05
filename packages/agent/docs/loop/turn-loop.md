# Turn loop

`TurnLoop` is an event-producing coordinator. It advances one Run in discrete Steps and never treats in-memory
control flow as a substitute for durable lifecycle facts.

## Normal response path

```text
Run triggered -> Step started -> context compiled -> model streamed
-> assistant response committed -> Step completed -> Run completed or parked
```

## Action path

```text
model proposes Actions
-> validate advertised tools and inputs
-> request authority per Action
-> persist grant and `action.started`
-> execute and settle
-> persist tool results
-> complete Step
-> compile the next Step
```

Batch ordering may optimize safe execution, but each Action retains its own identity, authority, and settlement.
If one action becomes indeterminate, all siblings not yet started are explicitly settled before the Run parks.

Within a Step's Action batch, `TurnLoop` finds maximal consecutive runs of `read`-effect calls and authorizes and
executes each such run concurrently (`Promise.all`); `write`/`execute`/`publish`/`spend` calls, and any `read` call
that is not part of an all-read run, execute one at a time in the original order. Concurrent reads never consult
or mutate write-conflict or edit-freshness state, so this optimization is safe: the loop still returns model-facing
tool-result feedback in the model's original request order, independent of which read settled first. If any read
inside a concurrent batch is cancelled or becomes indeterminate, the whole batch is left to finish (it already
started), and only candidates strictly after that batch are denied and the Run stops with the matching status.

Models should prefer one multi-hunk `edit` (several `edits[]` against the original snapshot) over several
same-file edit Actions. As a fallback, after a successful edit a later same-Step edit of the same single
resource may be re-inspected against the latest digest when its proposed digest belongs to that edit chain.
The Loop appends `action.freshness.rebased` before requesting authority, and the Effect Journal sees the
re-inspected input. There is no oldText rewrite or overlapping-target merge: target and freshness errors stay
determinate failures, while mixed or unrelated same-resource `file:*` / `artifact-store:*` writes remain
`BATCH_WRITE_CONFLICT`. Host execute resources (`host-process:*`, `host-workspace:*`, `shell-profile:*`) do not
enter that conflict table, so sequential shells may share a workdir in one Step.

If an advertised tool's input fails schema validation, or Ask/Plan mode forbids the tool/effect after inspect,
the Loop records `model.action.rejected`, returns a structured `TOOL_INPUT` result in assistant source order, and
lets the model correct it in the next Step. No Action or authority request is created. An unadvertised tool remains
a Run-level fail-closed violation. Kernel `MODE_TOOL_DENIED` / `MODE_EFFECT_DENIED` at `action.proposed` is also
treated as recoverable model feedback rather than `INVALID_MODEL_ACTION`, so dual allowlist drift cannot kill the Run.

The same event carries `ACTION_BATCH_LIMIT` for advertised calls beyond the Step's deterministic batch envelope.
Allowed calls settle first; all tool feedback is returned in assistant source order so the next Step can reassess
instead of launching an unbounded speculative batch.

## Context between Steps

The next Step receives concise causal summaries and Artifact references rather than unbounded raw error logs.
Repeated equivalent failure fingerprints drive strategy change or convergence.

A settled Action exchange remains complete for the first following model request. Once consumed, the Loop may
archive its portable messages and replace them with a deterministic summary when working context crosses the
pressure threshold. If one newest exchange cannot fit at all, hard-limit compaction preserves its Action
identities, outcomes, locators, and Artifact reference before the request proceeds. Each replacement emits
`context.compacted`; it never rewrites the underlying Action or model events.

Prompt accounting uses one deterministic estimator for the advertised Tool catalog, portable messages, and
compiled ContextBlocks; Tool schemas and message framing are not free space outside the model window. Before
history selection, the Loop reserves current input, required policy/control, the maximum final-handoff control,
and the first executable Step's Tool catalog. Whole old turns therefore yield before required context instead of
causing an avoidable budget park.
Each successful compilation also persists bounded `blockStats` grouped by ContextBlock kind. These statistics
include selected/omitted counts and estimated tokens; conversation messages and advertised Tool schemas remain
separate non-block prompt cost so operator percentages cannot be mistaken for provider payload accounting.

Before provider entry, the complete portable message list passes through deterministic high-confidence secret
redaction. Tool results are sanitized before they become feedback, model output is sanitized before reuse or
rendering, and EventWriter repeats the guard before append. Every match emits `safety.redaction.applied` with
categories and counts but never the matched value.

## Provisional activity

Provider text deltas and bounded process snapshots may be published through `RuntimeActivity` after redaction.
Model channels also carry `estimatedOutputTokens` (approximate reasoning+text so far) so the TUI Working strip can
grow continuously before `model.completed` replaces the number with provider usage.
They are UI responsiveness hints only: consumers may coalesce or drop them, and they never become model feedback,
Action settlement, Session events, or completion evidence. The next durable model or Action event supersedes the
preview. See [ADR 0005](../../../design/decisions.md#adr-0005-keep-provisional-activity-outside-durable-session-truth).

## Context between Runs

A new user-triggered Run reconstructs completed conversational turns from the same Session as portable user and
assistant messages. Only the final response of a completed Run is normally restored. Each selected turn receives
one Runtime-owned, local ordinal and a coarse write settlement class: `none`, `completed`, `unsuccessful`, or
`mixed`. The block does not disclose durable Run/Action IDs, Action counts, reads, timestamps, paths, terminal
reasons, or tool payloads. It is a grounding signal, not proof of what changed or verified completion. It never
becomes assistant prose or a tool transcript, so later Runs can distinguish verbal “already fixed” narration from
settled writes without teaching the model to echo or fabricate internal markup. Legacy reserved
`<qi-run-facts … />` tags are removed from restored narrative and committed model responses. A budget-parked Run is
restored only when a Step explicitly completed with `finishReason: handoff`; the injected wrapper states that the
prior Run was paused, not completed. If the model produced no usable handoff, the Loop derives a deterministic
summary from durable Step/Action/Plan facts. Failed, cancelled, or otherwise parked Runs restore their final
assistant narrative inside `<qi-interrupted-run>` when one exists. Interrupted Runs that carried image
attachments prefer `<qi-interrupted-media-run>` so a follow-up such as “继续” keeps visual continuity instead of
hunting mounts for the same screenshot. Tool transcripts and active Runs remain durable evidence but do not
masquerade as conversation. The newest complete turns are retained under `historyBudgetTokens`; when the budget
is exhausted, older turns are omitted as whole pairs so role ordering and causal meaning remain intact. Every
omitted Run is exposed in the next `context.compiled.omittedBlockIds` as `history:omitted:<runId>` for operators,
and the model may receive an optional Runtime block with only `olderTurnsOmitted=<N>` (no Run IDs) when budget
remains. Agent Runs with
an unfinished Session Work Plan also receive an optional navigation ContextBlock listing `workPlanId`,
`revision`, and item `workItemId` / `step` / `status` — navigation handles, not completion evidence.
That Work Plan block (and Goal / budget warning blocks) is placed in a **user-role control trailer after** the
append-only conversation and is **frozen for the Run** after first inclusion, so provider prompt-cache prefixes
stay stable across `update_plan` / Goal `consumed` updates
([ADR 0034](../../../design/decisions.md#adr-0034-keep-provider-prompt-cache-prefixes-stable-within-a-run)).
Accepted Formal Plan Markdown is bound into Executor Run input, not this trailer.

Formal Plan acceptance still starts the Executor with `historyBudgetTokens: 0` and the accepted Markdown
envelope only; planning conversation is never restored into that Run
([ADR 0011](../../../design/decisions.md#adr-0011-make-human-control-and-askplanagent-modes-durable)).

This is an instance of the Runtime-to-model least-information boundary in
[ADR 0026](../../../design/decisions.md#adr-0026-treat-runtime-to-model-disclosure-as-a-least-information-boundary)
and the consecutive-Run allowlist in
[ADR 0032](../../../design/decisions.md#adr-0032-bound-automatic-disclosure-for-consecutive-session-runs).
Complete lifecycle facts remain in the Session event stream and are available to explicitly authorized, bounded
introspection rather than being injected into every model request.

## Stop conditions

The loop stops on valid response completion, explicit cancellation, hard resource envelope, stagnation, unknown
effect settlement, or a safe steering/parking boundary. It must not spin while merely consuming budget.

Context that remains too large after eligible exchanges are compacted parks with reason `budget`. It is a
recoverable resource boundary, not `CONTEXT_BUDGET` fault-shaped failure.

Execution surfaces may reserve the final configured Step for budget handoff. The penultimate Step receives a
warning; the final Step advertises no tools and asks for completed work/evidence, blockers, the next one to three
actions, and verification state. Tool requests on that Step create no Action and are recorded as a zero-budget
`ACTION_BATCH_LIMIT` rejection. The Step finishes as `handoff` and the Run remains `parked/budget`.

A response-only `run.completed` remains a terminal conversation fact, not verified task completion. TUI and Web
render it as `responded`; only evidence-backed completion is labeled `verified`.
