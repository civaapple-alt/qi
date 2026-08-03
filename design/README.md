# Qi design map

The public design set is intentionally small:

| Document | Purpose |
| --- | --- |
| [product-vision.md](product-vision.md) | Why Qi exists: life-like continuity, coexistence, product relationships, and bounded autonomy |
| [system-design.md](system-design.md) | Current end-to-end architecture, runtime flow, and package boundaries |
| [decisions.md](decisions.md) | Current cross-package decisions and constraints |
| [roadmap.md](roadmap.md) | Maturity terms, release gates, near-term work, and explicit deferrals |

Chronological implementation plans, research notes, and version process reports do not belong in the public
design contract. Their durable result is folded into these four documents, package contracts, tests, and the
changelog.

## Five-minute model

Qi is an event-sourced Agent Runtime:

- the Session event stream is durable truth;
- `agent/kernel` validates transitions and rebuilds projections;
- `agent/loop` coordinates model turns and Tool phases;
- capability policy decides whether an Action may execute;
- Workspace and Effect Journal boundaries observe and settle world changes;
- verified completion requires matching evidence;
- Skills, MCP, graphs, delegation, scheduling, memory, and introspection cannot bypass those controls.

`apps/cli` is the local execution composition. `apps/web` is read-only. Five runtime packages plus the CLI form
the six coordinated public packages.

## Reading paths

### Lifecycle or persistence

1. [system-design §3](system-design.md#3-session-lifecycle-and-durable-truth)
2. [ADR-0030: Session directories as the movable persistence boundary](decisions.md#adr-0030-make-session-directories-the-movable-persistence-boundary)
3. `packages/protocol/README.md`
4. `packages/agent/docs/kernel/state-machine.md`
5. `packages/node/docs/storage/atomicity-and-recovery.md`
6. SessionRepository, replay, and SQLite tests

### Tool, authority, or effect safety

1. [system-design §4](system-design.md#4-workspace-authority-and-effects)
2. [decisions: precise mutation](decisions.md#adr-0003-use-freshness-checked-precise-file-mutation)
3. `packages/agent/docs/capability/README.md`
4. `packages/agent/docs/tools/execution-contract.md`
5. `packages/node/docs/workspace/effect-journal.md`

### Models, context, or memory

1. [system-design §5](system-design.md#5-context-models-and-memory)
2. `packages/ai/README.md`
3. `packages/ai/docs/context/compiler.md`
4. [ADR-0034](decisions.md#adr-0034-keep-provider-prompt-cache-prefixes-stable-within-a-run) (prompt-cache layout)
5. `packages/agent/docs/memory/README.md`

For image input, continue with
[ADR-0028](decisions.md#adr-0028-persist-ordered-media-references-and-materialize-provider-payloads-late),
then `packages/node/README.md` (`./media`) and the provider adapter tests.

### Goals and completion

1. [system-design §6](system-design.md#6-goals-evidence-and-completion)
2. `packages/agent/docs/eval/README.md`
3. `packages/agent/docs/eval/evidence-completion.md`
4. goal/evaluator tests

### Session modes or UI

1. [product vision: 同行、追寻、守望](product-vision.md#5-同行追寻守望)
2. [system-design §7](system-design.md#7-human-control-and-application-surfaces)
3. [decisions: human control](decisions.md#adr-0011-make-human-control-and-askplanagent-modes-durable)
4. [decisions: bounded interaction timeline](decisions.md#adr-0027-project-one-bounded-interaction-timeline-with-protected-human-attention)
5. [ADR-0031: drafts, `@` mentions, model reconfigure, permission display](decisions.md#adr-0031-preserve-composer-drafts-across-local-slash-controls)
6. [ADR-0032: consecutive Session Run disclosure](decisions.md#adr-0032-bound-automatic-disclosure-for-consecutive-session-runs)
7. `packages/tui/README.md`
8. `apps/cli/README.md`

### Extensions

1. [system-design §8](system-design.md#8-extensions-skills-mcp-codeact-graph-delegation-scheduling-and-introspection)
2. `packages/agent/docs/` for portable contracts or `packages/node/docs/` for Node adapters
3. the matching section in [decisions.md](decisions.md)
4. the package's focused tests

## Sources of truth

1. Current architecture and decisions under `design/`.
2. Package contracts in `packages/*/README.md` and package-local `docs/`.
3. Runtime schemas and public TypeScript types.
4. Tests and golden traces.

When observable behavior changes, update the implementation, the narrowest executable evidence, and the
smallest canonical document in the same change.
