import { resolve } from "node:path";
import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  type AgentApp,
  type AuthenticateRequest,
  type ContentBlock,
  type InitializeRequest,
  type NewSessionRequest,
  type PromptRequest,
  type SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import { createId, type SessionId } from "@civaapple/qi-protocol";
import type { TuiCliOptions } from "../cli.js";
import { qiCliVersion } from "../cli.js";
import { acpLog } from "./log.js";
import {
  DEFAULT_QI_ACP_MODE,
  QI_ACP_MODES,
  isQiAcpModeId,
  type QiAcpModeId,
} from "./modes.js";
import type { AcpRuntimeFactory } from "./runtime-factory.js";
import { QiAcpSession } from "./session.js";

export interface QiAcpServerOptions {
  readonly launch: TuiCliOptions;
  readonly factory: AcpRuntimeFactory;
  readonly agentName?: string;
  readonly agentVersion?: string;
}

export interface QiAcpAgentHandle {
  readonly app: AgentApp;
  /** Close every open Qi Runtime (tests / process shutdown). */
  closeAll(): Promise<void>;
}

/**
 * Build a fluent ACP AgentApp wired to Qi's Runtime.
 * Call `.app.connect(stream)` or `.app.connect(clientApp)` for tests.
 */
export function createQiAcpAgent(options: QiAcpServerOptions): QiAcpAgentHandle {
  const sessions = new Map<string, QiAcpSession>();
  const factory = options.factory;
  const launch = options.launch;
  const agentName = options.agentName ?? "Qi";
  const agentVersion = options.agentVersion ?? qiCliVersion().replace(/^qi\s+/i, "");
  let authed = false;

  const app = agent({ name: agentName })
    .onRequest(methods.agent.initialize, async (ctx) => {
      try {
        const params = (ctx.params ?? {}) as InitializeRequest;
        acpLog("initialize", {
          protocolVersion: params.protocolVersion,
          client: params.clientInfo,
        });
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: {
              image: false,
              audio: false,
              embeddedContext: false,
            },
            mcpCapabilities: {
              http: false,
              sse: false,
            },
          },
          agentInfo: {
            name: agentName,
            version: agentVersion,
          },
          authMethods: [
            {
              id: "qi_login",
              name: "Qi provider credentials",
              description:
                "Use environment API keys or a prior interactive `/login` sealed account under QI_HOME. Secrets are never sent over ACP.",
            },
          ],
        };
      } catch (error) {
        throw toRequestError("initialize", error);
      }
    })
    // Lenient authenticate — VS Code may omit methodId after advertising a single method.
    .onRequest(
      methods.agent.authenticate,
      {
        parse(raw: unknown): AuthenticateRequest {
          const p = asRecord(raw);
          const methodId = typeof p.methodId === "string" && p.methodId.trim()
            ? p.methodId.trim()
            : typeof p.method_id === "string" && p.method_id.trim()
              ? p.method_id.trim()
              : "qi_login";
          return { methodId };
        },
      },
      async (ctx) => {
        try {
          const methodId = ctx.params.methodId || "qi_login";
          if (methodId !== "qi_login") {
            throw RequestError.invalidParams(
              { methodId },
              `Unknown auth method: ${methodId} (Qi only supports qi_login)`,
            );
          }
          let ready = false;
          try {
            ready = await factory.isAuthReady(launch);
          } catch (error) {
            acpLog("auth check failed", error instanceof Error ? error.message : String(error));
            throw RequestError.authRequired({
              reason: error instanceof Error ? error.message : String(error),
              hint: "Run `qi` interactively and /login, or set provider API keys in the environment used by VS Code.",
            });
          }
          if (!ready) {
            throw RequestError.authRequired({
              hint: "Provider credentials not ready. Interactive /login or env API key required before qi acp.",
              provider: launch.provider.provider,
              model: launch.provider.model,
              qiHome: process.env.QI_HOME ?? "(default ~/.qi)",
            });
          }
          authed = true;
          acpLog("authenticate ok", { provider: launch.provider.provider, model: launch.provider.model });
          return {};
        } catch (error) {
          throw toRequestError("authenticate", error);
        }
      },
    )
    // Lenient session/new — SDK zod requires mcpServers; some clients omit the field entirely.
    .onRequest(
      methods.agent.session.new,
      {
        parse(raw: unknown): NewSessionRequest {
          const p = asRecord(raw);
          const cwd = typeof p.cwd === "string" && p.cwd.trim()
            ? p.cwd.trim()
            : launch.workspaceRoot;
          const mcpServers = Array.isArray(p.mcpServers) ? p.mcpServers : [];
          const additionalDirectories = Array.isArray(p.additionalDirectories)
            ? p.additionalDirectories.filter((x): x is string => typeof x === "string")
            : undefined;
          return {
            cwd,
            mcpServers: mcpServers as NewSessionRequest["mcpServers"],
            ...(additionalDirectories === undefined ? {} : { additionalDirectories }),
          };
        },
      },
      async (ctx) => {
        try {
          if (!authed) {
            let ready = false;
            try {
              ready = await factory.isAuthReady(launch);
            } catch (error) {
              throw RequestError.authRequired({
                reason: error instanceof Error ? error.message : String(error),
              });
            }
            if (!ready) throw RequestError.authRequired();
            authed = true;
          }
          const params = ctx.params;
          const cwd = resolve(params.cwd || launch.workspaceRoot);
          if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
            acpLog("ignoring client mcpServers (Qi keeps MCP quarantine + human bind)", {
              count: params.mcpServers.length,
            });
          }
          const sessionId = createId("ses") as SessionId;
          const mode: QiAcpModeId = launch.sessionMode ?? DEFAULT_QI_ACP_MODE;
          const session = new QiAcpSession(sessionId, launch, cwd, mode, factory);
          sessions.set(sessionId, session);
          acpLog("session/new", { sessionId, cwd, mode });
          return {
            sessionId,
            modes: {
              currentModeId: mode,
              availableModes: [...QI_ACP_MODES],
            },
            _meta: {
              qi: {
                sessionId,
                workspace: cwd,
              },
            },
          };
        } catch (error) {
          throw toRequestError("session/new", error);
        }
      },
    )
    .onRequest(methods.agent.session.setMode, async (ctx) => {
      try {
        const params = ctx.params as SetSessionModeRequest;
        const session = sessions.get(params.sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            { sessionId: params.sessionId },
            `Unknown session ${params.sessionId}`,
          );
        }
        const mapped = mapClientModeId(params.modeId);
        if (!mapped) {
          acpLog("session/set_mode ignored unknown mode", { modeId: params.modeId });
          // Do not fail the handshake — VS Code may probe foreign mode ids.
          return {};
        }
        session.setMode(mapped);
        acpLog("session/set_mode", { sessionId: params.sessionId, mode: mapped });
        return {};
      } catch (error) {
        throw toRequestError("session/set_mode", error);
      }
    })
    // VS Code ACP Client may call this after session/new; return empty options (no-op).
    .onRequest(
      methods.agent.session.setConfigOption,
      {
        parse(raw: unknown): { sessionId: string; configId: string; value: string } {
          const p = asRecord(raw);
          return {
            sessionId: String(p.sessionId ?? ""),
            configId: String(p.configId ?? p.config_id ?? ""),
            value: String(p.value ?? ""),
          };
        },
      },
      async (ctx) => {
        acpLog("session/set_config_option (noop)", ctx.params);
        return { configOptions: [] };
      },
    )
    .onRequest(
      methods.agent.session.prompt,
      {
        parse(raw: unknown): PromptRequest {
          const p = asRecord(raw);
          const sessionId = String(p.sessionId ?? "");
          let prompt: ContentBlock[] = [];
          if (Array.isArray(p.prompt)) {
            prompt = p.prompt as ContentBlock[];
          } else if (typeof p.prompt === "string") {
            prompt = [{ type: "text", text: p.prompt }];
          } else if (typeof p.text === "string") {
            prompt = [{ type: "text", text: p.text }];
          }
          return { sessionId, prompt };
        },
      },
      async (ctx) => {
        try {
          const params = ctx.params;
          const session = sessions.get(params.sessionId);
          if (!session) {
            throw RequestError.invalidParams(
              { sessionId: params.sessionId },
              `Unknown session ${params.sessionId}`,
            );
          }
          return await session.prompt(params.prompt ?? [], ctx.client);
        } catch (error) {
          throw toRequestError("session/prompt", error);
        }
      },
    )
    .onNotification(methods.agent.session.cancel, async (ctx) => {
      const params = asRecord(ctx.params);
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      if (!sessionId) return;
      sessions.get(sessionId)?.cancel();
    });

  return {
    app,
    async closeAll() {
      await closeAllQiAcpSessions(sessions);
    },
  };
}

