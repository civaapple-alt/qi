# @civaapple/qi-agent

Portable Qi Agent behavior and control boundaries.

The package owns:

- `./kernel`: Session transition validation, replay, projections, and EventStore port;
- `./loop`: TurnLoop, EventWriter, safe boundaries, human control, and recovery;
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

Formal Plans, Work Plans, and Questions are separate state machines. A Formal Plan is immutable reviewed
Markdown; acceptance starts one whole-plan Agent Run. `update_plan` snapshots are optional implementation Todo
navigation and never completion evidence. `run.question.*` can suspend and resume a read/control Action inside
the same Plan Run, while legacy `control.question.*` remains the between-Run compatibility path.

`qi-agent` does not depend on `qi-node`, `qi-tui`, or an application. Node filesystem, process, database,
credential-file, network, and package-acquisition implementations stay behind ports.

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
