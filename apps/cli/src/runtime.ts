import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  InMemoryCapabilityBroker,
  redactSensitiveValue,
  type CapabilityLease,
} from "@civaapple/qi-agent/capability";
import type { IndexedMemoryClaim, MemoryListOptions } from "@civaapple/qi-agent/memory";
import {
  MemoryController,
  memoryRelevanceScore,
  memoryScopeKey,
} from "@civaapple/qi-agent/memory";
import { probeContainerRuntime } from "@civaapple/qi-node/codeact";
import { createQiIntrospectionTool, createQiSessionInspectionTool } from "@civaapple/qi-agent/extensions";
import {
  GoalEngine,
  HumanEvaluator,
  type ControlGrant,
  type EvalOutcome,
  type GoalContractInput,
  type HumanEvalInput,
} from "@civaapple/qi-agent/eval";
import {
  sessionArchiveBlockers,
  type EventStore,
  type GoalView,
  type SessionSummary,
  type SessionView,
} from "@civaapple/qi-agent/kernel";
import {
  getProviderProfile,
  providerModelOutputReserveTokens,
  type ModelCapabilities,
  type ModelPort,
  type ModelRef,
} from "@civaapple/qi-ai";
import {
  HumanControlService,
  EventWriter,
  SessionSupervisor,
  TurnLoop,
  demoteActiveGoalAfterResume,
  settleGoalBoundTurn,
  type GoalContinuationDecision,
  type RuntimeActivity,
  type RunQuestionAnswer,
  type SessionMode,
  type TurnRequest,
  type TurnResult,
} from "@civaapple/qi-agent/loop";
import {
  createId,
  type EvaluationId,
  type GoalId,
  type QuestionId,
  type RunId,
  type RunImagePart,
  type RunInputPart,
  type SessionEvent,
  type SessionId,
} from "@civaapple/qi-protocol";
import {
  ImageIngestService,
  createReadImageTool,
  detectImageInputCandidates,
} from "@civaapple/qi-node/media";
import {
  SessionRepository,
  SqliteEventStore,
  SqliteMemoryIndex,
  type SessionCatalogEntry,
} from "@civaapple/qi-node/storage";
import {
  ensureProjectSessionLayout,
  projectPaths,
  projectSessionPaths,
  qiStatePaths,
  workspaceProjectId,
} from "@civaapple/qi-node/paths";
import { SkillCatalog, type CatalogSkill, type SkillScope } from "@civaapple/qi-node/skills";
import {
  FileArtifactStore,
  ToolRegistry,
  builtinTools,
  createScriptTool,
  createVerifyTool,
  defaultVerificationManifestPath,
  fetchTool,
  loadVerificationProfiles,
  prepareVerificationProfiles,
  prewarmTrustedExecutables,
  probeShellProfiles,
  resolveShellConfig,
  scanVerificationCandidates,
  shellProfileResource,
  verificationResource,
  writeVerificationManifest,
  isRegularFile,
  normalizeWorkspaceRelativePath,
  resolveAccessiblePath,
  type PreparedVerificationProfiles,
  type RegistrationHandle,
  type SensitivePathPolicy,
  type ShellProfileSnapshot,
  type VerificationCandidate,
  type VerificationProfile,
  type WorkspaceMount,
} from "@civaapple/qi-node/tools";
import { SqliteEffectJournal } from "@civaapple/qi-node/workspace";
import { createCodeActTool } from "./codeact-tool.js";
import { createAskQuestionTool, RunQuestionCoordinator } from "./ask-question-tool.js";
import type { QiCapabilityConfig, QiImageConfig, QiShellConfig } from "./config.js";
import {
  defaultUserConfigPath,
  persistUserMaxActionsPerStep,
  persistUserMaxSteps,
  persistUserShell,
} from "./config.js";
import { createDelegateTool } from "./delegate-tool.js";
import { defaultProjectConfigPath } from "./paths.js";
import {
  assertMountPathAllowed,
  loadProjectConfig,
  saveProjectConfig,
  suggestMountId,
  type QiProjectConfig,
} from "./project-config.js";
import { createPlanDocumentTool } from "./plan-tool.js";
import { createUpdatePlanTool } from "./update-plan-tool.js";
import { createTuiSkillTool } from "./skill-tool.js";
import { createMemoryTool } from "./memory-tool.js";
import { ProcessTaskManager } from "./process-tasks.js";
import {
  buildMemoryContextBlock,
  buildTuiContextBlocks,
  loadRootWorkspaceInstructions,
} from "./model-context.js";

const EMPTY_SHELL_PROFILES: ShellProfileSnapshot = {
  default: "direct",
  allowed: [],
  directEnabled: false,
  available: [],
  unavailable: [],
};

const OPTIONAL_LEASE_IDS = [
  "lea_tui_write",
  "lea_tui_verify",
  "lea_tui_execute_direct",
  "lea_tui_execute_script",
  "lea_tui_execute_codeact",
  "lea_tui_network",
  "lea_tui_background",
  "lea_tui_delegate",
] as const;

export interface RuntimeMount {
  readonly id: string;
  readonly path: string;
  readonly mode: "read";
  readonly source: "project_config" | "cli" | "grant" | "command";
}

export interface TuiRuntimeOptions {
  workspaceRoot: string;
  dataRoot: string;
  qiHome?: string;
  projectId?: string;
  memoryEnabled?: boolean;
  memoryAutoAcceptProject?: boolean;
  image?: QiImageConfig;
  modelPort: ModelPort;
  model: ModelRef;
  /**
   * Resolve the ModelRef at Turn start. Required after `/login` switches provider/model;
   * when omitted, `model` is used for every Run (tests and static compositions).
   */
  resolveModel?: () => ModelRef;
  contextWindowTokens?: number;
  contextWindowTokensOverride?: boolean;
  outputReserveTokens?: number;
  /**
   * User-preferred output reserve from config / `/model`. When set, model switches keep this
   * preference (still hard-capped at 1/8 of the window).
   */
  outputReserveTokensPreferred?: number;
  maxSteps?: number;
  maxActionsPerStep?: number;
  allowWrite?: boolean;
  allowVerify?: boolean;
  allowExecute?: boolean;
  allowNetwork?: boolean;
  allowBackground?: boolean;
  allowDelegate?: boolean;
  shell?: QiShellConfig;
  subject?: string;
  sessionId?: SessionId;
  eventStore?: EventStore;
  userHome?: string;
  userSkillsRoot?: string;
  skillCompatibilityRoots?: readonly string[];
  projectConfigPath?: string;
  mounts?: readonly RuntimeMount[];
  sensitivePathGrants?: readonly string[];
  sensitivePathPolicy?: SensitivePathPolicy;
  onEvent?: (event: SessionEvent) => void;
  onActivity?: (activity: RuntimeActivity) => void;
  interactiveQuestions?: boolean;
}

export interface TuiVerificationManifest {
  readonly path: string;
  readonly origin: PreparedVerificationProfiles["origin"];
  readonly profiles: readonly string[];
}

export interface AppliedCapabilities {
  readonly labels: readonly string[];
  readonly capabilities: Required<QiCapabilityConfig>;
}

export const TUI_DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const TUI_DEFAULT_OUTPUT_RESERVE_TOKENS = 16_000;
export const TUI_HISTORY_BUDGET_TOKENS = 16_000;

/** Cap output reserve at 1/8 of the window; prefer a model catalog value when present. */
export function resolveOutputReserveTokens(
  contextWindowTokens: number,
  preferredReserveTokens?: number,
): number {
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 8_192) {
    throw new RangeError("contextWindowTokens must be an integer >= 8192");
  }
  const hardCap = Math.floor(contextWindowTokens / 8);
  const preferred = preferredReserveTokens ?? TUI_DEFAULT_OUTPUT_RESERVE_TOKENS;
  if (!Number.isInteger(preferred) || preferred < 1) {
    throw new RangeError("preferredReserveTokens must be a positive integer");
  }
  return Math.min(preferred, hardCap);
}
export const TUI_DEFAULT_MAX_STEPS = 32;
export const TUI_MIN_MAX_STEPS = 8;
export const TUI_MAX_MAX_STEPS = 1_000;
/** Panel /settings and `/max-steps` choices (still accepts any integer in the validated range via TOML/flag). */
export const TUI_MAX_STEPS_PRESETS = [16, 32, 64, 100, 200, 500, 1_000] as const;
/** @deprecated Prefer {@link TUI_DEFAULT_MAX_ACTIONS_PER_STEP}. */
export const TUI_MAX_ACTIONS_PER_STEP = 6;
export const TUI_DEFAULT_MAX_ACTIONS_PER_STEP = 6;
export const TUI_MIN_MAX_ACTIONS_PER_STEP = 1;
export const TUI_MAX_MAX_ACTIONS_PER_STEP = 32;
/** Panel /settings and `/max-actions-per-step` choices. */
export const TUI_MAX_ACTIONS_PER_STEP_PRESETS = [2, 4, 6, 8, 12, 16] as const;

export function assertMaxSteps(maxSteps: number, label = "maxSteps"): number {
  if (!Number.isInteger(maxSteps) || maxSteps < TUI_MIN_MAX_STEPS || maxSteps > TUI_MAX_MAX_STEPS) {
    throw new RangeError(`${label} must be an integer from ${TUI_MIN_MAX_STEPS} to ${TUI_MAX_MAX_STEPS}`);
  }
  return maxSteps;
}

export function assertMaxActionsPerStep(value: number, label = "maxActionsPerStep"): number {
  if (
    !Number.isInteger(value)
    || value < TUI_MIN_MAX_ACTIONS_PER_STEP
    || value > TUI_MAX_MAX_ACTIONS_PER_STEP
  ) {
    throw new RangeError(
      `${label} must be an integer from ${TUI_MIN_MAX_ACTIONS_PER_STEP} to ${TUI_MAX_MAX_ACTIONS_PER_STEP}`,
    );
  }
  return value;
}

