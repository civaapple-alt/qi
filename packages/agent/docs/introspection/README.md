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
problems, the last Step, or one Step/Action. Summary and detail projections retain IDs, event sequence bounds,
status, error codes, and any durable edit freshness rebase while bounding text, results, and lists and reporting
every omission.

Diagnostic fields (not Evidence):

- Run `displayTitle`, light `planBinding`, detail `formalPlan` (`title` / `revision` / `path`), and
  `actionFacts` (`writeCompleted` / `writeFailed` / `readCompleted`). These detailed diagnostic counts are
  available only through explicit bounded inspection; automatic restored-history context exposes only the coarse
  write settlement class defined by ADR 0024/0026.
- Session header `currentWorkPlanId` and compact `workPlan` snapshot when present.
- Step `modelReasoning` beside `modelText`.
- Action detail summaries for `update_plan` (`workPlanItems`), process tools (`process`), and
  `diffKind` (`file` | `git`) with a bounded `diff` preview.

`createQiSessionInspectionTool(source, currentSessionId)` exposes the same semantics as `qi_session_inspect`.
The CLI injects only its current project EventStore; callers cannot supply a database path or cross-project root.

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
