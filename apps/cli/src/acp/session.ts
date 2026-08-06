import type { AgentContext, ContentBlock, PromptResponse, StopReason } from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import type { SessionMode } from "@civaapple/qi-agent/kernel";
import type { RuntimeActivity } from "@civaapple/qi-agent/loop";
import type { SessionEvent, SessionId } from "@civaapple/qi-protocol";
import type { TuiCliOptions } from "../cli.js";
import type { TuiRuntime } from "../runtime.js";
import {
  contentBlocksToPromptText,
  finalTextChunk,
  sessionEventToToolUpdates,
  turnStatusToStopReason,
} from "./events-map.js";
import { acpLog } from "./log.js";
import type { QiAcpModeId } from "./modes.js";
import type { AcpRuntimeFactory } from "./runtime-factory.js";
import {
  boundThoughtForAcp,
  cumulativeToDelta,
  resolveAcpStreamPolicy,
  takeProgressiveThoughtSlice,
  type AcpStreamPolicy,
} from "./stream-policy.js";

export class QiAcpSession {
  /** Wire + durable Qi SessionId (`ses_…`) — same value VS Code and Web use. */
  readonly acpSessionId: SessionId;
  readonly workspaceRoot: string;
  #mode: QiAcpModeId;
  #runtime: TuiRuntime | undefined;
  #pendingAbort: AbortController | undefined;
  #client: AgentContext | undefined;
  #lastAssistantText = "";
  #policy: AcpStreamPolicy;
  /** Latest cumulative reasoning from the model (this Step). */
  #thoughtFull = "";
  /** How much of #thoughtFull has been accounted for in IDE notifies. */
  #thoughtFlushedTo = 0;
  /** Coalesced live assistant text (only when streamText). */
  #pendingText = "";
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Serialize notify so we never pile concurrent JSON-RPC writes. */
  #notifyChain: Promise<void> = Promise.resolve();
  /**
   * Serialize Session event projection. Without this, `void onSessionEvent`
   * races: action.proposed tool_call can emit *before* model.completed's
   * agent_message_chunk, and VS Code ACP Client then collapses the timeline
   * into “one reply + all tools”.
   */
  #eventChain: Promise<void> = Promise.resolve();

  constructor(
    acpSessionId: SessionId,
    private readonly launch: TuiCliOptions,
    workspaceRoot: string,
    mode: QiAcpModeId,
    private readonly factory: AcpRuntimeFactory,
    policy: AcpStreamPolicy = resolveAcpStreamPolicy(),
  ) {
    this.acpSessionId = acpSessionId;
    this.workspaceRoot = workspaceRoot;
    this.#mode = mode;
    this.#policy = policy;
  }

  mode(): QiAcpModeId {
    return this.#mode;
  }

  setMode(mode: QiAcpModeId): void {
    this.#mode = mode;
    if (this.#runtime && this.#runtime.mode() !== mode) {
      this.#runtime.changeMode(mode as SessionMode, `ACP set_mode ${mode}`);
    }
  }

