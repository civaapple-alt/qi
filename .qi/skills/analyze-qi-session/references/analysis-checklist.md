# Qi Session analysis checklist

Use this checklist after extracting the Session report. It is a review rubric, not a source of facts.

## Evidence priority

1. Raw durable event type, sequence, IDs, and payload.
2. Kernel/Web projection derived from those events.
3. Tool result, Workspace diff, Artifact, and deterministic verification output.
4. Model narration, which expresses intent but does not prove execution or completion.

## Review matrix

| Layer | Inspect | Typical concern |
| --- | --- | --- |
| Run | `displayTitle`, Formal Plan binding, status, terminal reason, completion kind, `actionFacts` | raw accepted-plan input treated as the task; `responded` presented as verified; partial effects before failure |
| Step | context budget, model finish reason, `modelReasoning`, rejected calls, progress | Thinking mistaken for evidence; repeated strategy; context pressure; action batch confusion |
| Action | tool, effect, resource, authority, start, settlement, `diffKind` / Git workspace change | missing settlement; denial ignored; shell Git fingerprint confused with file-tool diff |
| Work Plan | `update_plan` items vs write/verify Actions | Todo “completed” without durable mutation; provisional Work item ID loops |
| Workspace | target, freshness, diff, Git state | whole-file rewrite; stale edit; mutation without useful diff |
| Verification | declared profile or deterministic command, exit evidence | mutation completed without relevant validation |
| Evidence | evaluation and Evidence Ledger linkage | tool success mislabeled as acceptance evidence |
| Recovery | later Step/Action after a failure | recovery hidden; same failure repeated without strategy change |
| History | restored `<qi-run-facts>` footnotes | footnotes are counts only — they do not replace the Action timeline |

## Common patterns

### Formal Plan Run vs conversational Run

Accepted Formal Plan Runs bind `planBinding` and surface as `Accepted Plan · {title} · rev {n}`. The durable Run
`input` may still be the full `<accepted-plan>…</accepted-plan>` Markdown envelope — use `displayTitle` /
`formalPlan` for the task label, and treat the envelope as Executor context, not as a short user message.

### Formal Plan vs Work Plan

A Formal Plan is the reviewed Markdown document (immutable path/revision). A Work Plan is the Agent-only
`update_plan` Todo snapshot. Do not conflate Plan Review acceptance with Work Plan progress, and do not treat Todo
status as proof that `edit`/`write` ran.

### Thinking is not Evidence

`modelReasoning` / Thinking blocks express intermediate intent. They do not settle Actions, mutate the Workspace,
or enter the Evidence Ledger.

### History footnotes are not a tool transcript

Cross-Run restored assistant history may append `<qi-run-facts writeCompleted=… readCompleted=… terminal=… />`.
Those counts match inspect `actionFacts` and are diagnostic only — open the Action timeline for settlement proof.

### Verbal mutation claim without write Actions

Treat model narration of “已修复 / edit returned diff” as unproven until a completed write Action (or authorized
shell mutation with before/after evidence) exists in the same Run. Extract reports may emit
`CLAIMED_MUTATION_WITHOUT_ACTIONS` for this pattern; it is diagnostic and does not rewrite Run completion.

### File diff vs Git workspace change

`edit`/`write` diffs are precise file mutations. Some `shell`/`script`/`verify` results only record a Git
before/after fingerprint (`gitWorkspaceChange` / `diffKind: "git"`). Do not treat an empty or absent file diff as
proof that no Workspace change occurred when Git change is marked, and do not treat Git change as Evidence Ledger
acceptance.

### Dedicated mutation failure followed by shell mutation

Check whether `edit` or `write` failed first, whether the shell actually changed the Workspace, and whether its
before/after Git evidence identifies the mutation. The immediate issue may be model input, newline/freshness
handling, or target ambiguity. The systemic solution should improve the dedicated tool or retry guidance rather
than merely banning an explicitly authorized shell.

### Completed Run containing failed Actions

This is usually a recovered Run, not contradictory state. Explain the failed attempt, the changed strategy, and
the successful path. Flag it only when the UI hides recovery, the strategy did not materially change, or the final
claim ignores missing verification.

### Response completion after Workspace mutation

`completionKind: response` is valid for conversation, but not evidence-backed acceptance. Determine whether a
`verify` Action or deterministic test-like shell command ran, and whether the user asked for verified completion.
Recommend Goal/Evidence integration separately from ordinary execution-result presentation.

### Action lifecycle gap

For non-read effects, require persisted authority before executor start and a terminal settlement afterward.
An `indeterminate` effect must park and must not retry automatically. Missing milestones are a runtime/protocol
finding, not a model-quality issue.

### Context pressure or compaction

Distinguish model window, output reserve, working prompt budget, and durable Session truth. `context.compacted`
is expected under pressure; loss of causal summaries, Artifact references, newest tool feedback, or safe parking is
the defect.

## Finding format

For each material issue provide:

- **Severity and title**
- **Classification:** fact, inference, or proposal
- **Evidence:** IDs, event sequences, tools, errors, diffs, or verification output
- **Cause and confidence:** include the most plausible owner and a falsification check
- **Impact:** user-visible and invariant-level consequences
- **Fix:** smallest immediate change, then systemic hardening if different
- **Regression evidence:** focused test/trace plus broader checks proportionate to risk

Avoid generic advice such as “add retries” or “improve prompts.” Tie every recommendation to the observed failure
mode and preserve Qi's authority, effect-settlement, and evidence boundaries.
