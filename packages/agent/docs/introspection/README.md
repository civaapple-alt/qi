# `@civaapple/qi-agent/extensions`

Version **0.5.1**. Package maturity: **internal public-package preview**.

This package gives Qi and contributors one versioned, machine-readable view of Qi's identity, package
ownership, invariants, architecture decisions, maturity, release gaps, and verification commands.

## Purpose

- Validate and query `QiSelfModel`.
- Produce bounded Context blocks with explicit provenance and an authority disclaimer.
- Provide the read-only `qi_introspect` Tool definition.
- Provide bounded, read-only projections for Qi to inspect Sessions in its current project.
- Detect drift between the self model, workspace packages, package READMEs, and the consolidated decision record.

## Non-goals

- Self knowledge does not grant a Capability Lease.
- The package cannot edit source, policy, credentials, Session history, or release metadata.
- It cannot promote package maturity or certify semantic/product success.
- It does not load every design document into every prompt.

## Quick start

```sh
npm install @civaapple/qi-agent/extensions
```

```ts
import {
  createQiSelfContext,
  qiSelfModel,
  queryQiSelfModel,
} from "@civaapple/qi-agent/extensions";

console.log(qiSelfModel.release);
console.log(queryQiSelfModel("packages"));

const context = createQiSelfContext(["identity", "invariants", "gaps"]);
```

Register `createQiIntrospectionTool()` through an ordinary `ToolRegistry`. Execution still requires a
matching read lease for `qi:self-model:<section>`.

`inspectQiSession(source, query)` lists project Sessions or narrows one Session to Runs, a selected/latest Run,
problems, recovery, Subagent `delegations`, the last Step, or one Step/Action. It is a lifecycle diagnostic
probe, not a substitute for restored conversation history (including interrupted-run narrative wrappers and Work
Plan navigation ContextBlocks from ADR 0032). Prefer restored history for ordinary continue; use
`operation=recovery` when the prior terminal state, settlement, or `imageAttachments.originalArtifactRef` is
unclear. For Plan depth-1 research returns use `operation=delegations` (or Run `detail`) then
`artifact_get(resultRef)` — not child `last-step` `modelText`. Summary and detail projections retain IDs, event
sequence bounds, status, error codes, and any durable edit freshness rebase while bounding text, results, and
lists and reporting every omission.

Diagnostic fields (not Evidence):

- `recovery` selects the newest interrupted user Run (`failed` / `cancelled` / `parked`), else the newest
  completed user Run, and returns one item with fixed `guidance`, run status/terminal fields,
  `imageAttachments`, bounded `lastStep`, problem Action summaries, and when present Subagent
  `delegationCount` / `delegationFacts` plus problem `problemDelegations` — prefer this over chaining
  `runs` → `last-step` → `step` → `action` when continuing after an unclear terminal state.
- `delegations` lists bounded Subagent Task rows for the selected/latest Run (`delegationId`,
  `childSessionId`, `status`, short `outcome`, `resultRef` / `summaryRef`, wall/reasons in detail). Full child
  deliverable text stays in the Artifact store; load it with `artifact_get(resultRef)`.
- Run `displayTitle`, `imageCount` / `imageAttachments` (source, dimensions, `originalArtifactRef` /
  `preparedArtifactRef` when the Run carried pasted/path/URL images), light `planBinding`, detail `formalPlan`
  (`title` / `revision` / `path`), `actionFacts`, and `delegationCount` / `delegationFacts` (detail also lists
  bounded `delegations`). Legacy totals remain `writeCompleted` / `writeFailed` /
  `readCompleted`; scoped fields separate `workspaceWriteCompleted` / `workspaceWriteFailed`,
  `artifactWriteCompleted` / `artifactWriteFailed`, and `otherWriteCompleted` / `otherWriteFailed`. Use the
  Workspace fields for project-mutation claims. These detailed diagnostic counts are available only through
  explicit bounded inspection; automatic restored-history context stays on the ADR 0024/0026/0032 allowlist
  (coarse write settlement, interrupted wrappers, omission count, Work Plan navigation) and never includes tool
  transcripts. For clipboard screenshots, prefer `read_image` with `originalArtifactRef` over searching mounts.
- Session header `currentWorkPlanId` and compact `workPlan` snapshot when present.
- Step `modelReasoning` beside `modelText`.
- Action detail summaries for `update_plan` (`workPlanItems`), `delegate` (`delegations` refs + `parentHint`),
  process tools (`process`), and `diffKind` (`file` | `git`) with a bounded `diff` preview.

`createQiSessionInspectionTool(source, currentSessionId)` exposes the same semantics as `qi_session_inspect`.
The CLI registers that Tool only when `$QI_HOME/config.toml` sets `[tools] qi_session_inspect = true` (default
off). Offline `inspectQiSession` / extract-session stay available without the flag. The CLI injects only its
current project EventStore; callers cannot supply a database path or cross-project root.

## Public API

- `QiSelfModelSchema` and `parseQiSelfModel()`
- `qiSelfModel`
- `queryQiSelfModel()`
- `createQiSelfContext()`
- `createQiIntrospectionTool()`
- `inspectQiSession()` and `createQiSessionInspectionTool()`
- `QiSessionInspectionQuery`, `QiSessionInspectionResult`, and `QiSessionInspectionSource`

## Change guidance

Update the self model when package ownership, architecture decisions, maturity, verification, or release blockers
change.
Canonical design and executable evidence remain the source of truth; conflicts are reported rather than hidden.

## Verification

`tests/introspection.test.mjs` verifies schema parsing, package/README and decision coverage, bounded Context,
read-only Tool identity, and denial without an explicit lease.
