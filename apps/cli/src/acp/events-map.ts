import type {
  ContentBlock,
  SessionNotification,
  StopReason,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { RuntimeActivity, TurnResult } from "@civaapple/qi-agent/loop";
import type { SessionEvent } from "@civaapple/qi-protocol";

/** Extract user text from ACP prompt content blocks (image/resource deferred). */
export function contentBlocksToPromptText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

export function turnStatusToStopReason(status: TurnResult["status"]): StopReason {
  switch (status) {
    case "completed":
      return "end_turn";
    case "cancelled":
      return "cancelled";
    case "parked":
      // ACP has no parked; refuse-like so clients do not treat as success.
      return "refusal";
    case "failed":
      return "refusal";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function activityToSessionUpdate(
  sessionId: string,
  activity: RuntimeActivity,
): SessionNotification | undefined {
  if (activity.type === "model.text" && activity.text) {
    return {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: activity.text },
      },
    };
  }
  if (activity.type === "model.reasoning" && activity.text) {
    return {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: activity.text },
      },
    };
  }
  return undefined;
}

/** Cap raw tool payloads so VS Code ACP Client does not choke on large read/write bodies. */
const RAW_JSON_MAX_CHARS = 2_000;

/**
 * Project committed Session events to tool_call / tool_call_update notifications.
 *
 * Lifecycle is intentionally **two-shot** (not three):
 * - `action.proposed` → `tool_call` (pending)
 * - terminal / denied → `tool_call_update` (completed|failed)
 *
 * We skip `action.started` so parallel multi-tool Steps do not triple traffic
 * (proposed+started+completed) and freeze IDE panels.
 */
export function sessionEventToToolUpdates(
  sessionId: string,
  event: SessionEvent,
): SessionNotification[] {
  if (event.type === "action.proposed") {
    const toolName = event.data.toolName ?? "tool";
    return [{
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: event.data.actionId,
        title: toolName,
        kind: inferToolKind(toolName),
        status: "pending",
        rawInput: boundJson(event.data.input),
      },
    }];
  }
  // Skip action.started — pending + terminal is enough for IDE cards.
  if (event.type === "authority.denied") {
    return [{
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: event.data.actionId,
        status: "failed",
        rawOutput: boundJson({ settlement: "denied", reason: event.data.reason }),
      },
    }];
  }
  if (
    event.type === "action.completed"
    || event.type === "action.failed"
    || event.type === "action.cancelled"
    || event.type === "action.indeterminate"
  ) {
    // ACP ToolCallStatus has no cancelled — map cancelled/indeterminate to failed + settlement meta.
    const status: ToolCallStatus =
      event.type === "action.completed" ? "completed" : "failed";
    return [{
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: event.data.actionId,
        status,
        rawOutput: boundJson({
          settlement: event.type.replace("action.", ""),
          ...(event.type === "action.failed"
            ? { code: event.data.errorCode }
            : {}),
          ...(event.type === "action.indeterminate"
            ? { reason: event.data.reason, reconciliationHint: event.data.reconciliationHint }
            : {}),
          ...(event.type === "action.cancelled"
            ? { reason: event.data.reason }
            : {}),
          // Prefer refs over bodies — full output stays in Session/Artifacts.
          ...(event.type === "action.completed" && event.data.outputRef
            ? { outputRef: event.data.outputRef }
            : {}),
        }),
      },
    }];
  }
  return [];
}

function boundJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const raw = JSON.stringify(value);
    if (raw === undefined) return undefined;
    if (raw.length <= RAW_JSON_MAX_CHARS) return value;
    return {
      truncated: true,
      chars: raw.length,
      preview: raw.slice(0, RAW_JSON_MAX_CHARS),
    };
  } catch {
    return { unserializable: true };
  }
}

export function inferToolKind(name: string): ToolKind {
  const lower = name.toLowerCase();
  if (["read", "list", "tree", "find", "search", "grep", "git"].includes(lower)) return "read";
  if (["edit", "write", "move", "remove"].includes(lower)) return "edit";
  if (["shell", "script", "verify", "codeact"].includes(lower)) return "execute";
  if (["fetch", "web_map", "network"].includes(lower) || lower.includes("fetch")) return "fetch";
  if (lower.includes("think") || lower === "ask_question") return "think";
  return "other";
}

/** Final assistant flush when streaming activity was cumulative (optional full text). */
export function finalTextChunk(sessionId: string, text: string): SessionNotification | undefined {
  if (!text.trim()) return undefined;
  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}
