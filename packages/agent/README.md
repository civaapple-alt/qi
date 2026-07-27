# `@civaapple/qi-agent`

Version **0.4.0**. Package maturity: **internal public-package preview**.

`@civaapple/qi-agent` is the small embedding façade for Qi's event-sourced, evidence-first Agent Runtime. It
composes the existing `TurnLoop`, EventStore, ModelPort, Tool Registry, Capability Broker, and ArtifactStore; it
does not introduce another lifecycle or authority path.

## Purpose

- Give application authors one class for prompting and continuing a Qi Session.
- Provide safe in-memory defaults for examples and tests.
- Expose committed Session events, the current `SessionView`, tool registration, steering, and bounded activity.
- Preserve default-deny authority and every durable Action boundary.

## Non-goals

- Registering a Tool does not authorize it.
- The façade does not auto-grant write, execute, publish, spend, or delegation.
- It does not auto-retry indeterminate effects or turn a model response into verified completion.
- In-memory defaults are not durable crash recovery.

## Quick start

```sh
npm install @civaapple/qi-agent @civaapple/qi-llm
```

```ts
import { QiAgent } from "@civaapple/qi-agent";
import { ScriptedModelPort } from "@civaapple/qi-llm";

const modelPort = new ScriptedModelPort([[
  { type: "text.delta", delta: "Hello from Qi." },
  { type: "completed", finishReason: "stop" },
]]);

const agent = new QiAgent({
  modelPort,
  model: { provider: "scripted", model: "example" },
});

const result = await agent.prompt("Say hello.");
console.log(result.text);
console.log(agent.view?.runOrder);
```

Use `agent.registerTool()` to advertise a typed Tool, then separately call `agent.grant()` when using the default
in-memory broker. A registered Tool without a matching lease is denied before its executor starts. Production
applications should supply approval-capable and durable adapters.

## Public API

- `QiAgent`
- `QiAgentOptions`
- `QiPromptOptions`
- `InMemoryArtifactStore`

## Change guidance

Keep this package thin. New behavior belongs in the owning lower-level package and is composed here only after
its protocol, failure, authority, recovery, and evidence semantics exist.

## Verification

`tests/agent-package.test.mjs` proves response, explicit authorized Tool, default denial, event subscription, and
Session projection paths.