export class TuiRuntime {
  readonly sessionId: SessionId;
  readonly skillRoots: { workspace: string; user: string };
  readonly #workspaceRoot: string;
  readonly #model: ModelRef;
  readonly #modelPort: ModelPort;
  readonly #resolveModel: () => ModelRef;
  #contextWindowTokensOverride: boolean;
  #contextWindowTokens: number;
  #contextBudgetTokens: number;
  #outputReserveTokens: number;
  #outputReserveTokensPreferred: number | undefined;
  #maxSteps: number;
  #maxActionsPerStep: number;
  readonly #subject: string;
  readonly #eventStore: EventStore;
  readonly #ownedStore: SessionRepository | undefined;
  readonly #artifactStore: FileArtifactStore;
  readonly #imageIngest: ImageIngestService;
  readonly #readImageByteBudget: number | undefined;
  readonly #effectJournal: SqliteEffectJournal;
  readonly #broker: InMemoryCapabilityBroker;
  readonly #registry: ToolRegistry;
  readonly #loop: TurnLoop;
  readonly #supervisor: SessionSupervisor;
  readonly #humanControl: HumanControlService;
  readonly #runQuestions: RunQuestionCoordinator;
  readonly #skills: SkillCatalog;
  readonly #processTasks: ProcessTaskManager;
  readonly #dataRoot: string;
  readonly #projectId: string;
  readonly #memoryEnabled: boolean;
  readonly #projectMemoryIndex: SqliteMemoryIndex;
  readonly #userMemoryIndex: SqliteMemoryIndex;
  readonly #projectMemory: MemoryController;
  readonly #userMemory: MemoryController;
  readonly #userMemoryStore: SqliteEventStore;
  readonly #projectConfigPath: string;
  #projectMemoryWarm: Promise<void> = Promise.resolve();
  #shellConfig: QiShellConfig | undefined;
  #verificationManifest: TuiVerificationManifest | undefined;
  #shellProfiles: ShellProfileSnapshot;
  #codeactRuntime: "docker" | "podman" | undefined;
  #codeactProbe: Promise<void> | undefined;
  #verificationProfiles: readonly VerificationProfile[];
  #mounts: RuntimeMount[];
  #sensitivePathGrants: string[];
  #sensitivePathPolicy: SensitivePathPolicy;
  #skillSnapshot: readonly CatalogSkill[];
  #activeController: AbortController | undefined;
  #allowWrite = false;
  #allowVerify = false;
  #allowExecute = false;
  #allowNetwork = false;
  #allowBackground = false;
  #allowDelegate = false;
  readonly   #optionalTools = new Map<string, RegistrationHandle>();
  #lastGoalContinuation: GoalContinuationDecision | undefined;

