# @civaapple/qi-ai

Portable model integration and deterministic context compilation for Qi.

The root exports `ModelPort`, portable request/event schemas, scripted test ports, provider profiles, and
OpenAI-compatible Chat Completions/Responses adapters. `./context` exports the budget-aware Context Compiler.

```sh
npm install @civaapple/qi-ai
```

Provider-specific response IDs, transport state, and credentials never enter durable Session truth. A provider
adapter streams portable text/reasoning/action boundaries; Agent lifecycle policy remains in
`@civaapple/qi-agent`. Profiles may declare model-specific windows and thinking modes when one provider exposes
materially different models; callers can inspect them with `getProviderModelProfile` and
`providerModelContextTokens`.

```ts
import { createModelPortForProfile } from "@civaapple/qi-ai";
import { compileContext } from "@civaapple/qi-ai/context";
```

The compiler treats the model window, output reserve, required context, optional context, and conversation
history as distinct budgets. It is deterministic and fails closed when required blocks cannot fit. Runtime-owned
blocks are purpose-built least-information disclosures rather than serialized Session projections: internal IDs,
authority traces, and unrelated lifecycle diagnostics stay outside model context unless an explicit bounded
introspection path is authorized.

The compiler result includes deterministic per-kind ContextBlock statistics for included/omitted counts and
estimated tokens; callers can project composition without retaining block payloads. See
[`docs/model/`](docs/model/) and [`docs/context/`](docs/context/) for adapter and compiler contracts.
