# ACP (`qi acp`)

Qi speaks the [Agent Client Protocol](https://agentclientprotocol.com/) over stdio so IDE clients
(Zed, JetBrains AI Chat, custom front-ends) can drive a local Session without a second Runtime.

```sh
qi acp
qi acp --workspace /path/to/project --safe
qi acp --mode ask --allow-write
```

Launch flags after `acp` are the same capability / workspace options as interactive `qi` (parsed by
`parseTuiCliArguments`). There is **no banner** on stdout — only JSON-RPC NDJSON. Logs go to stderr.

## Architecture

```text
IDE client  --stdio JSON-RPC-->  qi acp  -->  TuiRuntime (same Kernel/Loop as TUI/headless)
```

- Single-writer execution owner remains the `qi` process (ADR-0016).
- Session events stay durable truth; ACP `session/update` is a projection.
- Modes advertised to clients: **`ask` | `plan` | `agent`** (not Kimi-style yolo/auto).
- Capabilities still come from CLI flags / project policy / user config — never from ACP metadata.
- Client-supplied `mcpServers` are ignored with a stderr warning (MCP stays quarantined until human bind).

## Method coverage (MVP)

| Method | Status |
| --- | --- |
| `initialize` | Yes — protocol v1, conservative capabilities |
| `authenticate` (`qi_login`) | Yes — checks sealed/env credentials; no secrets on wire |
| `session/new` | Yes — `cwd`, modes; **sessionId is Qi `ses_…`** (same as Web); ignores MCP inject |
| `session/set_mode` | Yes — ask/plan/agent |
| `session/prompt` | Yes — text blocks; streams `agent_message_chunk` + tool updates |
| `session/cancel` | Yes |
| `session/load` / `list` / `fs/*` / client MCP | Deferred |

### Stop reasons

ACP `stopReason` values are limited (`end_turn` | `cancelled` | `refusal` | …). Qi maps:

| TurnResult.status | stopReason | Notes |
| --- | --- | --- |
| `completed` | `end_turn` | |
| `cancelled` | `cancelled` | |
| `parked` / `failed` | `refusal` | Full status in `_meta.qi` and stderr |

## Auth

1. Configure credentials once: interactive `/login` or provider env keys.
2. IDE launches `qi acp`; client calls `authenticate` with `methodId: "qi_login"` (methodId may be omitted).
3. Secrets never appear in ACP messages.

### “Internal error” after connect or first prompt

Common causes (stderr now logs details under `[qi acp] …`):

| Cause | Fix |
| --- | --- |
| Auth not ready | Same `QI_HOME` as interactive login; env API keys visible to VS Code process |
| Client omitted `mcpServers` | Handled: Qi defaults to `[]` |
| Unknown `session/set_mode` | Unknown ids are ignored; `default`→`agent` |
| Prompt with doc URLs / `.png` names on a text-only model | Auto-detect no longer aborts; URLs stay text (ADR-0028). Real image *parts* still need vision / enable image input |
| Uncaught exception | See stderr stack; rebuild and Restart Agent |

Use **ACP: Show Log** + **Protocol Traffic**. Prefer Restart Agent after every `npm run build`.

**Note:** Pasting documentation HTML links alone on a line (e.g. Kimi ACP reference pages) used to surface as
`Internal error: … does not support image input` before any Run started. That path is fixed; the Session Web
link only appears empty when the prompt never reached `runtime.run`.

## Streaming policy (VS Code / IDE stability)

### Why replies looked “切得很散”

Token-level (or 75ms) streaming sends **many** `agent_message_chunk` events for one
assistant utterance. VS Code ACP Client often renders each chunk as a separate fragment.

### Default (recommended)

| When | Wire event |
| --- | --- |
| Step model finishes (`model.completed`) | **one** `agent_message_chunk` with the full Step text |
| Tools | `tool_call` + terminal `tool_call_update` |
| Multi-Step | `message → tools → message → tools` |

No provisional token stream; no thought stream.

### Optional live streaming

| Env | Default | Meaning |
| --- | --- | --- |
| `QI_ACP_STREAM_TEXT` | off | `1` = progressive assistant text (same timer/size rules) |
| `QI_ACP_STREAM_THOUGHTS` | off | `1` = progressive thinking ~every 5s; `end` = only at Step end |
| `QI_ACP_COALESCE_MS` | `5000` (when thoughts=1) | Thought/text refresh interval |
| `QI_ACP_COALESCE_CHARS` / `QI_ACP_THOUGHT_MAX_CHARS` | `3500` | Max chars per thought/text notify |

Tool cards remain two-shot; raw tool payloads capped (~2KB).

### Thinking progress (`QI_ACP_STREAM_THOUGHTS=1`)

Wire type: `sessionUpdate: "agent_thought_chunk"`.

| Value | Behavior |
| --- | --- |
| unset / `0` | No thinking in IDE |
| **`1` / `true` / `on`** | **Progressive:** about every **5s**, send up to **~3500** chars of the **newest** unsent thought (not typewriter; not one giant dump) |
| `end` | One bounded block only at `model.completed` |
| `live` | Same progressive mode with **1.5s** default interval |

**Size rule:** each notify ≤ ~3500 characters. If 5s produced more unsent text, IDE gets the
**latest window** (prefix `…`) so you see current progress; full CoT stays in Session/Web.

**Step end:** remaining thought is flushed (still size-capped), then the Step’s assistant message,
then tools — so order stays `thought progress… → message → tools`.

**Ordering guarantee:** Session event projection is **serialized** (no parallel
`model.completed` / `action.proposed` handlers). Wire order is always
`message → tool_call → tool_call_update` per Step. If an older client UI still
collapses all tools into one block, check Protocol Traffic for this interleaving;
a collapsed UI is a client render issue only when the log already alternates correctly.

Recommended:

```json
"env": {
  "QI_HOME": "C:\\Users\\<you>\\.qi",
  "QI_ACP_STREAM_THOUGHTS": "1",
  "QI_ACP_COALESCE_MS": "5000",
  "QI_ACP_THOUGHT_MAX_CHARS": "3500"
}
```

Faster progress (still capped): `"QI_ACP_COALESCE_MS": "3000"`.  
Rebuild (`npm run build`) and **Restart Agent** after env changes.

## VS Code (ACP Client extension)

Install [ACP Client](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client), then
add a custom agent (use **real** paths — do not copy placeholders like `你的用户名`):

```json
{
  "acp.agents": {
    "Qi": {
      "command": "node",
      "args": [
        "D:\\ai-project\\qi\\apps\\cli\\dist\\main.js",
        "acp",
        "--mode",
        "agent"
      ],
      "env": {}
    }
  },
  "acp.autoApprovePermissions": "ask"
}
```

Omit `QI_HOME` unless you need a non-default root (`%USERPROFILE%\\.qi` on Windows). After code
changes, rebuild (`npm run build`) and **Restart Agent** in the extension.

## Zed configuration

```json
{
  "agent_servers": {
    "Qi": {
      "type": "custom",
      "command": "qi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Use an absolute path for `command` when the IDE GUI does not inherit your shell `PATH`.

## Comparison to Kimi Code

Qi’s package layout is intentionally smaller (under `apps/cli/src/acp/`) but follows the same patterns:

- official `@agentclientprotocol/sdk`
- stdout protocol purity / stderr logs
- events-map + session wrapper around the engine
- modes and permission policy remain product-specific (Qi capabilities vs Kimi yolo)

## Implementation map

| File | Role |
| --- | --- |
| `apps/cli/src/acp/run.ts` | `qi acp` entry, stdio stream |
| `apps/cli/src/acp/server.ts` | AgentApp handlers |
| `apps/cli/src/acp/session.ts` | Per-session Runtime + prompt |
| `apps/cli/src/acp/events-map.ts` | Activity/events → session/update |
| `apps/cli/src/acp/runtime-factory.ts` | Auth-backed or test ModelPort factories |
| `apps/cli/src/acp/modes.ts` | ask/plan/agent registry |
