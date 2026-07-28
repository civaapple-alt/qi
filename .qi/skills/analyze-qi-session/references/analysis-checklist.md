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
| Run | input, status, terminal reason, completion kind | `responded` presented as verified; partial effects before failure |
| Step | context budget, model finish reason, rejected calls, progress | repeated strategy; context pressure; action batch confusion |
| Action | tool, effect, resource, authority, start, settlement | missing settlement; denial ignored; unsafe or imprecise fallback |
| Workspace | target, freshness, diff, Git state | whole-file rewrite; stale edit; mutation without useful diff |
| Verification | declared profile or deterministic command, exit evidence | mutation completed without relevant validation |
| Evidence | evaluation and Evidence Ledger linkage | tool success mislabeled as acceptance evidence |
| Recovery | later Step/Action after a failure | recovery hidden; same failure repeated without strategy change |

## Common patterns

### Verbal mutation claim without write Actions

Treat model narration of “已修复 / edit returned diff” as unproven until a completed write Action (or authorized
shell mutation with before/after evidence) exists in the same Run. Extract reports may emit
`CLAIMED_MUTATION_WITHOUT_ACTIONS` for this pattern; it is diagnostic and does not rewrite Run completion.

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
