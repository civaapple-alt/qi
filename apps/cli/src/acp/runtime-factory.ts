import type { ModelPort } from "@civaapple/qi-ai";
import type { RuntimeActivity } from "@civaapple/qi-agent/loop";
import type { SessionEvent, SessionId } from "@civaapple/qi-protocol";
import { ensureProjectLayout, projectPaths } from "@civaapple/qi-node/paths";
import { providerModelOutputReserveTokens } from "@civaapple/qi-ai";
import { AuthSession } from "../auth.js";
import { AuthBackedModelPort } from "../auth-model-port.js";
import { refreshLaunchCapabilities, type TuiCliOptions } from "../cli.js";
import {
  resolveOutputReserveTokens,
  TuiRuntime,
} from "../runtime.js";
import type { SessionMode } from "@civaapple/qi-agent/kernel";

export interface AcpSessionRuntimeHooks {
  readonly onEvent: (event: SessionEvent) => void;
  readonly onActivity: (activity: RuntimeActivity) => void;
}

export interface AcpRuntimeFactory {
  create(input: {
    readonly launch: TuiCliOptions;
    readonly workspaceRoot: string;
    readonly sessionId?: SessionId;
    readonly mode?: SessionMode;
    readonly hooks: AcpSessionRuntimeHooks;
  }): Promise<TuiRuntime>;
  /** True when sealed credentials or env keys make the provider ready. */
  isAuthReady(launch: TuiCliOptions): Promise<boolean>;
}

/**
 * Production factory: AuthSession + AuthBackedModelPort (same stack as headless).
 */
export function createAuthBackedRuntimeFactory(): AcpRuntimeFactory {
  return {
    async isAuthReady(launch) {
      const auth = await AuthSession.create({
        config: launch.provider,
        contextWindowTokens: launch.contextWindowTokens,
        contextWindowTokensOverride: launch.contextWindowTokensOverride,
      });
      return auth.status().authStatus === "ready";
    },
    async create(input) {
      const { launch, workspaceRoot, hooks } = input;
      const options: TuiCliOptions = {
        ...launch,
        workspaceRoot,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      };
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
        throw new Error(
          "Provider auth is not ready. Run interactive /login or set provider API keys before qi acp.",
        );
      }
      await auth.useAccount(authStatus.provider, authStatus.accountAlias, undefined, "session");

      if (options.sessionId) {
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

      const runtime = await TuiRuntime.create({
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
        onEvent: hooks.onEvent,
        onActivity: hooks.onActivity,
      });

      if (input.mode && runtime.mode() !== input.mode) {
        runtime.changeMode(input.mode, `ACP session mode ${input.mode}`);
      }
      return runtime;
    },
  };
}

/** Test factory: inject ModelPort and skip AuthSession. */
export function createTestRuntimeFactory(modelPort: ModelPort): AcpRuntimeFactory {
  return {
    async isAuthReady() {
      return true;
    },
    async create(input) {
      const { launch, workspaceRoot, hooks } = input;
      const paths = projectPaths({
        workspaceRoot,
        dataRoot: launch.dataRoot,
      });
      await ensureProjectLayout(paths);
      const runtime = await TuiRuntime.create({
        workspaceRoot,
        dataRoot: launch.dataRoot,
        qiHome: paths.qiHome,
        projectId: paths.projectId,
        memoryEnabled: launch.memoryEnabled,
        memoryAutoAcceptProject: launch.memoryAutoAcceptProject,
        enableQiSessionInspect: false,
        image: launch.image,
        modelPort,
        model: { provider: "fake", model: "acp-test" },
        maxSteps: launch.maxSteps,
        maxActionsPerStep: launch.maxActionsPerStep,
        allowWrite: launch.allowWrite,
        allowVerify: launch.allowVerify,
        allowExecute: launch.allowExecute,
        allowNetwork: launch.allowNetwork,
        allowBackground: launch.allowBackground,
        allowDelegate: launch.allowDelegate,
        allowPublish: launch.allowPublish,
        allowSpend: launch.allowSpend,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        mounts: launch.mounts,
        interactiveQuestions: false,
        onEvent: hooks.onEvent,
        onActivity: hooks.onActivity,
        skillCompatibilityRoots: [],
      });
      if (input.mode && runtime.mode() !== input.mode) {
        runtime.changeMode(input.mode, `ACP session mode ${input.mode}`);
      }
      return runtime;
    },
  };
}
