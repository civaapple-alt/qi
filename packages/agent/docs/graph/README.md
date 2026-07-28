# `@civaapple/qi-agent/extensions`

A Graph Governor that narrows the model's sampling domain without replacing runtime intelligence or safety.

## Purpose

Graphs make allowed states, tools, and transitions explicit. Deterministic guards choose when facts are enough;
model routing is allowed only among choices offered by the current node.

## Non-goals

- A graph does not authorize tools or effects.
- Model output cannot invent a node or edge outside the offered choice set.
- Dynamic graph replacement is not an unvalidated prompt-side mutation.

## Core model

`GraphDefinition` contains nodes and guarded edges. `GraphGovernor` resolves deterministic guards before model
choices, exposes bounded route options, narrows available tools, and independently authorizes dynamic replacement.

## Behavioral invariants

- Deterministic guards outrank model routing.
- Model choices are constrained to the current node's offered edges.
- A node can narrow but not widen the surrounding capability lease.
- Dynamic graph definitions are schema-validated and separately authorized.

## Failure semantics

Invalid definitions, missing nodes, ambiguous deterministic routes, out-of-domain model choices, and denied
replacement fail closed without mutating the active graph.

## Install and minimal use

```sh
npm install @civaapple/qi-agent/extensions
```

```ts
import { validateGraph } from "@civaapple/qi-agent/extensions";

validateGraph({
  id: "single-step",
  version: 1,
  start: "inspect",
  nodes: [{ id: "inspect", observe: ["workspace"], actions: ["read"], skills: [] }],
  edges: [],
});
```

## Public API

Graph definition and edge types, `GraphGovernor`, and `validateGraph()`.

## Change guide

Keep routing decisions inspectable. New guard kinds must define determinism and precedence; dynamic features must
not make the graph an alternate authority system.

## Verification

`tests/graph-governor.test.mjs` covers tool narrowing, route precedence, bounded model choice, and replacement.

## Further reading

- [Governor model](docs/governor.md)
- [Graph design](../../design/system-design.md#8-extensions-skills-mcp-codeact-graph-delegation-scheduling-and-introspection)
