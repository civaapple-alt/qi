# `@civaapple/qi-llm`

A small portable model plane for validated requests, streamed events, and provider adapters.

## Purpose

The package separates Qi's model-facing protocol from provider SDKs. `ModelPort` accepts portable history,
tool descriptions, capabilities, cancellation, and context metadata, then emits validated model events.

## Non-goals

- It does not run the Agent loop or authorize tool calls.
- Provider response IDs and hidden server state do not become required Session truth.
- It does not decide completion, memory, or retry policy.

## Core model

`ModelRequestSchema` describes portable input. A stream contains content and action proposal events with exactly
one terminal boundary. Explicit `ProviderProfile` entries choose the wire API and transport capability matrix.
`OpenAIResponsesModelPort` maps to OpenAI-compatible Responses APIs; `OpenAIChatCompletionsModelPort` maps to
Chat Completions (assembling streamed tool arguments only after a terminal finish reason);
`createModelPortForProfile` selects the adapter; `ScriptedModelPort` supplies deterministic fixtures.

## Behavioral invariants

- Validate unsupported portable inputs before network execution.
- Do not release action proposals from an incomplete provider response.
- Preserve cancellation and terminal stream semantics.
- Verify that provider output belongs to the expected request/model boundary.

## Failure semantics

Schema, capability, provider, and cancellation failures remain distinguishable. An incomplete response never
silently becomes an executable tool batch.

## Install and minimal use

```sh
npm install @civaapple/qi-llm
```

```ts
import { ScriptedModelPort } from "@civaapple/qi-llm";

const model = new ScriptedModelPort([[
  { type: "text.delta", delta: "hello" },
  { type: "completed", finishReason: "stop" },
]]);
```

## Public API

Portable schemas and types, `ModelPort`, `OpenAIResponsesModelPort`, and `ScriptedModelPort`.

## Change guide

Extend the portable protocol before adding provider-only branches. Update the adapter, scripted fixtures,
context compilation assumptions, and loop handling together when stream events change.

## Verification

Use `tests/openai-responses.test.mjs` and the model cases in `tests/llm-context.test.mjs`.

## Further reading

- [Portable model protocol](docs/portable-protocol.md)
- [Provider adapters](docs/provider-adapters.md)
- [LLM layer design](../../design/system-design.md#5-context-models-and-memory)
