import type { RuntimeActivity, TurnResult } from "@civaapple/qi-agent/loop";
import type { SessionEvent } from "@civaapple/qi-protocol";
import { ensureProjectLayout, projectPaths } from "@civaapple/qi-node/paths";
import { AuthSession } from "./auth.js";
import { AuthBackedModelPort } from "./auth-model-port.js";
import { refreshLaunchCapabilities, type HeadlessOutputFormat, type TuiCliOptions } from "./cli.js";
import { providerModelOutputReserveTokens } from "@civaapple/qi-ai";
import {
  contextBudgetFromWindow,
  resolveOutputReserveTokens,
  TuiRuntime,
} from "./runtime.js";

export interface HeadlessIo {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly now?: () => number;
}

const defaultIo: HeadlessIo = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  now: () => Date.now(),
};

/**
 * Process exit codes for one-shot print mode.
 * Outcomes stay distinct: do not collapse parked/cancelled/failed into one boolean.
 */
export function exitCodeForTurnStatus(status: TurnResult["status"]): number {
  switch (status) {
    case "completed":
      return 0;
    case "cancelled":
      return 130;
    case "parked":
      return 2;
    case "failed":
      return 1;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function formatHeadlessText(result: TurnResult): string {
  const text = result.text ?? "";
  if (text.length === 0) return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}

export interface HeadlessJsonResult {
  readonly type: "result";
  readonly subtype: "success" | "failed" | "cancelled" | "parked";
  readonly is_error: boolean;
  readonly duration_ms: number;
  readonly result: string;
  readonly session_id: string;
  readonly run_id: string;
  readonly status: TurnResult["status"];
  readonly model?: string;
  readonly provider?: string;
  readonly mode?: string;
}

export function formatHeadlessJson(
  result: TurnResult,
  meta: {
    readonly durationMs: number;
    readonly model?: string;
    readonly provider?: string;
    readonly mode?: string;
  },
): string {
  const body: HeadlessJsonResult = {
    type: "result",
    subtype: result.status === "completed" ? "success" : result.status,
    is_error: result.status !== "completed",
    duration_ms: meta.durationMs,
    result: result.text ?? "",
    session_id: result.sessionId,
    run_id: result.runId,
    status: result.status,
    ...(meta.model === undefined ? {} : { model: meta.model }),
    ...(meta.provider === undefined ? {} : { provider: meta.provider }),
    ...(meta.mode === undefined ? {} : { mode: meta.mode }),
  };
  return `${JSON.stringify(body)}\n`;
}

export function formatStreamJsonLine(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Project provisional model text activity into stream-json assistant deltas.
 * Only used with `--stream-partial-output`. Model activity is cumulative text;
 * callers may emit repeated full snapshots — consumers that need pure deltas
 * should diff consecutive `message.content[0].text` values.
 */
export function streamPartialFromActivity(
  activity: RuntimeActivity,
  sessionId?: string,
): Record<string, unknown> | undefined {
  if (activity.type !== "model.text") return undefined;
  const text = activity.text;
  if (!text) return undefined;
  return {
    type: "assistant",
    timestamp_ms: Date.now(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    session_id: sessionId ?? activity.sessionId,
  };
}

export async function runHeadlessPrint(
  options: TuiCliOptions,
  io: HeadlessIo = defaultIo,
): Promise<number> {
  const prompt = options.printPrompt?.trim();
  if (!prompt) {
    io.writeStderr("Print mode requires a non-empty prompt.\n");
    return 1;
  }
  const format: HeadlessOutputFormat = options.outputFormat ?? "text";
  const paths = projectPaths({
    workspaceRoot: options.workspaceRoot,
    dataRoot: options.dataRoot,
  });
  await ensureProjectLayout(paths);

  const auth = await AuthSession.create({
    config: options.provider,
    contextWindowTokens: options.contextWindowTokens,
    contextWindowTokensOverride: options.contextWindowTokensOverride,
  });
  const authStatus = auth.status();
  if (authStatus.authStatus !== "ready") {
    io.writeStderr(
      "Provider auth is not ready. Configure credentials (environment key or interactive `/login`) before -p/--print.\n",
    );
    return 1;
  }
  await auth.useAccount(authStatus.provider, authStatus.accountAlias, undefined, "session");

  if (options.sessionId) {
    // Resume uses stored model configuration when present (same as interactive path).
    const { SessionRepository } = await import("@civaapple/qi-node/storage");
    const repository = new SessionRepository(paths);
    try {
      await repository.recover();
      const configured = repository.load(options.sessionId)?.modelConfiguration;
      if (configured) {
        await auth.useAccount(configured.provider, configured.accountAlias, {
          model: configured.model,
          ...(configured.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: configured.reasoningEffort }),
          contextWindowTokens: configured.contextWindowTokens,
          imageInput: configured.imageInput,
        }, "session");
      }
    } finally {
      repository.close();
    }
  }

  const ready = auth.status();
  const policy = await refreshLaunchCapabilities(options);
  const contextWindowTokens = ready.contextWindowTokens;
  const outputReserveTokens = resolveOutputReserveTokens(
    contextWindowTokens,
    policy.outputReserveTokensPreferred
      ?? options.outputReserveTokensPreferred
      ?? providerModelOutputReserveTokens(auth.config.profile, auth.config.model),
  );

  let streamSessionId: string | undefined;
  let runtime: TuiRuntime | undefined;
  const started = (io.now ?? Date.now)();

  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: options.workspaceRoot,
      dataRoot: options.dataRoot,
      qiHome: paths.qiHome,
      projectId: paths.projectId,
      memoryEnabled: options.memoryEnabled,
      memoryAutoAcceptProject: options.memoryAutoAcceptProject,
      enableQiSessionInspect: options.enableQiSessionInspect,
      image: options.image,
      modelPort: new AuthBackedModelPort(auth),
      model: { provider: auth.config.provider, model: auth.config.model },
      resolveModel: () => ({
        provider: auth.config.provider,
        model: auth.config.model,
      }),
      contextWindowTokens,
      contextWindowTokensOverride: ready.contextWindowTokensOverride,
      outputReserveTokens,
      ...(policy.outputReserveTokensPreferred === undefined
        && options.outputReserveTokensPreferred === undefined
        ? {}
        : {
            outputReserveTokensPreferred: policy.outputReserveTokensPreferred
              ?? options.outputReserveTokensPreferred,
          }),
      maxSteps: policy.maxSteps,
      maxActionsPerStep: policy.maxActionsPerStep,
      delegateConfig: policy.delegateConfig,
      allowWrite: policy.allowWrite,
      allowVerify: policy.allowVerify,
      allowExecute: policy.allowExecute,
      allowNetwork: policy.allowNetwork,
      allowBackground: policy.allowBackground,
      allowDelegate: policy.allowDelegate,
      allowPublish: policy.allowPublish,
      allowSpend: policy.allowSpend,
      ...(policy.shell === undefined ? {} : { shell: policy.shell }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      projectConfigPath: policy.projectConfigPath,
      mounts: options.mounts,
      interactiveQuestions: false,
      onEvent: (_event: SessionEvent) => {
        // Committed facts remain in Session storage; print formats project TurnResult.
      },
      onActivity: (activity: RuntimeActivity) => {
        if (!options.streamPartialOutput || format !== "stream-json") return;
        const line = streamPartialFromActivity(activity, streamSessionId ?? runtime?.sessionId);
        if (line) io.writeStdout(formatStreamJsonLine(line));
      },
    });

    streamSessionId = runtime.sessionId;
    if (options.sessionMode && runtime.mode() !== options.sessionMode) {
      runtime.changeMode(options.sessionMode, `CLI --mode ${options.sessionMode}`);
    }

    if (format === "stream-json") {
      io.writeStdout(formatStreamJsonLine({
        type: "system",
        subtype: "init",
        cwd: options.workspaceRoot,
        session_id: runtime.sessionId,
        model: auth.config.model,
        provider: auth.config.provider,
        mode: runtime.mode(),
        permissionMode: "capability",
        context_budget: contextBudgetFromWindow(contextWindowTokens, outputReserveTokens),
      }));
      io.writeStdout(formatStreamJsonLine({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
        session_id: runtime.sessionId,
      }));
    }

    const result = await runtime.run(prompt);
    const durationMs = Math.max(0, (io.now ?? Date.now)() - started);
    const mode = runtime.mode();

    if (format === "text") {
      io.writeStdout(formatHeadlessText(result));
    } else if (format === "json") {
      io.writeStdout(formatHeadlessJson(result, {
        durationMs,
        model: auth.config.model,
        provider: auth.config.provider,
        mode,
      }));
    } else {
      // Final assistant message (skip if we already streamed partials that equal full text —
      // consumers use timestamp_ms without model_call_id for deltas; this is the turn-complete flush).
      if (result.text) {
        io.writeStdout(formatStreamJsonLine({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: result.text }],
          },
          session_id: result.sessionId,
        }));
      }
      io.writeStdout(formatStreamJsonLine({
        type: "result",
        subtype: result.status === "completed" ? "success" : result.status,
        is_error: result.status !== "completed",
        duration_ms: durationMs,
        result: result.text ?? "",
        session_id: result.sessionId,
        run_id: result.runId,
        status: result.status,
      }));
    }

    // Human gates (path grant, plan review, ask_question) fail closed in print mode when they
    // park or fail the Run — exit codes preserve the distinct outcome.
    return exitCodeForTurnStatus(result.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (format === "json") {
      io.writeStdout(`${JSON.stringify({
        type: "result",
        subtype: "failed",
        is_error: true,
        duration_ms: Math.max(0, (io.now ?? Date.now)() - started),
        result: "",
        error: message,
        status: "failed",
      })}\n`);
    } else if (format === "stream-json") {
      io.writeStdout(formatStreamJsonLine({
        type: "result",
        subtype: "failed",
        is_error: true,
        duration_ms: Math.max(0, (io.now ?? Date.now)() - started),
        result: "",
        error: message,
        status: "failed",
      }));
    }
    io.writeStderr(`${message}\n`);
    return 1;
  } finally {
    await runtime?.close();
  }
}
