# Provider adapters

Provider adapters translate the portable request and stream contract; they do not own Agent policy.

## Adapter responsibilities

- Validate requested capabilities before network execution.
- Map portable history and offered tools to the provider request.
- Translate streamed provider items into validated `ModelEvent` values.
- Enforce provider ownership and response identity where applicable.
- Surface cancellation, API failure, malformed output, and incomplete terminal state distinctly.

## Forbidden shortcuts

- Depending on hidden provider conversation state for replay.
- Executing or authorizing a tool inside the adapter.
- Treating an interrupted response as a completed action batch.
- Smuggling retry or Goal completion policy into provider error handling.

## Adding a provider

Start from `ModelPort`, list unsupported portable features, then add mapping fixtures for text, tool proposal,
completed tool history, cancellation, provider error, and incomplete response. The Loop should not need a
provider-name branch.

`tests/openai-responses.test.mjs` is the current adapter contract suite.

## OpenAI-compatible endpoints

Provider Profiles declare the wire API (`responses` or `chat.completions`) and a transport capability matrix.
`createModelPortForProfile` selects `OpenAIResponsesModelPort` or `OpenAIChatCompletionsModelPort`. The TUI maps
profile ids such as `openai`, `xai`, `kimi`, `deepseek`, `moonshot`, and `compatible` to environment variables and
`/login` flows. The `compatible` profile is Chat Completions for arbitrary OpenAI-compatible gateways (named
aliases such as `qianwenai` / `zhipu` live in TUI config as `account_alias` / `[[compatible]]`, not as new wire
profiles). Provider identity remains part of `ModelRef`; sharing a wire protocol does not collapse ownership.

Compatible endpoints can support different optional request fields. Profiles that disable `requestMetadata` omit
that Responses field (for example xAI). Session, Run, and Step correlation remains durable in Qi's local
event stream. Wire APIs are never inferred from failed business requests.

The composition root uses the selected model profile's window unless the operator explicitly overrides it. This
capability value and the Loop working budget must derive from the same operator configuration; output reserve is
sent separately as `maxOutputTokens` rather than counted as available prompt space.

## Kimi Code models

The `kimi` profile uses `https://api.kimi.com/coding/v1` with Chat Completions and declares four model IDs:

| Model | Context window | Thinking |
| --- | ---: | --- |
| `k3` | 1,048,576 | `low` / `high` / `max`, default `high` |
| `k3-256k` | 262,144 | `low` / `high` / `max`, default `high` |
| `kimi-for-coding` | 262,144 | enabled/disabled toggle |
| `kimi-for-coding-highspeed` | 262,144 | enabled/disabled toggle |

K3 effort aliases are normalized before network execution: `ultra|max|xhigh` → `max`,
`high|medium` → `high`, and `low|minimum|light` → `low`. `none` sends
`thinking: { type: "disabled" }`; other values fail locally instead of producing a remote HTTP 400. K2.7 Code
models send `thinking: { type: "enabled" }` for any enabled effort. Kimi `reasoning_content` / `reasoning`
stream deltas become portable `reasoning.delta` events. Output reserve is sent as `max_completion_tokens` for
Kimi reasoning models rather than the legacy `max_tokens` field. That value caps the combined hidden reasoning
and visible completion; the current Kimi wire contract exposes thinking enable/effort but no separate reasoning
token budget. Context window and completion cap are independent, so a 1M K3 profile does not scale a 16k output
reserve linearly from the 256k profile.
For a manually entered future Kimi model ID, an explicit effort is passed through using the same normalized
Kimi wire shape; omitting effort leaves thinking configuration unspecified because the model profile is unknown.