  async ensureRuntime(client: AgentContext): Promise<TuiRuntime> {
    this.#client = client;
    if (this.#runtime) return this.#runtime;
    this.#runtime = await this.factory.create({
      launch: this.launch,
      workspaceRoot: this.workspaceRoot,
      sessionId: this.acpSessionId,
      mode: this.#mode,
      hooks: {
        onEvent: (event) => {
          this.#enqueueSessionEvent(event);
        },
        onActivity: (activity) => {
          this.#onActivity(activity);
        },
      },
    });
    return this.#runtime;
  }

  #enqueueSessionEvent(event: SessionEvent): void {
    this.#eventChain = this.#eventChain
      .then(() => this.#onSessionEvent(event))
      .catch((error: unknown) => {
        acpLog("session event projection failed", error instanceof Error ? error.message : String(error));
      });
  }

  async #drainEventChain(): Promise<void> {
    await this.#eventChain;
  }

  async prompt(prompt: readonly ContentBlock[], client: AgentContext): Promise<PromptResponse> {
    this.#pendingAbort?.abort();
    const abort = new AbortController();
    this.#pendingAbort = abort;
    this.#resetStepStreamState();
    this.#clearFlushTimer();

    const text = contentBlocksToPromptText(prompt);
    if (!text) {
      return { stopReason: "end_turn" };
    }

    try {
      const runtime = await this.ensureRuntime(client);
      if (abort.signal.aborted) return { stopReason: "cancelled" };

      const result = await runtime.run(text);
      if (abort.signal.aborted) return { stopReason: "cancelled" };

      // Wait for every model.completed / tool projection to finish in order.
      await this.#drainEventChain();
      await this.#flushPendingText();
      await this.#flushThoughts(true);

      if (result.text) {
        const { delta, next } = cumulativeToDelta(this.#lastAssistantText, result.text);
        this.#lastAssistantText = next;
        if (delta) {
          const chunk = finalTextChunk(this.acpSessionId, delta);
          if (chunk) await this.#notify(chunk);
        }
      }

      const stopReason = turnStatusToStopReason(result.status);
      if (result.status !== "completed") {
        acpLog("turn non-completed", {
          sessionId: this.acpSessionId,
          runId: result.runId,
          status: result.status,
          stopReason,
        });
      }
      return {
        stopReason,
        _meta: {
          qi: {
            status: result.status,
            runId: result.runId,
            sessionId: result.sessionId,
          },
        },
      };
    } catch (error) {
      if (abort.signal.aborted) return { stopReason: "cancelled" as StopReason };
      acpLog("prompt failed", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.#clearFlushTimer();
      if (this.#pendingAbort === abort) this.#pendingAbort = undefined;
    }
  }

  cancel(): void {
    this.#pendingAbort?.abort();
    this.#runtime?.cancel("ACP session/cancel");
  }

  async close(): Promise<void> {
    this.cancel();
    this.#clearFlushTimer();
    await this.#runtime?.close();
    this.#runtime = undefined;
  }

  #resetStepStreamState(): void {
    this.#lastAssistantText = "";
    this.#thoughtFull = "";
    this.#thoughtFlushedTo = 0;
    this.#pendingText = "";
  }

  #onActivity(activity: RuntimeActivity): void {
    if (activity.type === "model.text") {
      if (!this.#policy.streamText) return;
      const { delta, next } = cumulativeToDelta(this.#lastAssistantText, activity.text);
      this.#lastAssistantText = next;
      if (!delta) return;
      this.#pendingText += delta;
      this.#scheduleFlush();
      return;
    }
    if (activity.type === "model.reasoning") {
      if (this.#policy.thoughts !== "progressive") return;
      const full = activity.text;
      if (!full) return;
      // Track full cumulative CoT; progressive flushes emit newest unsent window.
      if (full.startsWith(this.#thoughtFull) || this.#thoughtFull === "" || !this.#thoughtFull.startsWith(full)) {
        this.#thoughtFull = full;
      } else {
        this.#thoughtFull = full;
      }
      this.#scheduleFlush();
    }
  }

  /**
   * Strict per-Step wire order (must not race):
   *   thought progress… → agent_message_chunk → tool_call* → tool_call_update*
   * Progressive thoughts may refresh on a timer; tools never jump the message.
   */
  async #onSessionEvent(event: SessionEvent): Promise<void> {
    if (event.type === "model.completed") {
      // Cancel pending coalesce timer so tools cannot start mid-flush.
      this.#clearFlushTimerOnly();
      await this.#flushPendingText();
      if (this.#policy.thoughts !== "off") {
        const reasoning = typeof event.data.reasoning === "string" ? event.data.reasoning.trim() : "";
        if (reasoning) {
          this.#thoughtFull = reasoning.length >= this.#thoughtFull.length ? reasoning : this.#thoughtFull;
        }
        await this.#flushThoughts(true);
      }

      const committed = typeof event.data.text === "string" ? event.data.text.trim() : "";
      if (committed) {
        if (this.#policy.streamText) {
          const { delta, next } = cumulativeToDelta(this.#lastAssistantText, committed);
          this.#lastAssistantText = next;
          if (delta) {
            await this.#notify({
              sessionId: this.acpSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: delta },
              },
            });
          }
        } else {
          await this.#notify({
            sessionId: this.acpSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: committed },
            },
          });
          this.#lastAssistantText = committed;
        }
      }
      // Keep lastAssistantText for end-of-run safety net; clear thought for next Step.
      this.#thoughtFull = "";
      this.#thoughtFlushedTo = 0;
      this.#pendingText = "";
      return;
    }

    const toolUpdates = sessionEventToToolUpdates(this.acpSessionId, event);
    if (toolUpdates.length === 0) return;
    // Tools only after any in-flight message projection for this Step (serialized via #eventChain).
    await this.#flushPendingText();
    await this.#flushThoughts(true);
    for (const update of toolUpdates) {
      await this.#notify(update as never);
    }
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.#onTimerFlush();
    }, this.#policy.coalesceMs);
  }

  async #onTimerFlush(): Promise<void> {
    await this.#flushPendingText();
    if (this.#policy.thoughts === "progressive") {
      await this.#flushThoughts(false);
    }
    // Keep timer going if more thought is still arriving later — rescheduled from onActivity.
  }

  async #flushPendingText(): Promise<void> {
    this.#clearFlushTimerOnly();
    const text = this.#pendingText;
    this.#pendingText = "";
    if (!text) return;
    // Live text uses same size discipline as thoughts.
    const piece = text.length <= this.#policy.maxChunkChars
      ? text
      : text.slice(-this.#policy.maxChunkChars);
    await this.#notify({
      sessionId: this.acpSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: piece },
      },
    });
  }

  /**
   * @param final When true, emit remaining unsent thought (end-of-step).
   *              When false (timer), emit at most one size-capped window of the newest unsent text.
   */
  async #flushThoughts(final: boolean): Promise<void> {
    if (this.#policy.thoughts === "off") return;
    const full = this.#thoughtFull;
    if (!full || this.#thoughtFlushedTo >= full.length) {
      if (final && this.#policy.thoughts === "end" && full) {
        // end mode: nothing flushed yet — one bounded block.
        const text = boundThoughtForAcp(full, this.#policy.maxChunkChars);
        if (text) {
          await this.#notify({
            sessionId: this.acpSessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text },
            },
          });
          this.#thoughtFlushedTo = full.length;
        }
      }
      return;
    }

    if (this.#policy.thoughts === "end" && !final) return;

    if (this.#policy.thoughts === "end" && final) {
      const text = boundThoughtForAcp(full, this.#policy.maxChunkChars);
      if (text) {
        await this.#notify({
          sessionId: this.acpSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text },
          },
        });
      }
      this.#thoughtFlushedTo = full.length;
      return;
    }

    // progressive
    const unsent = full.slice(this.#thoughtFlushedTo);
    if (!unsent) return;
    const { emit, consumed } = takeProgressiveThoughtSlice(unsent, this.#policy.maxChunkChars);
    if (!emit) return;
    this.#thoughtFlushedTo += consumed;
    await this.#notify({
      sessionId: this.acpSessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: emit },
      },
    });

    // On final, if still more (shouldn't after consumed=all), bound remaining once.
    if (final && this.#thoughtFlushedTo < full.length) {
      const rest = boundThoughtForAcp(full.slice(this.#thoughtFlushedTo), this.#policy.maxChunkChars);
      this.#thoughtFlushedTo = full.length;
      if (rest) {
        await this.#notify({
          sessionId: this.acpSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: rest },
          },
        });
      }
    }
  }

  #clearFlushTimer(): void {
    this.#clearFlushTimerOnly();
  }

  #clearFlushTimerOnly(): void {
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
  }

  async #notify(update: {
    sessionId: string;
    update: Record<string, unknown>;
  }): Promise<void> {
    const client = this.#client;
    if (!client) return;
    this.#notifyChain = this.#notifyChain
      .then(async () => {
        try {
          await client.notify(methods.client.session.update, update as never);
        } catch (error) {
          acpLog("session/update failed", error instanceof Error ? error.message : String(error));
        }
      })
      .catch(() => undefined);
    await this.#notifyChain;
  }
}
