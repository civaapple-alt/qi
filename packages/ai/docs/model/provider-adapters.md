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

Provider Profiles declare a default wire API (`responses` or `chat.completions`) and a transport capability matrix.
A model catalog entry may override the profile wire API via `resolveProviderWireApi`. `createModelPortForProfile`
selects `OpenAIResponsesModelPort` or `OpenAIChatCompletionsModelPort` from that resolved value. The TUI maps
profile ids such as `openai`, `xai`, `kimi`, `deepseek`, `volcengine-agent-plan`, `qianwenai`, `moonshot`, and
`compatible` to environment variables and `/login` flows. The `compatible` profile is Chat Completions for
arbitrary OpenAI-compatible gateways (named aliases such as `zhipu` live in TUI config as `account_alias` /
`[[compatible]]`). First-class Qianwen Token Plan access uses provider id `qianwenai`. Provider identity remains
part of `ModelRef`; sharing a wire protocol does not collapse ownership.

Compatible endpoints can support different optional request fields. Profiles that disable `requestMetadata` omit
that Responses field (for example xAI and DeepSeek). Session, Run, and Step correlation remains durable in Qi's
local event stream. Wire APIs are never inferred from failed business requests.

The composition root uses the selected model profile's window unless the operator explicitly overrides it. This
capability value and the Loop working budget must derive from the same operator configuration; output reserve is
sent separately as `maxOutputTokens` rather than counted as available prompt space.

## Kimi Code models

The `kimi` profile uses `https://api.kimi.com/coding/v1` with Chat Completions and declares four model IDs:

| Model | Context window | Thinking |
| --- | ---: | --- |
| `k3` | 1,048,576 | `low` / `high` / `max`, default `high` |
| `k3-256k` | 262,144 | `low` / `high` / `max`, default `high` |
| `kimi-for-coding` | 262,144 | always on (`thinking.keep=all`) |
| `kimi-for-coding-highspeed` | 262,144 | always on (`thinking.keep=all`) |

K3 effort aliases are normalized before network execution: `ultra|max|xhigh` → `max`,
`high` → `high`, `medium` → `medium`, and `low|minimum|light|minimal` → `low`. Catalog K3 models
advertise only `low`/`high`/`max`; an unsupported value such as `medium` falls back to the model
`defaultEffort` on the wire. Enabled K3 requests send top-level `reasoning_effort` (not a nested
`thinking.effort`). `none` sends `thinking: { type: "disabled" }`; other values fail locally instead
of producing a remote HTTP 400. Kimi Code may route disabled-thinking K3/K2.7 requests to an older
model, so the CLI does not advertise `none` for catalog K3/K2.7 models.
K2.7 Code models always think and send `thinking: { type: "enabled", keep: "all" }`; an explicit
`none` fails locally. Kimi `reasoning_content` / `reasoning` stream deltas become portable
`reasoning.delta` events. Output reserve is sent as `max_completion_tokens` for Kimi reasoning models
rather than the legacy `max_tokens` field. That value caps the combined hidden reasoning and visible
completion; the current Kimi wire contract exposes thinking enable/effort but no separate reasoning
token budget. Context window and completion cap are independent, so a 1M K3 profile does not scale a
16k output reserve linearly from the 256k profile.
For a manually entered future Kimi model ID, an explicit effort is passed as top-level
`reasoning_effort`; omitting effort leaves thinking configuration unspecified because the model
profile is unknown. Authenticated CLI `/model` and login forms may call `GET /models` and merge
availability with the static catalog; thinking/effort authority remains on the catalog (ADR-0009).

## DeepSeek V4

The `deepseek` profile defaults to Responses for `deepseek-v4-flash` and keeps Chat Completions for
`deepseek-v4-pro` until the vendor exposes Responses for Pro. Both catalog models advertise a 1,048,576-token
window, text-only input, and effort thinking (`low` / `high` / `max`, default `high`).

| Model | Wire API | Notes |
| --- | --- | --- |
| `deepseek-v4-flash` | `responses` | Official Responses support; no `metadata`; images rejected; 65,536 output reserve |
| `deepseek-v4-pro` | `chat.completions` | `thinking` + `reasoning_effort` on the Chat Completions body; 65,536 output reserve |

DeepSeek counts thinking tokens inside `max_output_tokens`. The catalog raises the composition-root
output reserve above the generic 16k default so high-effort agent turns are less likely to park on a
length boundary before a visible reply or tool call.