/** Close all sessions (tests / process shutdown). */
export async function closeAllQiAcpSessions(sessions: Map<string, QiAcpSession>): Promise<void> {
  await Promise.all([...sessions.values()].map((session) => session.close()));
  sessions.clear();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Map common foreign ACP mode ids onto Qi ask|plan|agent. */
function mapClientModeId(modeId: unknown): QiAcpModeId | undefined {
  if (isQiAcpModeId(modeId)) return modeId;
  if (typeof modeId !== "string") return undefined;
  const id = modeId.trim().toLowerCase();
  if (id === "default" || id === "code" || id === "edit" || id === "auto" || id === "yolo") {
    return "agent";
  }
  if (id === "ask" || id === "chat" || id === "readonly" || id === "read-only") return "ask";
  if (id === "plan" || id === "planning") return "plan";
  return undefined;
}

function toRequestError(where: string, error: unknown): RequestError {
  if (error instanceof RequestError) {
    acpLog(`${where} error`, { code: error.code, message: error.message, data: error.data });
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  // Operator-facing validation (image/model mismatch, auth messaging) should not look like a crash.
  if (/does not support image input|image path or URL/i.test(message)) {
    acpLog(`${where} invalid params`, { message });
    return RequestError.invalidParams({ where, message }, message);
  }
  acpLog(`${where} internal error`, { message, stack });
  return RequestError.internalError(
    { where, message, ...(stack === undefined ? {} : { stack: stack.split("\n").slice(0, 8) }) },
    message,
  );
}
