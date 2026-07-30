# `@civaapple/qi-ai/context`

Deterministic, budget-aware compilation of context blocks into portable model messages.

## Purpose

The Context Compiler preserves required context, ranks optional blocks, and produces an auditable inclusion and
omission result under an explicit token budget.

## Non-goals

- It does not retrieve or approve memories.
- It does not call models or compact history through hidden provider state.
- It does not truncate required facts to manufacture a valid request.

## Core model

Callers provide uniquely identified `ContextBlock` values with kind, priority, required status, and content.
`compileContext()` estimates cost, includes all required blocks, then spends remaining budget deterministically.

## Behavioral invariants

- Required blocks are never silently dropped.
- Duplicate block IDs are rejected.
- Equal input and estimator produce equal ordering and output.
- The result reports both included and omitted blocks.
- `blockStats` aggregates included/omitted counts and estimated tokens by `ContextKind` in deterministic
  first-seen order.

## Failure semantics

`ContextBudgetError` is thrown when required context alone exceeds the budget. Ambiguous duplicate identity is a
hard input error, not a tie resolved by chance.

## Install and minimal use

```sh
npm install @civaapple/qi-ai/context
```

```ts
import { compileContext } from "@civaapple/qi-ai/context";

const compiled = compileContext({
  budgetTokens: 100,
  blocks: [{
    id: "goal",
    kind: "goal",
    source: "caller",
    role: "user",
    content: "Explain the repository.",
    priority: 100,
    required: true,
    retentionReason: "current goal",
  }],
});
```

## Public API

`compileContext()`, context block/result types (including `ContextBlockStats`), `TokenEstimator`, and
`approximateTokenEstimator`.

## Change guide

Keep ordering deterministic and make every new context kind explicit. Memory retrieval, loop compaction, and
provider token accounting should remain adapters around this compiler rather than hidden branches inside it.

## Verification

The context cases in `tests/llm-context.test.mjs` cover priority, overflow, determinism, and duplicate IDs.

## Further reading

- [Compiler contract](docs/compiler.md)
- [Global context design](../../design/system-design.md#5-context-models-and-memory)