Effort aliases match the shared normalizer (`minimal` → `low`, `medium` stays `medium`, `xhigh` → `max`,
etc.). Catalog DeepSeek models advertise only `low`/`high`/`max`, so unsupported levels fall back to
`defaultEffort` on the wire. Responses sends `reasoning: { effort }`; Chat Completions sends
`thinking: { type }` plus `reasoning_effort` when enabled.

Thinking-mode tool continuation requires replaying committed CoT: the Turn Loop adds a portable
`{ type: "reasoning", text }` part on assistant messages that proposed Actions. Responses maps that part to a
`reasoning` input item; Chat Completions maps it to `reasoning_content`. Cross-Run history restore does not
revive that CoT. Qi remains stateless toward the provider (`store: false`, no `previous_response_id`).

## Volcengine Agent Plan

The `volcengine-agent-plan` profile targets the Agent Plan Responses endpoint
`https://ark.cn-beijing.volces.com/api/plan/v3` (`ARK_API_KEY` / `ARK_BASE_URL` / `ARK_MODEL`).
Default model is `glm-latest`. `requestMetadata` is off. Deep thinking follows the vendor Responses
control shape ([深度思考](https://console.volcengine.com/ark/region:cn-beijing/docs/82379/1956279?lang=zh#dc4c1547)):

| Operator effort | Wire |
| --- | --- |
| `low` / `medium` / `high` | `thinking: { type: "enabled" }` + `reasoning: { effort }` |
| `none` | `thinking: { type: "disabled" }` (no `reasoning.effort`) |

| Model | Context | Thinking |
| --- | ---: | --- |
| `glm-latest` | 1,048,576 | `low` / `medium` / `high`, default `high` |
| `glm-5.2` | 1,048,576 | same |
| `ark-code-latest` | 256,000 | same |
| `doubao-seed-2.0-code` | 256,000 | same |
| `minimax-m2.7` | 200,000 | none (omit `thinking` / `reasoning`) |
| `kimi-k2.6` | 256,000 | none |
| `kimi-k2.7-code` | 256,000 | none |

Output reserve is sent as Responses `max_output_tokens` (for example `1024` when configured). Catalog
models recommend a 65,536-token reserve; the CLI Max output tokens control remains the operator
configuration surface. Qi stays stateless (`store: false`, no `previous_response_id`).

## Qianwen AI Token Plan

The `qianwenai` profile targets **Token Plan** (personal/team) OpenAI-compatible Responses at
`https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
(`QIANWENAI_API_KEY` / `QIANWENAI_BASE_URL` / `QIANWENAI_MODEL`). Token Plan keys are `sk-sp-…` and must
not be mixed with pay-as-you-go DashScope (`dashscope.aliyuncs.com` + `sk-ws-…`). See
[个人版快速开始](https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-quickstart) and
[Responses API](https://platform.qianwenai.com/docs/api-reference/chat/openai-responses).

Default model is `qwen3.8-max-preview`. `requestMetadata` is off. Qwen catalog models use Responses with
vendor `reasoning.effort`. Third-party plan models (`glm-5-2`, `deepseek-v4-pro`) are not in the Responses
model enum and use Chat Completions on the same host (`enable_thinking` + `reasoning_effort`). Note the
wire id is `glm-5-2` (hyphen), not `glm-5.2`. Qi stays stateless (`store: false`, no `previous_response_id`,
no session-cache header). Built-in Harness tools and multimodal generation endpoints remain out of the
portable Tool surface.

| Model | Wire | Context | Modalities | Thinking |
| --- | --- | ---: | --- | --- |
| `qwen3.8-max-preview` | Responses | 1,048,576 | text + image | `low` / `medium` / `high` / `max`, default `high` |
| `qwen3.7-max` | Responses | 1,048,576 | text | same |
| `qwen3.7-plus` | Responses | 1,048,576 | text + image | same |
| `glm-5-2` | Chat Completions | 1,048,576 | text | same (`enable_thinking`) |
| `deepseek-v4-pro` | Chat Completions | 1,048,576 | text | same (`enable_thinking`) |

Catalog models recommend a 65,536-token output reserve; `/model` Max output tokens maps to Responses
`max_output_tokens` or Chat Completions `max_tokens`.
