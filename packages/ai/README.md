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

Profiles also declare input modalities and optional per-model wire-API overrides. Kimi K3 and the known Kimi
Coding models accept image parts; K3 uses a 1,048,576-token window and `max`-only/default thinking. DeepSeek V4
Flash uses Responses with a 1M window and effort thinking; V4 Pro stays on Chat Completions until the vendor
adds Responses. OpenAI Responses accepts images; DeepSeek rejects them. Custom OpenAI-compatible Chat
Completions endpoints deny image input unless `imageInput` is explicitly enabled by the operator. Portable
assistant messages may carry a `reasoning` part so thinking-mode tool turns can round-trip CoT. Chat Completions
sends portable user text/images as a standard content array; image-bearing Tool results keep their Tool
call/output message and add a following synthetic user media message. Artifact references must be verified and
materialized before either adapter is invoked.

```ts
import { createModelPortForProfile } from "@civaapple/qi-ai";
import { compileContext } from "@civaapple/qi-ai/context";
```

The compiler treats the model window, output reserve, required context, optional context, and conversation
history as distinct budgets. It is deterministic and fails closed when required blocks cannot fit. Runtime-owned
blocks are purpose-built least-information disclosures rather than serialized Session projections: internal IDs,
authority traces, and unrelated lifecycle diagnostics stay outside model context unless an explicit bounded
introspection path is authorized.

The default `TokenEstimator` is conservative for Unicode and callers add message/schema framing. A
`ModelCapabilities.tokenEstimator` may supply a provider/model-calibrated deterministic estimator; one Turn must
use the same estimator for ContextBlocks, messages, and Tool schemas.

The compiler result includes deterministic per-kind ContextBlock statistics for included/omitted counts and
estimated tokens; callers can project composition without retaining block payloads. See
[`docs/model/`](docs/model/) and [`docs/context/`](docs/context/) for adapter and compiler contracts.