  private constructor(
    options: TuiRuntimeOptions,
    eventStore: EventStore,
    ownedStore: SessionRepository | undefined,
    artifactStore: FileArtifactStore,
    effectJournal: SqliteEffectJournal,
    shellProfiles: ShellProfileSnapshot,
    broker: InMemoryCapabilityBroker,
    registry: ToolRegistry,
    loop: TurnLoop,
    supervisor: SessionSupervisor,
    humanControl: HumanControlService,
    runQuestions: RunQuestionCoordinator,
    skills: SkillCatalog,
    skillSnapshot: readonly CatalogSkill[],
    processTasks: ProcessTaskManager,
    projectMemoryIndex: SqliteMemoryIndex,
    userMemoryIndex: SqliteMemoryIndex,
    projectMemory: MemoryController,
    userMemory: MemoryController,
    userMemoryStore: SqliteEventStore,
  ) {
    this.sessionId = options.sessionId ?? (createId("ses") as SessionId);
    this.#verificationManifest = undefined;
    this.#shellProfiles = shellProfiles;
    this.#codeactRuntime = undefined;
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#dataRoot = resolve(options.dataRoot);
    this.#projectId = options.projectId ?? workspaceProjectId(options.workspaceRoot);
    this.#memoryEnabled = options.memoryEnabled ?? true;
    this.#projectMemoryIndex = projectMemoryIndex;
    this.#userMemoryIndex = userMemoryIndex;
    this.#projectMemory = projectMemory;
    this.#userMemory = userMemory;
    this.#userMemoryStore = userMemoryStore;
    this.#model = options.model;
    this.#modelPort = options.modelPort;
    this.#resolveModel = options.resolveModel ?? (() => this.#model);
    const contextWindowTokens = options.contextWindowTokens ?? TUI_DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.#contextWindowTokensOverride = options.contextWindowTokensOverride
      ?? options.contextWindowTokens !== undefined;
    this.#contextWindowTokens = contextWindowTokens;
    this.#outputReserveTokensPreferred = options.outputReserveTokensPreferred;
    this.#outputReserveTokens = options.outputReserveTokens
      ?? resolveOutputReserveTokens(
        contextWindowTokens,
        this.#outputReserveTokensPreferred ?? this.#preferredOutputReserve(),
      );
    this.#contextBudgetTokens = contextBudgetFromWindow(contextWindowTokens, this.#outputReserveTokens);
    this.#maxSteps = assertMaxSteps(options.maxSteps ?? TUI_DEFAULT_MAX_STEPS);
    this.#maxActionsPerStep = assertMaxActionsPerStep(
      options.maxActionsPerStep ?? TUI_DEFAULT_MAX_ACTIONS_PER_STEP,
    );
    this.#subject = options.subject ?? "main-agent";
    this.#eventStore = eventStore;
    this.#ownedStore = ownedStore;
    this.#artifactStore = artifactStore;
    this.#imageIngest = new ImageIngestService({
      artifactStore,
      ...(options.image?.maxEdgePx === undefined ? {} : { maxEdgePx: options.image.maxEdgePx }),
    });
    this.#readImageByteBudget = options.image?.readByteBudget;
    this.#effectJournal = effectJournal;
    this.#verificationProfiles = [];
    this.#broker = broker;
    this.#registry = registry;
    this.#loop = loop;
    this.#supervisor = supervisor;
    this.#humanControl = humanControl;
    this.#runQuestions = runQuestions;
    this.#skills = skills;
    this.#skillSnapshot = Object.freeze([...skillSnapshot]);
    this.#processTasks = processTasks;
    this.#shellConfig = options.shell;
    this.#projectConfigPath = options.projectConfigPath ?? defaultProjectConfigPath(options.workspaceRoot);
    this.#mounts = [...(options.mounts ?? [])].map((mount) => ({
      id: mount.id,
      path: resolve(mount.path),
      mode: "read" as const,
      source: mount.source,
    }));
    this.#sensitivePathGrants = [...(options.sensitivePathGrants ?? [])].map((path) =>
      normalizeWorkspaceRelativePath(path),
    );
    this.#sensitivePathPolicy = freezeSensitivePathPolicy(options.sensitivePathPolicy);
    this.skillRoots = Object.freeze({ workspace: skills.workspaceSkillsRoot, user: skills.userSkillsRoot });
  }

  get verificationManifest(): TuiVerificationManifest | undefined {
    return this.#verificationManifest;
  }

  get shellProfiles(): ShellProfileSnapshot {
    return this.#shellProfiles;
  }

  syncModelContextWindow(contextWindowTokens: number): {
    contextWindowTokens: number;
    contextBudgetTokens: number;
    outputReserveTokens: number;
  } {
    if (!this.#contextWindowTokensOverride) {
      this.#contextWindowTokens = contextWindowTokens;
    }
    this.#recomputeOutputReserve();
    return {
      contextWindowTokens: this.#contextWindowTokens,
      contextBudgetTokens: this.#contextBudgetTokens,
      outputReserveTokens: this.#outputReserveTokens,
    };
  }

  configureContextWindow(contextWindowTokens: number): {
    contextWindowTokens: number;
    contextBudgetTokens: number;
    outputReserveTokens: number;
  } {
    if (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 8_192 || contextWindowTokens > 2_000_000) {
      throw new RangeError("context window must be an integer from 8192 to 2000000 tokens");
    }
    this.#contextWindowTokensOverride = true;
    this.#contextWindowTokens = contextWindowTokens;
    this.#recomputeOutputReserve();
    return {
      contextWindowTokens: this.#contextWindowTokens,
      contextBudgetTokens: this.#contextBudgetTokens,
      outputReserveTokens: this.#outputReserveTokens,
    };
  }

  configureOutputReserve(outputReserveTokens: number): {
    contextWindowTokens: number;
    contextBudgetTokens: number;
    outputReserveTokens: number;
  } {
    if (!Number.isInteger(outputReserveTokens) || outputReserveTokens < 1) {
      throw new RangeError("max output tokens must be a positive integer");
    }
    const hardCap = Math.floor(this.#contextWindowTokens / 8);
    if (outputReserveTokens > hardCap) {
      throw new RangeError(
        `max output tokens must be <= ${hardCap} (1/8 of the ${this.#contextWindowTokens}-token context window)`,
      );
    }
    this.#outputReserveTokensPreferred = outputReserveTokens;
    this.#recomputeOutputReserve();
    return {
      contextWindowTokens: this.#contextWindowTokens,
      contextBudgetTokens: this.#contextBudgetTokens,
      outputReserveTokens: this.#outputReserveTokens,
    };
  }

  outputReserveTokens(): number {
    return this.#outputReserveTokens;
  }

  outputReserveTokensPreferred(): number | undefined {
    return this.#outputReserveTokensPreferred;
  }

  #recomputeOutputReserve(): void {
    this.#outputReserveTokens = resolveOutputReserveTokens(
      this.#contextWindowTokens,
      this.#outputReserveTokensPreferred ?? this.#preferredOutputReserve(),
    );
    this.#contextBudgetTokens = contextBudgetFromWindow(
      this.#contextWindowTokens,
      this.#outputReserveTokens,
    );
  }

  #preferredOutputReserve(): number | undefined {
    const model = this.#resolveModel();
    const profile = getProviderProfile(model.provider);
    return profile === undefined
      ? undefined
      : providerModelOutputReserveTokens(profile, model.model);
  }

  static async create(options: TuiRuntimeOptions): Promise<TuiRuntime> {
    const dataRoot = resolve(options.dataRoot);
    const stateRoot = resolve(dataRoot, "state");
    const runtimeSessionId = options.sessionId ?? (createId("ses") as SessionId);
    await mkdir(stateRoot, { recursive: true });
    const project = projectPaths({
      workspaceRoot: options.workspaceRoot,
      dataRoot,
      ...(options.qiHome === undefined ? {} : { environment: { QI_HOME: options.qiHome } }),
    });
    const session = projectSessionPaths(project, runtimeSessionId);
    await ensureProjectSessionLayout(session);
    const ownedStore = options.eventStore ? undefined : new SessionRepository(project);
    await ownedStore?.recover();
    const eventStore = options.eventStore ?? ownedStore;
    if (!eventStore) throw new Error("EventStore construction failed");
    const artifactStore = new FileArtifactStore(session.artifactsRoot);
    const effectJournal = new SqliteEffectJournal(session.effectsFile);
    const broker = new InMemoryCapabilityBroker();
    const subject = options.subject ?? "main-agent";
    // Fire-and-forget: warms the trusted-executable cache for this Workspace's language stack so the
    // first real search/find/shell/script/verify call does not pay PATH-walk latency. Never awaited and
    // never throws (each candidate probe swallows its own failure).
    void prewarmTrustedExecutables(options.workspaceRoot);
    grantBaseRuntimeLeases(broker, subject);
    const registry = new ToolRegistry(broker);
    const projectId = options.projectId ?? workspaceProjectId(options.workspaceRoot);
    const projectMemoryIndex = new SqliteMemoryIndex(resolve(stateRoot, "memory.sqlite"));
    const qiHome = resolve(options.qiHome ?? resolve(dataRoot, ".user"));
    const userState = qiStatePaths(qiHome);
    await mkdir(userState.stateRoot, { recursive: true });
    const userMemoryStore = new SqliteEventStore(userState.continuityDatabaseFile);
    const userMemoryIndex = new SqliteMemoryIndex(userState.memoryFile);
    const continuitySessionId = "ses_continuity_local" as SessionId;
    if (!userMemoryStore.load(continuitySessionId)) {
      new EventWriter(userMemoryStore, continuitySessionId).append(
        "session.created",
        { title: "Qi user continuity" },
        { kind: "runtime", id: "qi" },
      );
    }
    userMemoryIndex.applyBatch(userMemoryStore.read(continuitySessionId).events);
    const projectMemory = new MemoryController(eventStore, projectMemoryIndex, runtimeSessionId, {
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    const userMemory = new MemoryController(userMemoryStore, userMemoryIndex, continuitySessionId, {
      provenanceResolver: {
        resolve: (reference) => {
          if (reference.projectId !== undefined && reference.projectId !== projectId) return undefined;
          return eventStore.read(reference.sessionId).events.find(
            (candidate) => candidate.eventId === reference.eventId && candidate.sequence === reference.sequence,
          );
        },
      },
    });
    const skills = new SkillCatalog({
      workspaceRoot: options.workspaceRoot,
      ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
      ...(options.userSkillsRoot === undefined ? {} : { userSkillsRoot: options.userSkillsRoot }),
      ...(options.skillCompatibilityRoots === undefined ? {} : { compatibilityRoots: options.skillCompatibilityRoots }),
    });
    const skillSnapshot = await skills.discover();
    const processTasks = new ProcessTaskManager({
      workspaceRoot: options.workspaceRoot,
      dataRoot: session.root,
      eventStore,
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.onActivity === undefined ? {} : { onActivity: options.onActivity }),
    });
    registry.register("read", builtinTools.read);
    registry.register("list", builtinTools.list);
    registry.register("search", builtinTools.search);
    registry.register("find", builtinTools.find);
    registry.register("tree", builtinTools.tree);
    registry.register("git", builtinTools.git);
    registry.register("artifact", builtinTools.artifact);
    registry.register("skill", createTuiSkillTool(skills, options.workspaceRoot));
    registry.register("qi_introspect", createQiIntrospectionTool());
    registry.register("qi_session_inspect", createQiSessionInspectionTool(eventStore, runtimeSessionId));
    if (options.memoryEnabled ?? true) {
      registry.register("memory", createMemoryTool({
        eventStore,
        projectId,
        projectMemory,
        userMemory,
        autoAcceptProject: options.memoryAutoAcceptProject ?? true,
      }));
    }
    const humanControl = new HumanControlService({
      eventStore,
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    const runQuestions = new RunQuestionCoordinator(humanControl);
    registry.register("plan_document", createPlanDocumentTool({
      dataRoot: session.root,
      artifactStore,
      humanControl,
    }));
    registry.register("update_plan", createUpdatePlanTool(humanControl));
    if (options.interactiveQuestions === true) {
      registry.register("ask_question", createAskQuestionTool(runQuestions));
    }
    const loop = new TurnLoop({
      eventStore,
      modelPort: options.modelPort,
      toolRegistry: registry,
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.onActivity === undefined ? {} : { onActivity: options.onActivity }),
    });
    const supervisor = new SessionSupervisor(eventStore, {
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    if (options.sessionId) supervisor.recover(options.sessionId);
    if (options.sessionId) await processTasks.recover(options.sessionId);
    const projectConfigPath = options.projectConfigPath ?? defaultProjectConfigPath(options.workspaceRoot);
    const projectConfig = await loadProjectConfig(projectConfigPath);
    const runtime = new TuiRuntime(
      {
        ...options,
        sessionId: runtimeSessionId,
        projectConfigPath,
        sensitivePathGrants: options.sensitivePathGrants
          ?? projectConfig.config.sensitivePathGrants
          ?? [],
        sensitivePathPolicy: options.sensitivePathPolicy
          ?? projectConfig.config.sensitivePaths
          ?? {},
      },
      eventStore,
      ownedStore,
      artifactStore,
      effectJournal,
      EMPTY_SHELL_PROFILES,
      broker,
      registry,
      loop,
      supervisor,
      humanControl,
      runQuestions,
      skills,
      skillSnapshot,
      processTasks,
      projectMemoryIndex,
      userMemoryIndex,
      projectMemory,
      userMemory,
      userMemoryStore,
    );
    // Incremental catch-up runs after create returns so first TUI paint is not blocked.
    runtime.#projectMemoryWarm = runtime.#catchUpProjectMemory();
    await runtime.applyCapabilities({
      write: options.allowWrite ?? false,
      verify: options.allowVerify ?? false,
      network: options.allowNetwork ?? false,
      execute: options.allowExecute ?? false,
      background: options.allowBackground ?? false,
      delegate: options.allowDelegate ?? false,
    }, { persist: false });
    if ((options.mounts ?? []).some((mount) => mount.source === "cli")) {
      await runtime.flushMountsToProjectConfig();
    }
    // Existing Session load: demote active Goals so resume never silently continues 追寻.
    if (options.sessionId) {
      runtime.demoteActiveGoalAfterResume();
    }
    return runtime;
  }

  /** Wait until project Memory index has caught up with active Session streams. */
  async ensureProjectMemoryReady(): Promise<void> {
    await this.#projectMemoryWarm;
  }

  async #catchUpProjectMemory(): Promise<void> {
    if (!this.#memoryEnabled) return;
    const sessionIds = this.#ownedStore
      ? this.#ownedStore.listActiveSessionIds()
      : this.#eventStore.listSessions().map((summary) => summary.sessionId);
    const active = new Set(sessionIds);
    this.#projectMemoryIndex.retainOriginSessions(active);
    for (const sessionId of sessionIds) {
      const after = this.#projectMemoryIndex.lastAppliedSequence(sessionId);
      this.#projectMemoryIndex.applyBatch(this.#eventStore.read(sessionId, after).events);
    }
  }

  lastGoalContinuation(): GoalContinuationDecision | undefined {
    return this.#lastGoalContinuation;
  }

  capabilityLabels(): string[] {
    return [
      ...(this.#allowWrite ? ["write"] : []),
      ...(this.#allowVerify ? ["verify"] : []),
      ...(this.#allowNetwork ? ["network"] : []),
      ...(this.#allowExecute ? ["execute"] : []),
      ...(this.#allowBackground ? ["background"] : []),
      ...(this.#allowDelegate ? ["delegate"] : []),
    ];
  }

  async applyCapabilities(
    capabilities: QiCapabilityConfig,
    options?: { persist?: boolean },
  ): Promise<AppliedCapabilities> {
    if (this.active) throw new Error("Cannot change capabilities while a Run is active");
    const normalized: Required<QiCapabilityConfig> = {
      write: capabilities.write ?? false,
      verify: capabilities.verify ?? false,
      network: capabilities.network ?? false,
      execute: capabilities.execute ?? false,
      background: capabilities.background ?? false,
      delegate: capabilities.delegate ?? false,
    };
    if (options?.persist !== false) {
      await this.saveProjectCapabilities(normalized);
    }
    await this.#syncOptionalTools(normalized);
    for (const leaseId of OPTIONAL_LEASE_IDS) this.#broker.revoke(leaseId);
    grantOptionalRuntimeLeases(
      this.#broker,
      this.#subject,
      normalized.write,
      this.#verificationProfiles,
      this.#shellProfiles,
      this.#codeactRuntime,
      normalized.network,
      normalized.background,
      normalized.delegate,
    );
    this.#allowWrite = normalized.write;
    this.#allowVerify = normalized.verify;
    this.#allowExecute = normalized.execute;
    this.#allowNetwork = normalized.network;
    this.#allowBackground = normalized.background;
    this.#allowDelegate = normalized.delegate;
    // After leases settle: container probe is slow/hang-prone and must not block first paint.
    if (normalized.execute) this.#codeactProbe = this.#refreshCodeactTool();
    else this.#codeactProbe = undefined;
    return { labels: this.capabilityLabels(), capabilities: normalized };
  }

  maxSteps(): number {
    return this.#maxSteps;
  }

  maxActionsPerStep(): number {
    return this.#maxActionsPerStep;
  }

  /**
   * Hot-apply main-Run Step budget: persist to `$QI_HOME/config.toml` and use on the next Run.
   */
  async applyMaxSteps(
    maxSteps: number,
    options?: { persist?: boolean; configPath?: string },
  ): Promise<{ maxSteps: number; configPath: string; projectOverride?: number }> {
    if (this.active) throw new Error("Cannot change max steps while a Run is active");
    assertMaxSteps(maxSteps);
    const configPath = options?.configPath ?? defaultUserConfigPath();
    if (options?.persist !== false) {
      await persistUserMaxSteps(maxSteps, configPath);
    }
    this.#maxSteps = maxSteps;
    const project = await loadProjectConfig(this.#projectConfigPath);
    return {
      maxSteps,
      configPath,
      ...(project.config.maxSteps === undefined ? {} : { projectOverride: project.config.maxSteps }),
    };
  }

  /**
   * Hot-apply per-Step Action batch limit: persist to `$QI_HOME/config.toml` and use on the next Run.
   */
  async applyMaxActionsPerStep(
    maxActionsPerStep: number,
    options?: { persist?: boolean; configPath?: string },
  ): Promise<{ maxActionsPerStep: number; configPath: string }> {
    if (this.active) throw new Error("Cannot change max actions per step while a Run is active");
    assertMaxActionsPerStep(maxActionsPerStep);
    const configPath = options?.configPath ?? defaultUserConfigPath();
    if (options?.persist !== false) {
      await persistUserMaxActionsPerStep(maxActionsPerStep, configPath);
    }
    this.#maxActionsPerStep = maxActionsPerStep;
    return { maxActionsPerStep, configPath };
  }

  /**
   * Hot-apply user-global shell profiles: persist to `$QI_HOME/config.toml`, re-probe, and refresh
   * shell/script tools + execute leases without restarting the CLI.
   */
  async applyShellConfig(
    shell: QiShellConfig,
    options?: { persist?: boolean; configPath?: string },
  ): Promise<ShellProfileSnapshot> {
    if (this.active) throw new Error("Cannot change shell profiles while a Run is active");
    if (!shell.allowed || shell.allowed.length === 0) {
      throw new TypeError("shell.allowed must contain at least one profile");
    }
    const defaultProfile = shell.default
      ?? (shell.allowed.includes("direct") ? "direct" : shell.allowed[0]!);
    if (!shell.allowed.includes(defaultProfile)) {
      throw new TypeError(`shell.default ${defaultProfile} must be listed in shell.allowed`);
    }
    const normalized: QiShellConfig = {
      default: defaultProfile,
      allowed: [...shell.allowed],
    };
    if (options?.persist !== false) {
      await persistUserShell(normalized, options?.configPath ?? defaultUserConfigPath());
    }
    this.#shellConfig = normalized;
    const capabilities: Required<QiCapabilityConfig> = {
      write: this.#allowWrite,
      verify: this.#allowVerify,
      network: this.#allowNetwork,
      execute: this.#allowExecute,
      background: this.#allowBackground,
      delegate: this.#allowDelegate,
    };
    await this.#syncOptionalTools(capabilities);
    for (const leaseId of OPTIONAL_LEASE_IDS) this.#broker.revoke(leaseId);
    grantOptionalRuntimeLeases(
      this.#broker,
      this.#subject,
      capabilities.write,
      this.#verificationProfiles,
      this.#shellProfiles,
      this.#codeactRuntime,
      capabilities.network,
      capabilities.background,
      capabilities.delegate,
    );
    return this.#shellProfiles;
  }

  /** Scan package manifests plus AGENTS.md/README.md for candidate verification commands; writes nothing. */
  async scanVerificationSetup(): Promise<{
    candidates: readonly VerificationCandidate[];
    currentNames: readonly string[];
  }> {
    const candidates = await scanVerificationCandidates(this.#workspaceRoot);
    let currentNames: readonly string[] = [];
    try {
      currentNames = (await loadVerificationProfiles(this.#workspaceRoot)).map((profile) => profile.name);
    } catch {
      currentNames = [];
    }
    return { candidates, currentNames };
  }

  /** Human-confirmed write of `.qi/qi.verify.json`; refreshes the live `verify` tool when already authorized. */
  async applyVerificationSetup(selected: readonly VerificationCandidate[]): Promise<TuiVerificationManifest> {
    if (this.active) throw new Error("Cannot change verification profiles while a Run is active");
    const profiles = await writeVerificationManifest(this.#workspaceRoot, selected);
    const manifest: TuiVerificationManifest = Object.freeze({
      path: defaultVerificationManifestPath,
      origin: "existing" as const,
      profiles: Object.freeze(profiles.map((profile) => profile.name)),
    });
    // Only seed the live-effective state when verify is currently authorized; otherwise applyCapabilities'
    // verify-off branch would legitimately clear it right back out, matching the toggle-off invariant elsewhere.
    if (this.#allowVerify) {
      this.#verificationProfiles = profiles;
      this.#verificationManifest = manifest;
      await this.applyCapabilities({
        write: this.#allowWrite,
        verify: this.#allowVerify,
        network: this.#allowNetwork,
        execute: this.#allowExecute,
        background: this.#allowBackground,
        delegate: this.#allowDelegate,
      }, { persist: false });
    }
    return manifest;
  }

  async #syncOptionalTools(capabilities: Required<QiCapabilityConfig>): Promise<void> {
    if (capabilities.write) {
      this.#setOptionalTool("write", builtinTools.write);
      this.#setOptionalTool("edit", builtinTools.edit);
      this.#setOptionalTool("move", builtinTools.move);
      this.#setOptionalTool("remove", builtinTools.remove);
    } else {
      this.#closeOptionalTool("write");
      this.#closeOptionalTool("edit");
      this.#closeOptionalTool("move");
      this.#closeOptionalTool("remove");
    }

    if (capabilities.verify) {
      if (this.#verificationProfiles.length === 0) {
        const prepared = await prepareVerificationProfiles(this.#workspaceRoot);
        this.#verificationProfiles = prepared?.profiles ?? [];
        this.#verificationManifest = prepared === undefined
          ? undefined
          : Object.freeze({
              path: prepared.manifestPath,
              origin: prepared.origin,
              profiles: Object.freeze(prepared.profiles.map((profile) => profile.name)),
            });
      }
      this.#setOptionalTool("verify", createVerifyTool(this.#verificationProfiles));
    } else {
      this.#closeOptionalTool("verify");
      this.#verificationProfiles = [];
      this.#verificationManifest = undefined;
    }

    if (capabilities.execute) {
      this.#shellProfiles = await probeShellProfiles(
        this.#workspaceRoot,
        resolveShellConfig(this.#shellConfig, true),
      );
      if (this.#shellProfiles.directEnabled) this.#setOptionalTool("shell", builtinTools.shell);
      else this.#closeOptionalTool("shell");
      if (this.#shellProfiles.available.length > 0) {
        this.#setOptionalTool("script", createScriptTool(this.#shellProfiles.available));
      } else {
        this.#closeOptionalTool("script");
      }
    } else {
      this.#closeOptionalTool("shell");
      this.#closeOptionalTool("script");
      this.#closeOptionalTool("codeact");
      this.#codeactRuntime = undefined;
      this.#shellProfiles = await probeShellProfiles(
        this.#workspaceRoot,
        resolveShellConfig(this.#shellConfig, false),
      );
    }

    if (capabilities.network) this.#setOptionalTool("fetch", fetchTool);
    else this.#closeOptionalTool("fetch");

    if (capabilities.background) this.#setOptionalTool("task", this.#processTasks.tool());
    else this.#closeOptionalTool("task");

    if (capabilities.delegate) {
      this.#setOptionalTool("delegate", createDelegateTool({
        eventStore: this.#eventStore,
        broker: this.#broker,
        artifactStore: this.#artifactStore,
        turnLoop: this.#loop,
        toolRegistry: this.#registry,
        model: this.#resolveModel,
        workspaceRoot: this.#workspaceRoot,
        parentSubject: this.#subject,
        parentLeaseId: "lea_tui_read",
        childTools: ["read", "list", "search", "find", "tree", "git"],
      }));
    } else {
      this.#closeOptionalTool("delegate");
    }
  }

  async #refreshCodeactTool(): Promise<void> {
    const runtime = await probeContainerRuntime();
    if (!this.#allowExecute) {
      this.#codeactRuntime = undefined;
      this.#broker.revoke("lea_tui_execute_codeact");
      this.#closeOptionalTool("codeact");
      return;
    }
    this.#codeactRuntime = runtime;
    this.#broker.revoke("lea_tui_execute_codeact");
    if (runtime) {
      this.#setOptionalTool("codeact", createCodeActTool({
        eventStore: this.#eventStore,
        toolRegistry: this.#registry,
        artifactStore: this.#artifactStore,
        workspaceRoot: this.#workspaceRoot,
        runtime,
      }));
      this.#broker.grant({
        leaseId: "lea_tui_execute_codeact",
        subject: this.#subject,
        tools: ["codeact"],
        effects: ["execute"],
        resources: [`container-runtime:${runtime}`],
        expiresAt: leaseExpiry(),
      });
    } else {
      this.#closeOptionalTool("codeact");
    }
  }

  #setOptionalTool(name: string, definition: Parameters<ToolRegistry["register"]>[1]): void {
    this.#closeOptionalTool(name);
    this.#optionalTools.set(name, this.#registry.register(name, definition));
  }

  #closeOptionalTool(name: string): void {
    const handle = this.#optionalTools.get(name);
    if (!handle) return;
    handle.close();
    this.#optionalTools.delete(name);
  }

  get active(): boolean {
    return this.#activeController !== undefined;
  }

  view(): SessionView | undefined {
    return this.#eventStore.load(this.sessionId);
  }

  /** Read-only projection of a depth-1 child Session; never merges child transcript into the parent. */
  childView(childSessionId: SessionId): SessionView | undefined {
    return this.#eventStore.load(childSessionId);
  }

  childEvents(childSessionId: SessionId): readonly SessionEvent[] {
    return this.#eventStore.read(childSessionId).events;
  }

  events(): readonly SessionEvent[] {
    return this.#eventStore.read(this.sessionId).events;
  }

  /** All Sessions in the workspace event store (newest first). */
  listSessions(): SessionSummary[] {
    return this.#eventStore.listSessions();
  }

  listSessionCatalog(): SessionCatalogEntry[] {
    return this.#ownedStore?.listCatalog() ?? this.listSessions().map((entry) => ({
      ...entry,
      location: "active" as const,
      lifecycle: this.#eventStore.load(entry.sessionId)?.lifecycle ?? "active",
    }));
  }

  sessionArchiveBlockers(sessionId: SessionId): string[] {
    if (this.#ownedStore) return this.#ownedStore.archiveBlockers(sessionId);
    const view = this.#eventStore.load(sessionId);
    return view ? sessionArchiveBlockers(view) : [`Session ${sessionId} does not exist`];
  }

  workspaceResetBlockers(): string[] {
    return this.listSessions().flatMap((session) =>
      this.sessionArchiveBlockers(session.sessionId).map((reason) => `${session.sessionId}: ${reason}`));
  }

  /** Read events for an active or archived Session (used for list previews). */
  readSessionEvents(sessionId: SessionId): readonly SessionEvent[] {
    const catalog = this.#ownedStore?.listCatalog().find((entry) => entry.sessionId === sessionId);
    return catalog?.location === "archived"
      ? this.#ownedStore!.readArchived(sessionId).events
      : this.#eventStore.read(sessionId).events;
  }

  get workspaceRoot(): string {
    return this.#workspaceRoot;
  }

  skillCatalog(): readonly CatalogSkill[] {
    return this.#skillSnapshot;
  }

  async refreshSkills(): Promise<readonly CatalogSkill[]> {
    this.#skillSnapshot = Object.freeze(await this.#skills.discover());
    return this.#skillSnapshot;
  }

  async installSkill(source: string, scope: SkillScope = "user"): Promise<CatalogSkill> {
    if (this.active) throw new Error("Cannot install a Skill while a Run is active");
    const installed = await this.#skills.install({ source, scope });
    await this.refreshSkills();
    return installed;
  }

  tasks() {
    return this.#processTasks.list(this.sessionId);
  }

  async stopTask(taskId: string): Promise<void> {
    await this.#processTasks.stop(this.sessionId, taskId);
  }

  mode(): SessionMode {
    return this.view()?.mode ?? "agent";
  }

  changeMode(to: SessionMode, reason = "User switched mode"): SessionView {
    if (this.active) throw new Error("Cannot change mode while a Run is active");
    this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
    return this.#humanControl.changeMode(this.sessionId, to, reason);
  }

  acceptPlan(): { runId: RunId; input: string; formal: boolean } {
    if (this.active) throw new Error("Cannot accept a Plan while a Run is active");
    const accepted = this.#humanControl.acceptPlanAndStartFirstRun(this.sessionId);
    return { runId: accepted.runId, input: accepted.input, formal: accepted.formal };
  }

  revisePlan(feedback?: string): SessionView {
    if (this.active) throw new Error("Cannot revise a Plan while a Run is active");
    return this.#humanControl.settlePlanReview(this.sessionId, "revise", feedback);
  }

  rejectPlan(feedback?: string): SessionView {
    if (this.active) throw new Error("Cannot reject a Plan while a Run is active");
    return this.#humanControl.settlePlanReview(this.sessionId, "rejected", feedback);
  }

  answerNextRun(choiceId: "continue" | "stop" | "return_to_plan"): { runId?: RunId; input?: string } {
    if (this.active) throw new Error("Cannot answer while a Run is active");
    const answered = this.#humanControl.answerNextRunQuestion(this.sessionId, choiceId);
    return { ...(answered.runId === undefined ? {} : { runId: answered.runId }), ...(answered.input === undefined ? {} : { input: answered.input }) };
  }

  answerRunQuestion(questionSetId: QuestionId, answers: readonly RunQuestionAnswer[]): void {
    this.#runQuestions.answer(questionSetId, answers);
  }

  cancelRunQuestion(questionSetId: QuestionId, reason = "Question cancelled by user"): void {
    this.#runQuestions.cancel(questionSetId, reason);
  }

  /** After stop, re-ask a next-Run Question when incomplete Plan items remain. */
  reaskNextRun(): boolean {
    if (this.active) throw new Error("Cannot re-ask next-Run while a Run is active");
    this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
    const view = this.#humanControl.reaskNextRunQuestion(this.sessionId);
    return view?.pendingQuestion?.status === "pending" && view.pendingQuestion.kind === "next_run";
  }

  mounts(): readonly RuntimeMount[] {
    return this.#mounts;
  }

  projectConfigPath(): string {
    return this.#projectConfigPath;
  }

  getMounts = (): readonly WorkspaceMount[] =>
    this.#mounts.map((mount) => ({ id: mount.id, path: mount.path, mode: mount.mode }));

  sensitivePathGrants(): readonly string[] {
    return this.#sensitivePathGrants;
  }

  sensitivePathPolicy(): SensitivePathPolicy {
    return this.#sensitivePathPolicy;
  }

  getSensitivePathGrants = (): readonly string[] => this.#sensitivePathGrants;

  async addMount(
    absolutePath: string,
    source: RuntimeMount["source"] = "command",
    mountId?: string,
  ): Promise<RuntimeMount> {
    const path = resolve(absolutePath);
    assertMountPathAllowed(path);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new TypeError(`Mount path must be a regular directory: ${path}`);
    }
    const existing = this.#mounts.find((mount) => resolve(mount.path) === path);
    if (existing) return existing;
    const used = new Set(this.#mounts.map((mount) => mount.id));
    const id = mountId && !used.has(mountId) ? mountId : suggestMountId(path, used);
    const mount: RuntimeMount = { id, path, mode: "read", source };
    const nextMounts = [...this.#mounts, mount];
    await this.#persistProjectMounts(nextMounts);
    this.#mounts = nextMounts;
    this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
    this.#humanControl.addMount(this.sessionId, {
      mountId: mount.id,
      path: mount.path,
      mode: "read",
      source: mount.source,
    });
    return mount;
  }

  async removeMount(mountId: string, reason = "User unmounted"): Promise<void> {
    if (!this.#mounts.some((mount) => mount.id === mountId)) {
      throw new TypeError(`Unknown mount id: ${mountId}`);
    }
    const nextMounts = this.#mounts.filter((mount) => mount.id !== mountId);
    await this.#persistProjectMounts(nextMounts);
    this.#mounts = nextMounts;
    this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
    this.#humanControl.removeMount(this.sessionId, mountId, reason);
  }

  /** Reconcile the Session audit projection to the effective runtime mount authority. */
  syncMountEvents(): void {
    const view = this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
    const effective = new Map(this.#mounts.map((mount) => [mount.id, mount]));
    for (const projected of Object.values(view.mounts)) {
      const current = effective.get(projected.mountId);
      if (
        !current ||
        resolve(current.path) !== resolve(projected.path) ||
        current.mode !== projected.mode ||
        current.source !== projected.source
      ) {
        this.#humanControl.removeMount(
          this.sessionId,
          projected.mountId,
          current ? "Effective mount identity changed at launch" : "Mount is absent from effective launch policy",
          { kind: "runtime", id: "mount_reconciler" },
        );
      }
    }
    for (const mount of this.#mounts) {
      const projected = view.mounts[mount.id];
      if (
        projected &&
        resolve(projected.path) === resolve(mount.path) &&
        projected.mode === mount.mode &&
        projected.source === mount.source
      ) {
        continue;
      }
      this.#humanControl.addMount(this.sessionId, {
        mountId: mount.id,
        path: mount.path,
        mode: "read",
        source: mount.source,
      }, { kind: "runtime", id: "mount_reconciler" });
    }
  }

  async grantSensitivePath(relativePath: string): Promise<string> {
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    if (normalized.startsWith("mount:")) {
      throw new TypeError(`Sensitive path grants apply to Workspace-relative paths, not mounts: ${normalized}`);
    }
    if (this.#sensitivePathGrants.includes(normalized)) return normalized;
    const nextGrants = [...this.#sensitivePathGrants, normalized];
    await this.#persistSensitivePathGrants(nextGrants);
    this.#sensitivePathGrants = nextGrants;
    this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
    this.#humanControl.grantSensitivePath(this.sessionId, normalized, "grant");
    return normalized;
  }

  async revokeSensitivePath(
    relativePath: string,
    reason = "User revoked sensitive path grant",
  ): Promise<void> {
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    if (!this.#sensitivePathGrants.includes(normalized)) {
      throw new TypeError(`Unknown sensitive path grant: ${normalized}`);
    }
    const nextGrants = this.#sensitivePathGrants.filter((path) => path !== normalized);
    await this.#persistSensitivePathGrants(nextGrants);
    this.#sensitivePathGrants = nextGrants;
    this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
    this.#humanControl.revokeSensitivePath(this.sessionId, normalized, reason);
  }

  /** Reconcile Session audit projection to the effective sensitive-path grant allowlist. */
  syncSensitivePathEvents(): void {
    const view = this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
    const effective = new Set(this.#sensitivePathGrants.map((path) => normalizeWorkspaceRelativePath(path)));
    for (const projected of Object.keys(view.sensitivePathGrants)) {
      if (!effective.has(projected)) {
        this.#humanControl.revokeSensitivePath(
          this.sessionId,
          projected,
          "Grant is absent from effective project policy",
          { kind: "runtime", id: "sensitive_path_reconciler" },
        );
      }
    }
    for (const path of this.#sensitivePathGrants) {
      const normalized = normalizeWorkspaceRelativePath(path);
      if (view.sensitivePathGrants[normalized]) continue;
      this.#humanControl.grantSensitivePath(
        this.sessionId,
        normalized,
        "project_config",
        { kind: "runtime", id: "sensitive_path_reconciler" },
      );
    }
  }

  async run(input: string, content?: readonly RunInputPart[]): Promise<TurnResult> {
    return this.#executeTurn({
      input,
      ...(content === undefined ? {} : { content }),
    });
  }

  createGoal(contract: GoalContractInput, control?: Partial<ControlGrant>): GoalView {
    if (this.active) throw new Error("Cannot create a Goal while a Run is active");
    this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
    const engine = new GoalEngine(this.#eventStore, this.sessionId);
    return engine.create(contract, {
      issuedTo: control?.issuedTo ?? "user",
      startRight: control?.startRight ?? "user",
      stopRight: control?.stopRight ?? "user",
      acceptanceRight: control?.acceptanceRight ?? "human",
      delegationRight: control?.delegationRight ?? false,
      actionLeaseIds: control?.actionLeaseIds ?? [],
    });
  }

  changeGoalState(state: "active" | "paused" | "blocked" | "cancelled", reason: string, goalId?: GoalId): GoalView {
    if (this.active) throw new Error("Cannot change Goal state while a Run is active");
    const goal = this.#requireCurrentGoal(goalId);
    const engine = new GoalEngine(this.#eventStore, this.sessionId);
    return engine.changeState(goal.goalId, state, reason);
  }

  async continueGoal(input?: string): Promise<TurnResult> {
    if (this.active) throw new Error("A Run is already active");
    let goal = this.#requireCurrentGoal();
    if (goal.state === "paused" || goal.state === "blocked") {
      goal = this.changeGoalState("active", input?.trim() ? `Resumed for continue: ${input.trim()}` : "Resumed for Goal continue");
    }
    if (goal.state !== "active") {
      throw new Error(`Goal ${goal.goalId} is ${goal.state} and cannot continue`);
    }
    const prompt = input?.trim()
      || `Continue the active Goal: ${goal.objective}`;
    return this.#executeTurn({
      input: prompt,
      goalBinding: { goalId: goal.goalId, contractVersion: goal.contractVersion },
      trigger: "goal",
    });
  }

  settleGoalContinuation(runId: RunId): GoalContinuationDecision {
    const view = this.view();
    if (!view) {
      this.#lastGoalContinuation = { kind: "noop", reason: "Session view missing" };
      return this.#lastGoalContinuation;
    }
    const goalId = view.runs[runId]?.goalBinding?.goalId;
    if (!goalId) {
      this.#lastGoalContinuation = { kind: "noop", reason: "Run is not Goal-bound" };
      return this.#lastGoalContinuation;
    }
    const engine = new GoalEngine(this.#eventStore, this.sessionId);
    const control = this.#latestGoalControl(goalId);
    const { decision } = settleGoalBoundTurn({
      view,
      runId,
      controller: {
        complete: (id, evaluationIds) => engine.complete(id, evaluationIds, control),
        changeState: (id, state, reason) => engine.changeState(id, state, reason),
      },
    });
    this.#lastGoalContinuation = decision;
    return decision;
  }

  demoteActiveGoalAfterResume(): GoalView | undefined {
    const view = this.view();
    if (!view?.currentGoalId) return undefined;
    const engine = new GoalEngine(this.#eventStore, this.sessionId);
    return demoteActiveGoalAfterResume(view, {
      changeState: (id, state, reason) => engine.changeState(id, state, reason),
    });
  }

  /** Shortcut: human Accept = reassess with outcome pass. */
  async acceptGoalEvidence(note?: string): Promise<{
    readonly goal: GoalView;
    readonly completed: boolean;
    readonly evaluationIds: readonly EvaluationId[];
    readonly outcome: EvalOutcome;
  }> {
    return this.reassessGoalEvidence({
      outcome: "pass",
      rationale: note?.trim() || "",
    });
  }

  /**
   * Open a short Goal-bound Run, record human evidence + HumanEvaluator evaluations (Kernel requires
   * an active Run for `evaluation.completed`), then settle. Pass may complete; fail/unknown never do.
   */
  async reassessGoalEvidence(input: {
    readonly outcome: EvalOutcome;
    readonly rationale: string;
  }): Promise<{
    readonly goal: GoalView;
    readonly completed: boolean;
    readonly evaluationIds: readonly EvaluationId[];
    readonly outcome: EvalOutcome;
  }> {
    if (this.active) throw new Error("Cannot reassess Goal evidence while a Run is active");
    const outcome = input.outcome;
    const rationale = input.rationale.trim();
    if ((outcome === "fail" || outcome === "unknown") && !rationale) {
      throw new Error("Rationale is required when outcome is fail or unknown");
    }
    let goal = this.#requireCurrentGoal();
    if (goal.state === "complete" || goal.state === "cancelled") {
      throw new Error(`Goal ${goal.goalId} is already ${goal.state}`);
    }
    if (goal.state === "paused" || goal.state === "blocked") {
      goal = this.changeGoalState(
        "active",
        rationale ? `Resumed for human reassess: ${rationale}` : "Resumed for human reassess",
      );
    }
    this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
    const runId = createId("run") as RunId;
    const stepId = createId("stp");
    const writer = new EventWriter(this.#eventStore, this.sessionId);
    const user = { kind: "user" as const, id: "tui-user" };
    const runtime = { kind: "runtime" as const, id: "qi" };
    const description = rationale
      || (outcome === "pass"
        ? `Human acceptance of Goal ${goal.goalId}`
        : `Human reassess (${outcome}) of Goal ${goal.goalId}`);
    writer.append(
      "run.triggered",
      {
        runId,
        trigger: "goal",
        input: description,
        mode: this.mode(),
        goalBinding: { goalId: goal.goalId, contractVersion: goal.contractVersion },
      },
      user,
    );
    writer.append("run.started", { runId }, runtime);
    writer.append("step.started", { runId, stepId }, runtime);
    const engine = new GoalEngine(this.#eventStore, this.sessionId);
    const evaluationIds: EvaluationId[] = [];
    for (const assertion of Object.values(goal.assertions)) {
      if (!assertion.required) continue;
      const artifactRef = `human://goal/${goal.goalId}/${assertion.assertionId}/${createId("evi")}`;
      engine.recordEvidence({
        goalId: goal.goalId,
        runId,
        assertionId: assertion.assertionId,
        kind: "human",
        artifactRef,
        description,
        producer: "qi-tui-user",
        reproducible: false,
      });
      const humanInput: HumanEvalInput = { rationale: description, outcome };
      const evaluationId = await engine.evaluate({
        goalId: goal.goalId,
        runId,
        assertionId: assertion.assertionId,
        evaluator: new HumanEvaluator<HumanEvalInput>("human-reassess-v1", (evaluateInput) => ({
          outcome: evaluateInput.outcome,
          evidenceRefs: [artifactRef],
          reproducible: false,
        })),
        input: humanInput,
      });
      evaluationIds.push(evaluationId);
    }
    writer.append("step.completed", { runId, stepId, finishReason: "response" }, runtime);
    writer.append(
      "run.completed",
      { runId, completionKind: "response", evaluationIds: [...evaluationIds] },
      runtime,
    );
    const decision = this.settleGoalContinuation(runId);
    const completed = decision.kind === "complete";
    return {
      goal: this.#requireCurrentGoal(goal.goalId),
      completed,
      evaluationIds,
      outcome,
    };
  }

  recordModelConfiguration(
    configuration: {
      provider: string;
      accountAlias: string;
      model: string;
      reasoningEffort?: "low" | "medium" | "high" | "max" | "none";
      contextWindowTokens: number;
      imageInput: boolean;
    },
    persistence: "account" | "session",
  ): SessionView {
    if (this.active) throw new Error("Cannot change model while a Run is active");
    this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
    new EventWriter(this.#eventStore, this.sessionId).append(
      "session.model.configured",
      { ...configuration, persistence },
      { kind: "user", id: "tui-user" },
    );
    return this.#eventStore.load(this.sessionId)!;
  }

  async ingestClipboardImage(bytes: Uint8Array): Promise<RunImagePart> {
    const model = this.#resolveModel();
    const capabilities = await this.#modelPort.capabilities(model);
    if (!capabilities.input.has("image")) {
      throw new TypeError(`Model ${model.provider}/${model.model} does not support image input`);
    }
    return this.#imageIngest.ingestBytes({
      bytes,
      source: "clipboard",
      declaredMediaType: "image/png",
    });
  }

  async runPlanDraft(input: string): Promise<TurnResult> {
    if (this.mode() !== "plan") throw new Error("Formal Plan drafting requires Plan mode");
    return this.#executeTurn({
      input,
      requiredCompletionTool: {
        toolName: "plan_document",
        effect: "write",
        parkReason: "review",
        correction:
          "This drafting Run is not complete. If information is missing, ask the user with ask_question when available. " +
          "Otherwise call plan_document create/edit with the complete self-contained Formal Plan Markdown now. " +
          "A plan_document read only supplies the latest Markdown and SHA; it does not complete the drafting Run. " +
          "Do not claim a revision was persisted until that create/edit Action completes.",
      },
    });
  }

  /** Execute a Run that HumanControlService already triggered (Plan accept / next-run continue). */
  async runTriggered(runId: RunId, input: string): Promise<TurnResult> {
    const run = this.view()?.runs[runId];
    const revision = run?.planBinding === undefined
      ? undefined
      : this.view()?.plans[run.planBinding.planId]?.revisions[run.planBinding.revision];
    return this.#executeTurn({
      input,
      existingRunId: runId,
      ...(revision?.format === "formal_markdown" ? { historyBudgetTokens: 0 } : {}),
    });
  }

  async #executeTurn(options: {
    input: string;
    content?: readonly RunInputPart[];
    existingRunId?: RunId;
    historyBudgetTokens?: number;
    requiredCompletionTool?: TurnRequest["requiredCompletionTool"];
    goalBinding?: TurnRequest["goalBinding"];
    trigger?: TurnRequest["trigger"];
  }): Promise<TurnResult> {
    if (!options.input.trim()) throw new TypeError("Input must not be empty");
    if (this.#activeController) throw new Error("A Run is already active");
    // Mark active before any await so mid-start capability/shell changes still deny.
    const controller = new AbortController();
    this.#activeController = controller;
    try {
      await this.ensureProjectMemoryReady();
      this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
      this.syncMountEvents();
      this.syncSensitivePathEvents();
      const mode = this.mode();
      const model = this.#resolveModel();
      const capabilities = await this.#modelPort.capabilities(model);
      if (!this.#contextWindowTokensOverride) {
        this.syncModelContextWindow(capabilities.contextTokens);
      }
      this.#syncImageTool(capabilities);
      const content = await this.#prepareInputContent(options.input, options.content, capabilities);
      const skills = await this.refreshSkills();
      const contextCapabilities = {
        write: this.#allowWrite,
        verify: this.#allowVerify,
        network: this.#allowNetwork,
        execute: this.#allowExecute,
        background: this.#allowBackground,
        delegate: this.#allowDelegate,
      };
      const workspaceInstructions = await loadRootWorkspaceInstructions(this.#workspaceRoot, {
        required: mode === "plan" || (mode === "agent" && this.#allowWrite),
      });
      const contextBlocks = buildTuiContextBlocks({
        verificationProfiles: this.#verificationProfiles,
        shellProfiles: this.shellProfiles,
        ...(this.#codeactRuntime === undefined ? {} : { codeactRuntime: this.#codeactRuntime }),
        skills,
        capabilities: contextCapabilities,
        mode,
        mounts: this.#mounts,
        ...(workspaceInstructions === undefined ? {} : { workspaceInstructions }),
      });
      if (this.#memoryEnabled) {
        const memoryBlock = buildMemoryContextBlock(this.#memoryClaims(options.input));
        if (memoryBlock) contextBlocks.push(memoryBlock);
      }
      const result = await this.#supervisor.exclusive(this.sessionId, () => this.#loop.run({
        sessionId: this.sessionId,
        title: "Qi TUI",
        subject: this.#subject,
        input: options.input,
        ...(content === undefined ? {} : { content }),
        model,
        contextBlocks,
        contextBudgetTokens: this.#contextBudgetTokens,
        ...(capabilities.tokenEstimator === undefined
          ? {}
          : { tokenEstimator: capabilities.tokenEstimator }),
        maxOutputTokens: this.#outputReserveTokens,
        historyBudgetTokens: options.historyBudgetTokens ?? TUI_HISTORY_BUDGET_TOKENS,
        maxSteps: this.#maxSteps,
        reserveFinalHandoff: true,
        maxActionsPerStep: this.#maxActionsPerStep,
        ...(options.requiredCompletionTool === undefined
          ? {}
          : { requiredCompletionTool: options.requiredCompletionTool }),
        mode,
        ...(options.existingRunId === undefined ? {} : { existingRunId: options.existingRunId }),
        ...(options.goalBinding === undefined ? {} : { goalBinding: options.goalBinding }),
        ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
        workspaceRoot: this.#workspaceRoot,
        artifactStore: this.#artifactStore,
        effectJournal: this.#effectJournal,
        signal: controller.signal,
        getMounts: this.getMounts,
        getSensitivePathGrants: this.getSensitivePathGrants,
        sensitivePathPolicy: this.#sensitivePathPolicy,
      }));
      if (result.view.runs[result.runId]?.goalBinding) {
        this.settleGoalContinuation(result.runId);
      } else {
        this.#lastGoalContinuation = undefined;
      }
      this.#humanControl.askNextRunQuestion(this.sessionId, result.runId);
      return result;
    } finally {
      this.#activeController = undefined;
    }
  }

  #requireCurrentGoal(goalId?: GoalId): GoalView {
    const view = this.view();
    const id = goalId ?? view?.currentGoalId;
    if (!view || !id) throw new Error("No Goal in this Session; create one with /goal <objective>");
    const goal = view.goals[id];
    if (!goal) throw new Error(`Goal ${id} does not exist`);
    return goal;
  }

  #latestGoalControl(goalId: GoalId): ControlGrant {
    const receipt = Object.values(this.view()?.controlReceipts ?? {})
      .filter((item) => item.goalId === goalId)
      .at(-1);
    return {
      issuedTo: receipt?.issuedTo ?? "user",
      startRight: receipt?.startRight ?? "user",
      stopRight: receipt?.stopRight ?? "user",
      acceptanceRight: receipt?.acceptanceRight ?? "human",
      delegationRight: receipt?.delegationRight ?? false,
      actionLeaseIds: receipt?.actionLeaseIds ?? [],
    };
  }

  steer(message: string): void {
    if (!this.#activeController) throw new Error("No active Run to steer");
    this.#loop.steer(this.sessionId, message, "user");
  }

  cancel(reason = "Cancelled from TUI"): void {
    this.#activeController?.abort(new Error(reason));
  }

  async close(): Promise<void> {
    this.cancel("TUI closed");
    await this.#processTasks.close(this.sessionId);
    await this.#projectMemoryWarm.catch(() => undefined);
    if (this.#codeactProbe) await this.#codeactProbe.catch(() => undefined);
    this.#projectMemoryIndex.close();
    this.#userMemoryIndex.close();
    this.#userMemoryStore.close();
    this.#ownedStore?.close();
    this.#effectJournal.close();
  }

  async #prepareInputContent(
    input: string,
    supplied: readonly RunInputPart[] | undefined,
    capabilities: ModelCapabilities,
  ): Promise<readonly RunInputPart[] | undefined> {
    if (supplied !== undefined) {
      if (supplied.some((part) => part.type === "image") && !capabilities.input.has("image")) {
        throw new TypeError("The selected model does not support image input");
      }
      return supplied.map((part) => ({ ...part }));
    }
    const candidates = detectImageInputCandidates(input);
    if (candidates.length === 0) return undefined;
    if (!capabilities.input.has("image")) {
      throw new TypeError(
        "The input contains an image path or URL, but the selected model does not support image input",
      );
    }
    const content: RunInputPart[] = [];
    let cursor = 0;
    for (const candidate of candidates) {
      if (candidate.start < cursor) continue;
      const text = input.slice(cursor, candidate.end);
      if (text) content.push({ type: "text", text });
      if (candidate.kind === "url") {
        content.push(await this.#imageIngest.ingestUrl(candidate.url, {
          networkAuthorized: this.#allowNetwork,
          ...(this.#activeController === undefined ? {} : { signal: this.#activeController.signal }),
        }));
      } else {
        content.push(await this.#ingestImagePath(candidate.path));
      }
      cursor = candidate.end;
    }
    const tail = input.slice(cursor);
    if (tail) content.push({ type: "text", text: tail });
    return content;
  }

  async #ingestImagePath(requested: string): Promise<RunImagePart> {
    const logical = await rewriteImagePathOntoAuthorizedRoot(
      requested,
      this.#workspaceRoot,
      this.getMounts(),
    );
    const resolved = await resolveAccessiblePath(this.#workspaceRoot, logical, this.getMounts());
    if (!(await isRegularFile(resolved.absolute))) {
      throw new TypeError(`Image path is not a regular file: ${requested}`);
    }
    const bytes = new Uint8Array(await readFile(resolved.absolute));
    return this.#imageIngest.ingestBytes({ bytes, source: "path" });
  }

  #syncImageTool(capabilities: ModelCapabilities): void {
    if (!capabilities.input.has("image")) {
      this.#closeOptionalTool("read_image");
      return;
    }
    this.#setOptionalTool("read_image", createReadImageTool({
      getAllowedOriginalRefs: (sessionId) => collectOriginalImageRefs(this.#eventStore.load(sessionId as SessionId)),
      ...(this.#readImageByteBudget === undefined ? {} : { byteBudget: this.#readImageByteBudget }),
    }));
  }

  listMemories(options: MemoryListOptions = {}): IndexedMemoryClaim[] {
    return [...this.#projectMemory.list(options), ...this.#userMemory.list(options)]
      .sort((left, right) =>
        right.validFrom.localeCompare(left.validFrom) || left.memoryId.localeCompare(right.memoryId));
  }

  pendingMemoryCountForLatestRun(): number {
    const trigger = [...this.events()].reverse().find((event) => event.type === "run.triggered");
    if (!trigger) return 0;
    return this.listMemories({ statuses: ["candidate"], limit: 500 }).filter(
      (claim) =>
        claim.validFrom >= trigger.occurredAt
        && claim.provenance.some((source) => source.sessionId === this.sessionId),
    ).length;
  }

  acceptMemory(memoryId: string): IndexedMemoryClaim {
    return this.#memoryControllerFor(memoryId).accept(memoryId as never, { kind: "user", id: "local" });
  }

  forgetMemory(memoryId: string, reason = "User requested forgetting"): IndexedMemoryClaim {
    return this.#memoryControllerFor(memoryId).forget(memoryId as never, reason, "local");
  }

  correctMemory(memoryId: string, statement: string): IndexedMemoryClaim {
    const controller = this.#memoryControllerFor(memoryId);
    const current = controller.list({ limit: 500 }).find((claim) => claim.memoryId === memoryId);
    if (!current) throw new Error(`Memory ${memoryId} does not exist`);
    const source = this.#recordUserAssertion(
      statement,
      current.scope,
      this.#memoryOperationId("correct", statement, memoryId),
    );
    return controller.correct(memoryId as never, {
      layer: current.layer,
      statement,
      provenance: [source],
      confidence: 1,
      sensitivity: current.sensitivity,
      requiresConfirmation: true,
    }, "local");
  }

  setMemoryActivation(memoryId: string, activation: "relevant" | "always"): IndexedMemoryClaim {
    return this.#userMemory.setActivation(memoryId as never, activation, "local");
  }

  rememberMemory(
    statement: string,
    scopeKind: "session" | "project" | "user",
    activation: "relevant" | "always" = "relevant",
  ): IndexedMemoryClaim {
    if (activation === "always" && scopeKind !== "user") {
      throw new Error("Always activation is only available for User Memory");
    }
    const scope = scopeKind === "session"
      ? { kind: "session" as const, sessionId: this.sessionId }
      : scopeKind === "project"
        ? { kind: "project" as const, projectId: this.#projectId }
        : { kind: "user" as const, userId: "local" as const };
    const controller = scopeKind === "user" ? this.#userMemory : this.#projectMemory;
    const normalizedStatement = statement.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    const duplicate = controller.list({
      scopes: [scope],
      statuses: ["candidate", "accepted"],
      limit: 500,
    }).find((claim) =>
      claim.statement.trim().replace(/\s+/g, " ").toLocaleLowerCase() === normalizedStatement);
    if (duplicate) {
      const accepted = duplicate.status === "candidate"
        ? controller.accept(duplicate.memoryId, { kind: "user", id: "local" })
        : duplicate;
      if (activation !== "always" || accepted.activation === "always") return accepted;
      this.#assertAlwaysMemoryAvailable(accepted.statement);
      return this.#userMemory.setActivation(accepted.memoryId, "always", "local");
    }
    if (activation === "always") this.#assertAlwaysMemoryAvailable(statement);
    const operationId = this.#memoryOperationId("remember", statement, memoryScopeKey(scope));
    const source = this.#recordUserAssertion(statement, scope, operationId);
    const claim = controller.propose({
      operationId,
      layer: "semantic",
      statement,
      scope,
      provenance: [source],
      confidence: 1,
      sensitivity: scopeKind === "user" ? "private" : "public",
      requiresConfirmation: scopeKind === "user",
    }, { actorId: "local", autoAccept: scopeKind !== "user" });
    const accepted = claim.status === "candidate"
      ? controller.accept(claim.memoryId, { kind: "user", id: "local" })
      : claim;
    return activation === "always"
      ? controller.setActivation(accepted.memoryId, "always", "local")
      : accepted;
  }

  promoteMemory(memoryId: string, activation: "relevant" | "always" = "relevant"): IndexedMemoryClaim {
    const sourceClaim = this.#projectMemory.list({ limit: 500 }).find((claim) => claim.memoryId === memoryId);
    if (
      !sourceClaim
      || sourceClaim.status !== "accepted"
      || typeof sourceClaim.scope === "string"
      || sourceClaim.scope.kind !== "project"
    ) {
      throw new Error(`Accepted project Memory ${memoryId} not found`);
    }
    const existing = this.#userMemory.list({ limit: 500 }).find(
      (claim) => claim.operationId === `promote:${memoryId}`,
    );
    if (existing?.status === "accepted") {
      if (activation !== "always" || existing.activation === "always") return existing;
      this.#assertAlwaysMemoryAvailable(existing.statement);
      return this.#userMemory.setActivation(existing.memoryId, "always", "local");
    }
    if (activation === "always") this.#assertAlwaysMemoryAvailable(sourceClaim.statement);
    const claim = this.#userMemory.propose({
      operationId: `promote:${memoryId}`,
      layer: sourceClaim.layer,
      statement: sourceClaim.statement,
      scope: { kind: "user", userId: "local" },
      provenance: sourceClaim.provenance.map((source) => ({ ...source })),
      confidence: sourceClaim.confidence,
      sensitivity: sourceClaim.sensitivity === "public" ? "private" : sourceClaim.sensitivity,
      derivedFromMemoryId: sourceClaim.memoryId,
      requiresConfirmation: true,
    }, { actorId: "local" });
    const accepted = claim.status === "candidate"
      ? this.#userMemory.accept(claim.memoryId, { kind: "user", id: "local" })
      : claim;
    return activation === "always"
      ? this.#userMemory.setActivation(accepted.memoryId, "always", "local")
      : accepted;
  }

  #memoryControllerFor(memoryId: string): MemoryController {
    if (this.#projectMemory.list({ limit: 500 }).some((claim) => claim.memoryId === memoryId)) {
      return this.#projectMemory;
    }
    if (this.#userMemory.list({ limit: 500 }).some((claim) => claim.memoryId === memoryId)) {
      return this.#userMemory;
    }
    throw new Error(`Memory ${memoryId} does not exist`);
  }

  #assertAlwaysMemoryAvailable(statement: string): void {
    if (statement.length > 1_000) {
      throw new Error("Always-active User Memory is limited to 1,000 characters");
    }
    const count = this.#userMemory.list({
      scopes: [{ kind: "user", userId: "local" }],
      statuses: ["accepted"],
      limit: 500,
    }).filter((claim) => claim.activation === "always").length;
    if (count >= 4) throw new Error("At most four User Memories may be always active");
  }

  #recordUserAssertion(
    statement: string,
    scope: IndexedMemoryClaim["scope"],
    operationId = this.#memoryOperationId("assert", statement, memoryScopeKey(scope)),
  ): { projectId: string; sessionId: SessionId; eventId: string; sequence: number } {
    if (redactSensitiveValue(statement).redactions.length > 0) {
      throw new Error("Memory contains credential-like secret material and was not recorded");
    }
    this.#humanControl.ensureSession(this.sessionId, "Qi TUI");
    if (typeof scope === "string") throw new Error("Legacy memory scope cannot receive a new user assertion");
    for (const session of this.#eventStore.listSessions()) {
      const existing = this.#eventStore.read(session.sessionId).events.find(
        (event) =>
          event.type === "memory.user.asserted"
          && event.data.operationId === operationId,
      );
      if (existing?.type === "memory.user.asserted") {
        this.#projectMemoryIndex.apply(existing);
        return {
          projectId: this.#projectId,
          sessionId: existing.sessionId,
          eventId: existing.eventId,
          sequence: existing.sequence,
        };
      }
    }
    const event = new EventWriter(this.#eventStore, this.sessionId).append(
      "memory.user.asserted",
      { operationId, statement, scope },
      { kind: "user", id: "local" },
    );
    this.#projectMemoryIndex.apply(event);
    return {
      projectId: this.#projectId,
      sessionId: event.sessionId,
      eventId: event.eventId,
      sequence: event.sequence,
    };
  }

  #memoryOperationId(kind: string, statement: string, subject: string): string {
    const digest = createHash("sha256")
      .update(`${kind}\0${subject}\0${statement.trim().replace(/\s+/g, " ").toLocaleLowerCase()}`)
      .digest("hex");
    return `${kind}:${digest}`;
  }

  #memoryClaims(input: string): IndexedMemoryClaim[] {
    const userScope = { kind: "user" as const, userId: "local" as const };
    const pinned = this.#userMemory.retrieve({
      scopes: [userScope],
      activation: "always",
      maximumSensitivity: "secret",
      limit: 4,
    });
    const relevant = [
      ...this.#projectMemory.retrieve({
        scopes: [
          { kind: "session", sessionId: this.sessionId },
          { kind: "project", projectId: this.#projectId },
        ],
        query: input,
        maximumSensitivity: "secret",
        limit: 12,
      }),
      ...this.#userMemory.retrieve({
        scopes: [userScope],
        query: input,
        activation: "relevant",
        maximumSensitivity: "secret",
        limit: 4,
      }),
    ];
    const seen = new Set<string>();
    const rankedRelevant = relevant.sort((left, right) =>
      memoryRelevanceScore(right, input) - memoryRelevanceScore(left, input)
      || right.confidence - left.confidence
      || (right.acceptedAt ?? right.validFrom).localeCompare(left.acceptedAt ?? left.validFrom)
      || left.memoryId.localeCompare(right.memoryId));
    return [...pinned, ...rankedRelevant]
      .filter((claim) => {
        const key = claim.statement.trim().replace(/\s+/g, " ").toLocaleLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 12);
  }

  async flushMountsToProjectConfig(): Promise<void> {
    await this.#persistProjectMounts();
  }

  async saveProjectCapabilities(capabilities: QiProjectConfig["capabilities"]): Promise<void> {
    const loaded = await loadProjectConfig(this.#projectConfigPath);
    const next: QiProjectConfig = {
      version: 1,
      ...(loaded.config.maxSteps === undefined ? {} : { maxSteps: loaded.config.maxSteps }),
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(loaded.config.shell === undefined ? {} : { shell: loaded.config.shell }),
      ...(this.#mounts.length === 0
        ? {}
        : {
          mounts: this.#mounts.map((mount) => ({
            id: mount.id,
            path: mount.path,
            mode: "read" as const,
          })),
        }),
      ...this.#sensitivePathConfigFields(),
    };
    await saveProjectConfig(this.#projectConfigPath, next);
  }

  async #persistProjectMounts(mounts: readonly RuntimeMount[] = this.#mounts): Promise<void> {
    const loaded = await loadProjectConfig(this.#projectConfigPath);
    const next: QiProjectConfig = {
      version: 1,
      ...(loaded.config.maxSteps === undefined ? {} : { maxSteps: loaded.config.maxSteps }),
      ...(loaded.config.capabilities === undefined ? {} : { capabilities: loaded.config.capabilities }),
      ...(loaded.config.shell === undefined ? {} : { shell: loaded.config.shell }),
      mounts: mounts.map((mount) => ({ id: mount.id, path: mount.path, mode: "read" as const })),
      ...this.#sensitivePathConfigFields(),
    };
    await saveProjectConfig(this.#projectConfigPath, next);
  }

  async #persistSensitivePathGrants(grants: readonly string[] = this.#sensitivePathGrants): Promise<void> {
    const loaded = await loadProjectConfig(this.#projectConfigPath);
    const next: QiProjectConfig = {
      version: 1,
      ...(loaded.config.maxSteps === undefined ? {} : { maxSteps: loaded.config.maxSteps }),
      ...(loaded.config.capabilities === undefined ? {} : { capabilities: loaded.config.capabilities }),
      ...(loaded.config.shell === undefined ? {} : { shell: loaded.config.shell }),
      ...(this.#mounts.length === 0
        ? {}
        : {
          mounts: this.#mounts.map((mount) => ({
            id: mount.id,
            path: mount.path,
            mode: "read" as const,
          })),
        }),
      ...(grants.length === 0 ? {} : { sensitivePathGrants: [...grants] }),
      ...(hasSensitivePathPolicy(this.#sensitivePathPolicy)
        ? { sensitivePaths: cloneSensitivePathPolicy(this.#sensitivePathPolicy) }
        : {}),
    };
    await saveProjectConfig(this.#projectConfigPath, next);
  }

  #sensitivePathConfigFields(): Pick<QiProjectConfig, "sensitivePathGrants" | "sensitivePaths"> {
    return {
      ...(this.#sensitivePathGrants.length === 0
        ? {}
        : { sensitivePathGrants: [...this.#sensitivePathGrants] }),
      ...(hasSensitivePathPolicy(this.#sensitivePathPolicy)
        ? { sensitivePaths: cloneSensitivePathPolicy(this.#sensitivePathPolicy) }
        : {}),
    };
  }
}

export function contextBudgetFromWindow(contextWindowTokens: number, outputReserveTokens: number): number {
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 8_192 || contextWindowTokens > 2_000_000) {
    throw new RangeError("contextWindowTokens must be an integer between 8192 and 2000000");
  }
  if (!Number.isInteger(outputReserveTokens) || outputReserveTokens < 1 || outputReserveTokens >= contextWindowTokens) {
    throw new RangeError("outputReserveTokens must be a positive integer smaller than the model window");
  }
  return contextWindowTokens - outputReserveTokens;
}

function freezeSensitivePathPolicy(policy: SensitivePathPolicy | undefined): SensitivePathPolicy {
  return Object.freeze(cloneSensitivePathPolicy(policy ?? {}));
}

function cloneSensitivePathPolicy(policy: SensitivePathPolicy): SensitivePathPolicy {
  return {
    ...(policy.extra === undefined ? {} : { extra: Object.freeze([...policy.extra]) }),
    ...(policy.exclude === undefined ? {} : { exclude: Object.freeze([...policy.exclude]) }),
  };
}

function hasSensitivePathPolicy(policy: SensitivePathPolicy): boolean {
  return (policy.extra?.length ?? 0) > 0 || (policy.exclude?.length ?? 0) > 0;
}

function leaseExpiry(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString();
}

function collectOriginalImageRefs(view: SessionView | undefined): ReadonlySet<string> {
  const refs = new Set<string>();
  if (!view) return refs;
  for (const runId of view.runOrder) {
    for (const part of view.runs[runId]?.content ?? []) {
      if (part.type === "image") refs.add(part.originalArtifactRef);
    }
  }
  return refs;
}

function grantBaseRuntimeLeases(broker: InMemoryCapabilityBroker, subject: string): void {
  const expiresAt = leaseExpiry();
  for (const lease of [
    {
      leaseId: "lea_tui_read",
      subject,
      tools: ["read", "list", "search", "find", "tree", "git", "skill", "qi_introspect", "qi_session_inspect", "memory", "read_image"],
      effects: ["read"],
      resources: [
        "file:**",
        "tree:**",
        "vcs:.",
        "skill-catalog:local",
        "skill:**",
        "qi:self-model:**",
        "qi:session-catalog",
        "qi:session:**",
        "memory:propose:**",
        "artifact:**",
      ],
      expiresAt,
    },
    {
      leaseId: "lea_tui_artifact",
      subject,
      tools: ["artifact"],
      effects: ["write"],
      resources: ["artifact-store:local:**"],
      expiresAt,
    },
    {
      leaseId: "lea_tui_plan",
      subject,
      tools: ["plan_document"],
      effects: ["read", "write"],
      resources: ["plan:document:**"],
      expiresAt,
    },
    {
      leaseId: "lea_tui_work_plan",
      subject,
      tools: ["update_plan"],
      effects: ["read"],
      resources: ["work-plan:**"],
      expiresAt,
    },
    {
      leaseId: "lea_tui_run_question",
      subject,
      tools: ["ask_question"],
      effects: ["read"],
      resources: ["run-question:user"],
      expiresAt,
    },
  ] satisfies CapabilityLease[]) {
    broker.grant(lease);
  }
}

function grantOptionalRuntimeLeases(
  broker: InMemoryCapabilityBroker,
  subject: string,
  allowWrite: boolean,
  verificationProfiles: readonly VerificationProfile[],
  shellProfiles: ShellProfileSnapshot,
  codeactRuntime: "docker" | "podman" | undefined,
  allowNetwork: boolean,
  allowBackground: boolean,
  allowDelegate: boolean,
): void {
  const expiresAt = leaseExpiry();
  const leases: CapabilityLease[] = [];
  if (allowWrite) {
    leases.push({
      leaseId: "lea_tui_write",
      subject,
      tools: ["write", "edit", "move", "remove", "skill"],
      effects: ["write"],
      resources: ["file:**", "artifact-store:local", "skill-source:local:**", "skill:workspace:**"],
      expiresAt,
    });
  }
  if (verificationProfiles.length > 0) {
    leases.push({
      leaseId: "lea_tui_verify",
      subject,
      tools: ["verify"],
      effects: ["execute"],
      resources: verificationProfiles.map(verificationResource),
      expiresAt,
    });
  }
  if (shellProfiles.directEnabled) {
    leases.push({
      leaseId: "lea_tui_execute_direct",
      subject,
      tools: ["shell"],
      effects: ["execute"],
      resources: ["host-process:**", "host-workspace:**", shellProfileResource("direct")],
      expiresAt,
    });
  }
  if (shellProfiles.available.length > 0) {
    leases.push({
      leaseId: "lea_tui_execute_script",
      subject,
      tools: ["script"],
      effects: ["execute"],
      resources: [
        "host-workspace:**",
        ...shellProfiles.available.map((profile) => shellProfileResource(profile.id)),
      ],
      expiresAt,
    });
  }
  if (codeactRuntime) {
    leases.push({
      leaseId: "lea_tui_execute_codeact",
      subject,
      tools: ["codeact"],
      effects: ["execute"],
      resources: [`container-runtime:${codeactRuntime}`],
      expiresAt,
    });
  }
  if (allowNetwork) {
    leases.push({
      leaseId: "lea_tui_network",
      subject,
      tools: ["fetch"],
      effects: ["read"],
      resources: ["network:https://**", "network:http://**"],
      expiresAt,
    });
  }
  if (allowBackground) {
    leases.push({
      leaseId: "lea_tui_background",
      subject,
      tools: ["task"],
      effects: ["execute"],
      resources: ["process-task:**", "host-workspace:**"],
      expiresAt,
    });
  }
  if (allowDelegate) {
    leases.push({
      leaseId: "lea_tui_delegate",
      subject,
      tools: ["delegate"],
      effects: ["read"],
      resources: ["delegation:local"],
      expiresAt,
    });
  }
  for (const lease of leases) broker.grant(lease);
}

/**
 * User-typed absolute paths under the Workspace or an authorized mount are rewritten to the
 * logical forms `resolveAccessiblePath` accepts (relative or `mount:<id>/…`).
 */
async function rewriteImagePathOntoAuthorizedRoot(
  requested: string,
  workspaceRoot: string,
  mounts: readonly WorkspaceMount[],
): Promise<string> {
  if (!isAbsolute(requested) || requested.startsWith("mount:")) return requested;
  const absolute = resolve(requested);
  try {
    const workspaceReal = await realpath(workspaceRoot);
    const targetReal = await realpath(absolute).catch(async () => absolute);
    const underWorkspace = relative(workspaceReal, targetReal);
    if (underWorkspace === "" || (!underWorkspace.startsWith("..") && !isAbsolute(underWorkspace))) {
      return underWorkspace.replaceAll("\\", "/") || ".";
    }
  } catch {
    // Fall through to mounts / original path.
  }
  for (const mount of mounts) {
    try {
      const mountReal = await realpath(mount.path);
      const targetReal = await realpath(absolute).catch(async () => absolute);
      const underMount = relative(mountReal, targetReal);
      if (underMount === "" || (!underMount.startsWith("..") && !isAbsolute(underMount))) {
        const suffix = underMount.replaceAll("\\", "/");
        return suffix === "" || suffix === "."
          ? `mount:${mount.id}/`
          : `mount:${mount.id}/${suffix}`;
      }
    } catch {
      // Try the next mount.
    }
  }
  return requested;
}
