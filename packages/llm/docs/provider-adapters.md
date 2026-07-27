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

The composition root must provide the effective model window when it differs from the adapter default. This
capability value and the Loop working budget must derive from the same operator configuration; output reserve is
sent separately as `maxOutputTokens` rather than counted as available prompt space.
