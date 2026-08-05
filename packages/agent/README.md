# @civaapple/qi-agent

Portable Qi Agent behavior and control boundaries.

The package owns:

- `./kernel`: Session transition validation, replay, projections, and EventStore port;
- `./loop`: TurnLoop, EventWriter, Goal continuation helpers, safe boundaries, human control, and recovery;
- `./capability`: default-deny leases, delegation narrowing, credential handles, and redaction;
- `./tools`: typed Tool registry, phase separation, errors, and execution context ports;
- `./effects`: EffectJournal port and deterministic intent/idempotency identities;
- `./eval`: evidence-backed goals, evaluator calibration, and convergence;
- `./memory`: provenance-backed memory policy and the MemoryIndex port;
- `./extensions`: Graph/Coordinator/introspection plus declaration-only plugin contracts.

The root exports the small `QiAgent` embedding façade. Registering a Tool or plugin contribution never creates
a Capability Lease.

```sh
npm install @civaapple/qi-agent @civaapple/qi-ai @civaapple/qi-protocol
```

## State and event ownership

`@civaapple/qi-protocol` defines durable event facts. `agent/kernel` validates transitions and rebuilds
projections. `agent/loop` produces events and persists authority plus `ActionStarted` before executor entry.
Concrete SQLite storage and SSE transport belong to `@civaapple/qi-node`.
The portable in-memory EventStore keeps a process-local incremental projection after cold replay. Append
validates each new fact with the same `applySessionEvent` transition function; any failed candidate discards the
cache, while the append-only stream remains authoritative and rebuildable.

Memory is a portable policy/state-machine boundary: `MemoryController` validates provenance, batches candidate
and lifecycle facts, requires a user for User/sensitive/relational claims, and exposes only optional
`ContextBlock`s. Session and Project scope cannot be widened by an Agent. User `always` activation is limited to
four accepted, bounded claims. Applications inject accepted claims as delimited optional reference data, never
as naked `system` instructions; Memory cannot override the current request, Workspace contract, or Runtime
policy. SQLite projection and machine paths remain Node responsibilities.

Redacted model text and reasoning may also pass through the bounded process-local `RuntimeActivity` channel for
live presentation. Model channels include approximate `estimatedOutputTokens` (reasoning+text so far) for UI
counters; that estimate never enters Session truth. Terminal text and reasoning are committed once in
`model.completed`; reasoning is explanatory model output, not completion evidence.

Restored cross-Run conversation keeps assistant narrative separate from Runtime truth. Automatic model context
receives restored final narratives (completed, budget handoff, interrupted wrappers), a local turn ordinal with
coarse write settlement class, an omission count when history is truncated, and an unfinished Work Plan
navigation snapshot when present on Plan or Agent Runs. Run/Action telemetry, tool payloads, and exact
settlement counters still require explicit bounded introspection. See
[ADR 0026](../../design/decisions.md#adr-0026-treat-runtime-to-model-disclosure-as-a-least-information-boundary)
and
[ADR 0032](../../design/decisions.md#adr-0032-bound-automatic-disclosure-for-consecutive-session-runs).

Formal Plans, Work Plans, and Questions are separate state machines. A Formal Plan is immutable reviewed
Markdown; acceptance starts one whole-plan Agent Run with empty conversation history (`historyBudgetTokens: 0`)
so the Executor sees only the accepted document. A drafting Run requires a completed `write`-effect
`plan_document create/edit` Action that records a new revision; reading the current document and SHA cannot
satisfy that completion gate. `update_plan` snapshots are optional Work Todo navigation in Plan or Agent (not
Ask) and never completion or Goal evidence; revisions may add, drop, or rewrite items, and a Session may create
successive Work Plans. Qi assigns Work Plan/Work item IDs on create; omitting `workPlanId` while supplying known
`workItemId` values continues `currentWorkPlanId`. `run.question.*` can suspend and resume a read/control
`ask_question` Action inside the same Plan or Agent Run, while legacy `control.question.*` remains the
between-Run compatibility path. Ask mode never allows `ask_question` or `update_plan`; `plan_document` stays
Plan-only.

`qi-agent` does not depend on `qi-node`, `qi-tui`, or an application. Node filesystem, process, database,
credential-file, network, and package-acquisition implementations stay behind ports.

`TurnRequest.content` and the structured `QiAgent.prompt()` overload accept ordered durable text/image parts
while the string API remains compatible. Image parts enter conversation as prepared Artifact references.
Immediately before provider I/O—and after sensitive-text redaction—the Loop verifies each digest and media type,
then creates an ephemeral data URL. Restored images use dimension-based context estimates; a missing or invalid
historical Artifact becomes an explicit image-unavailable text part. A current image on a text-only model fails
before the provider is called.

```ts
import { QiAgent } from "@civaapple/qi-agent";
import { defineTool } from "@civaapple/qi-agent/tools";
import { Type } from "@sinclair/typebox";

const agent = new QiAgent({
  modelPort,
  model: { provider: "example", model: "model" },
});

agent.registerTool("lookup", defineTool({
  description: "Read a bounded value",
  input: Type.Object({ key: Type.String() }),
  output: Type.Object({ value: Type.String() }),
  effect: () => "read",
  resources: ({ key }) => [`lookup:${key}`],
  execute: async ({ key }) => ({ value: await lookup(key) }),
}));
```

Execution remains denied until the application grants a matching, intent-scoped lease.

Long-form contracts live under [`docs/`](docs/).
