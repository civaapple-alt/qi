import type { ActionView, RunView, SessionView, StepView } from "@civaapple/qi-agent/kernel";
import type { SessionEvent } from "@civaapple/qi-protocol";
import type { RuntimeActivity } from "@civaapple/qi-agent/loop";
import { renderQiMark } from "./brand.js";
import { commandHelp, type TuiPanel } from "./commands.js";
import { defaultLocale, t, type Locale } from "./i18n.js";
import { shortenPath, splitKeepRight, truncateToWidth } from "./layout.js";
import { renderMarkdown } from "./markdown.js";
import { formatProviderLabel } from "./provider.js";
import { renderToolCard, shouldExpandByDefault, statusGlyph, type ToolCardModel } from "./tool-renderers.js";

export interface ShellProfileSnapshot {
  readonly default: "direct" | "pwsh" | "cmd" | "bash";
  readonly allowed: readonly ("direct" | "pwsh" | "cmd" | "bash")[];
  readonly directEnabled: boolean;
  readonly available: readonly {
    readonly id: "pwsh" | "cmd" | "bash";
    readonly executable: string;
    readonly version?: string;
    readonly status: "available";
  }[];
  readonly unavailable: readonly {
    readonly id: "direct" | "pwsh" | "cmd" | "bash";
    readonly status: "unavailable" | "disallowed";
    readonly reason: string;
  }[];
}

/** Marker consumed by InteractiveTui to paint a full-width user message bar. */
export const USER_MESSAGE_PREFIX = "⟦user⟧";

export interface TuiLaunchInfo {
  readonly workspaceRoot: string;
  readonly dataRoot: string;
  readonly provider: string;
  readonly model: string;
  readonly accountAlias?: string;
  readonly baseURL?: string;
  readonly wireApi?: string;
  readonly authStatus?: "ready" | "missing" | "expired";
  readonly capabilities: readonly string[];
  readonly configPath?: string;
  readonly projectConfigPath?: string;
  readonly mounts?: readonly { id: string; path: string; mode: "read" }[];
  readonly verification?: { origin: string; path: string; profiles: readonly string[] };
  readonly shell?: ShellProfileSnapshot;
  readonly language?: Locale;
  readonly theme?: import("./theme/colors.js").ThemeName;
  readonly contextWindowTokens: number;
  readonly contextBudgetTokens: number;
  readonly outputReserveTokens: number;
  readonly historyBudgetTokens: number;
  readonly maxSteps: number;
  readonly maxActionsPerStep: number;
  readonly skillRoots?: { workspace: string; user: string };
  /** Optional git branch for the Cursor-style footer. */
  readonly branch?: string;
  readonly version?: string;
  /** Startup Tip when trusted rg/fd are missing from PATH (Node fallback still works). */
  readonly discoveryTip?: string;
}

export type TuiPhase = "Thinking" | "Reading" | "Editing" | "Running" | "Waiting";

export interface PresentedSkill {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly scope: "workspace" | "user";
  readonly shadowedUserRoot?: string;
}

type TodoItemState = "done" | "active" | "pending" | "parked" | "failed";

export interface InspectionEntry {
  readonly id: string;
  readonly command: string;
  readonly panel: TuiPanel;
  readonly sessionSequence: number;
  readonly lines: readonly string[];
  readonly notice?: string;
  collapsed: boolean;
}

export interface StatuslineModel {
  readonly phase: TuiPhase;
  readonly model: string;
  readonly contextPercent?: number;
  readonly filesChanged: number;
  readonly workspace: string;
  readonly branch?: string;
  readonly auth?: string;
  readonly capabilities: string;
  readonly activeTasks: number;
  readonly cancelHint: string;
  readonly mode: string;
}

interface ActionEvents {
  proposed?: Extract<SessionEvent, { type: "action.proposed" }>;
  started?: Extract<SessionEvent, { type: "action.started" }>;
  terminal?: Extract<SessionEvent, {
    type: "action.completed" | "action.failed" | "action.cancelled" | "action.indeterminate";
  }>;
}

interface PlanDocument {
  path: string;
  content: string;
  sequence: number;
}

const DISCOVERY_TOOLS = new Set(["read", "list", "tree", "find", "search", "git"]);

/** Keep this many recent Steps expanded in an active Run; older Steps fold into one summary. */
const ACTIVE_RUN_KEEP_STEPS = 8;

export class TuiPresenter {
  launch: TuiLaunchInfo;
  #events: readonly SessionEvent[] = [];
  #view: SessionView | undefined;
  #actionIndex: ActionIndex = emptyActionIndex();
  #runChatCache = new Map<string, { key: string; lines: string[] }>();
  #stepChatCache = new Map<string, { key: string; lines: string[] }>();
  #panel: TuiPanel = "overview";
  #runId: string | undefined;
  #stepId: string | undefined;
  #actionId: string | undefined;
  #delegationId: string | undefined;
  #notice: string | undefined;
  #noticeKind: "info" | "run" | undefined;
  #noticeExpiresAt: number | undefined;
  #skills: readonly PresentedSkill[] = [];
  #actionActivity = new Map<string, Extract<RuntimeActivity, { type: "action.output" }>>();
  #modelActivity = new Map<string, Extract<RuntimeActivity, { type: "model.text" }>>();
  #taskActivity = new Map<string, Extract<RuntimeActivity, { type: "task.output" }>>();
  #inspections: InspectionEntry[] = [];
  #expanded = new Set<string>();
  #inspectionCounter = 0;
  #width = 120;
  #childViewLookup: ((childSessionId: string) => SessionView | undefined) | undefined;
  #locale: Locale;

  constructor(launch: TuiLaunchInfo) {
    this.launch = launch;
    this.#locale = launch.language ?? defaultLocale();
  }

  locale(): Locale {
    return this.#locale;
  }

  setLocale(locale: Locale): void {
    this.#locale = locale;
    this.launch = { ...this.launch, language: locale };
  }

  /** Refresh auth/provider launch fields after `/login` / logout. */
  patchAuthLaunch(status: {
    readonly provider: string;
    readonly model: string;
    readonly accountAlias?: string;
    readonly wireApi: string;
    readonly authStatus: "ready" | "missing" | "expired";
    readonly baseURL?: string;
    readonly contextWindowTokens?: number;
    readonly contextBudgetTokens?: number;
    readonly outputReserveTokens?: number;
  }): void {
    const { baseURL: _previousBaseURL, accountAlias: _previousAlias, ...rest } = this.launch;
    this.launch = {
      ...rest,
      provider: status.provider,
      model: status.model,
      wireApi: status.wireApi,
      authStatus: status.authStatus,
      ...(status.accountAlias === undefined ? {} : { accountAlias: status.accountAlias }),
      ...(status.baseURL === undefined ? {} : { baseURL: status.baseURL }),
      ...(status.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: status.contextWindowTokens }),
      ...(status.contextBudgetTokens === undefined
        ? {}
        : { contextBudgetTokens: status.contextBudgetTokens }),
      ...(status.outputReserveTokens === undefined
        ? {}
        : { outputReserveTokens: status.outputReserveTokens }),
    };
  }

  /** Optional lookup for depth-1 child Session projections (tokens on Subagent rows). */
  setChildViewLookup(lookup: (childSessionId: string) => SessionView | undefined): void {
    this.#childViewLookup = lookup;
  }

  update(events: readonly SessionEvent[], view: SessionView | undefined): void {
    this.#events = events;
    this.#view = view;
    this.#actionIndex = buildActionIndex(events);
    for (const [actionId] of this.#actionActivity) {
      const action = view && Object.values(view.runs).map((run) => run.actions[actionId]).find(Boolean);
      if (!action || ["completed", "failed", "cancelled", "indeterminate", "denied"].includes(action.status)) {
        this.#actionActivity.delete(actionId);
      }
    }
    for (const [stepId] of this.#modelActivity) {
      const step = view && Object.values(view.runs).map((run) => run.steps[stepId]).find(Boolean);
      if (!step || step.model) this.#modelActivity.delete(stepId);
    }
  }

  applyActivity(activity: RuntimeActivity): void {
    if (activity.type === "action.output") this.#actionActivity.set(activity.actionId, activity);
    else if (activity.type === "model.text") this.#modelActivity.set(activity.stepId, activity);
    else this.#taskActivity.set(activity.taskId, activity);
  }

  /** @deprecated Prefer pushInspection so Session timeline stays visible. */
  setPanel(panel: TuiPanel, notice?: string): void {
    if (panel === "overview") {
      this.#panel = "overview";
      if (notice !== undefined) {
        this.setNotice(notice);
      }
      return;
    }
    this.pushInspection(panel, notice);
  }

  pushInspection(panel: TuiPanel, notice?: string, command?: string): void {
    this.#panel = panel;
    if (notice !== undefined) {
      this.setNotice(notice);
    }
    const body = this.panelBody(panel);
    const id = `insp_${++this.#inspectionCounter}`;
    const label = command ?? panel;
    this.#inspections.push({
      id,
      command: label.startsWith("/") ? label : `/${label}`,
      panel,
      sessionSequence: this.#events.at(-1)?.sequence ?? 0,
      lines: body,
      ...(notice === undefined ? {} : { notice }),
      collapsed: body.length > 24,
    });
  }

  setNotice(notice: string | undefined, kind: "info" | "run" = "info", now = Date.now()): void {
    this.#notice = notice;
    this.#noticeKind = notice === undefined ? undefined : kind;
    this.#noticeExpiresAt = notice !== undefined && kind === "info" ? now + 4_000 : undefined;
  }

  /** Drop a previous Run outcome notice; transient operator notices expire independently. */
  clearRunNotice(): void {
    if (this.#noticeKind !== "run") return;
    this.#notice = undefined;
    this.#noticeKind = undefined;
    this.#noticeExpiresAt = undefined;
  }

  notice(now = Date.now()): string | undefined {
    if (this.#noticeExpiresAt !== undefined && now >= this.#noticeExpiresAt) {
      this.#notice = undefined;
      this.#noticeKind = undefined;
      this.#noticeExpiresAt = undefined;
    }
    return this.#notice;
  }

  noticeExpiresAt(): number | undefined {
    return this.#noticeExpiresAt;
  }

  /** Lightweight Tip for missing rg/fd; shown on welcome and above the composer. */
  discoveryTip(): string | undefined {
    return this.launch.discoveryTip;
  }

  setSkills(skills: readonly PresentedSkill[]): void {
    this.#skills = [...skills];
  }

  inspections(): readonly InspectionEntry[] {
    return this.#inspections;
  }

  toggleExpand(): string {
    if (this.#actionId) {
      const key = `action:${this.#actionId}`;
      if (this.#expanded.has(key)) {
        this.#expanded.delete(key);
        return `Collapsed Action ${short(this.#actionId)}`;
      }
      this.#expanded.add(key);
      return `Expanded Action ${short(this.#actionId)}`;
    }
    const last = this.#inspections.at(-1);
    if (last) {
      last.collapsed = !last.collapsed;
      return last.collapsed ? `Collapsed ${last.command}` : `Expanded ${last.command}`;
    }
    const pasteKey = this.latestPasteKey();
    if (pasteKey) {
      if (this.#expanded.has(pasteKey)) {
        this.#expanded.delete(pasteKey);
        return "Collapsed pasted input";
      }
      this.#expanded.add(pasteKey);
      return "Expanded pasted input";
    }
    const historyKey = this.latestFoldedHistoryKey();
    // Folded history outranks the implicit "last Action" target. An explicitly
    // selected Action already returned above.
    if (historyKey) {
      if (this.#expanded.has(historyKey)) {
        this.#expanded.delete(historyKey);
        return "Collapsed earlier steps";
      }
      this.#expanded.add(historyKey);
      return "Expanded earlier steps";
    }
    const action = this.selectedAction();
    if (action) {
      const key = `action:${action.actionId}`;
      if (this.#expanded.has(key)) {
        this.#expanded.delete(key);
        return `Collapsed Action ${short(action.actionId)}`;
      }
      this.#expanded.add(key);
      return `Expanded Action ${short(action.actionId)}`;
    }
    if (this.#expanded.has("markdown:final")) {
      this.#expanded.delete("markdown:final");
      return "Collapsed Markdown blocks";
    }
    this.#expanded.add("markdown:final");
    return "Expanded Markdown blocks";
  }

  selectRun(target: string): string {
    const ids = this.#view?.runOrder ?? [];
    const selected = selectId(ids, this.selectedRun()?.runId, target);
    if (!selected) return ids.length === 0 ? "No Runs exist in this Session." : `Run not found: ${target}`;
    this.#runId = selected;
    this.#stepId = undefined;
    this.#actionId = undefined;
    this.#delegationId = undefined;
    this.#panel = "overview";
    return `Inspecting Run ${position(ids, selected)} · ${short(selected)}`;
  }

  selectStep(target: string): string {
    const run = this.selectedRun();
    const ids = run?.stepOrder ?? [];
    const selected = selectId(ids, this.selectedStep()?.stepId, target);
    if (!selected) return ids.length === 0 ? "The selected Run has no Steps." : `Step not found: ${target}`;
    this.#stepId = selected;
    this.#actionId = undefined;
    this.#panel = "overview";
    return `Inspecting Step ${position(ids, selected)} · ${short(selected)}`;
  }

  selectAction(target: string): string {
    const run = this.selectedRun();
    const ids = this.actionOrder(run);
    const selected = selectId(ids, this.selectedAction()?.actionId, target);
    if (!selected) return ids.length === 0 ? "The selected Run has no Actions." : `Action not found: ${target}`;
    this.#actionId = selected;
    this.#stepId = run?.actions[selected]?.stepId;
    this.#panel = "overview";
    return `Inspecting Action ${position(ids, selected)} · ${short(selected)}`;
  }

  selectDelegation(target: string): string {
    const run = this.selectedRun();
    const ids = Object.keys(run?.delegations ?? {});
    const selected = selectId(ids, this.#delegationId, target);
    if (!selected) return ids.length === 0 ? "The selected Run has no Subagent delegations." : `Delegation not found: ${target}`;
    this.#delegationId = selected;
    return `Inspecting Subagent ${position(ids, selected)} · ${short(selected)}`;
  }

  /** Panel rows for interactive history pickers (`/runs` hub). */
  historyRunItems(): { id: string; label: string; description: string; current: boolean }[] {
    const view = this.#view;
    if (!view) return [];
    const selected = this.selectedRun()?.runId;
    return view.runOrder.flatMap((id, index) => {
      const run = view.runs[id];
      if (!run) return [];
      return [{
        id,
        label: `${index + 1}. ${short(id)}  ${runDisplayStatus(run)}`,
        description: `${run.stepOrder.length} steps · ${Object.keys(run.actions).length} actions${run.input ? ` · ${oneLine(run.input, 72)}` : ""}`,
        current: id === selected,
      }];
    });
  }

  historyStepItems(): { id: string; label: string; description: string; current: boolean }[] {
    const run = this.selectedRun();
    if (!run) return [];
    const selected = this.selectedStep()?.stepId;
    return run.stepOrder.flatMap((id, index) => {
      const step = run.steps[id];
      if (!step) return [];
      const actions = Object.values(run.actions).filter((action) => action.stepId === id).length;
      const context = step.context
        ? `${formatTokens(step.context.estimatedTokens)}/${formatTokens(step.context.budgetTokens)}`
        : undefined;
      return [{
        id,
        label: `${index + 1}. ${short(id)}  ${step.status}`,
        description: `${step.finishReason ?? "model"} · ${actions} actions${context ? ` · ${context}` : ""}`,
        current: id === selected,
      }];
    });
  }

  historyActionItems(): { id: string; label: string; description: string; current: boolean }[] {
    const run = this.selectedRun();
    if (!run) return [];
    const ids = this.actionOrder(run);
    const selected = this.selectedAction()?.actionId;
    return ids.flatMap((id, index) => {
      const action = run.actions[id];
      if (!action) return [];
      const events = this.actionEventsFor(id);
      return [{
        id,
        label: `${index + 1}. ${statusGlyph(action.status)} ${action.toolName}  ${action.status}`,
        description: summarizeInput(action.toolName, events.proposed?.data.input),
        current: id === selected,
      }];
    });
  }

  historyAgentItems(): { id: string; label: string; description: string; current: boolean }[] {
    const run = this.selectedRun();
    if (!run) return [];
    const ids = Object.keys(run.delegations);
    return ids.flatMap((id, index) => {
      const delegation = run.delegations[id];
      if (!delegation) return [];
      return [{
        id,
        label: `${index + 1}. ${short(id)}  ${delegation.status}`,
        description: `child ${short(delegation.childSessionId)} · ${oneLine(delegation.outcome, 72)}`,
        current: this.#delegationId === id,
      }];
    });
  }

  /** Observational selection — may differ from the executing Run. */
  selectedRun(): RunView | undefined {
    const view = this.#view;
    if (!view) return undefined;
    const id = this.#runId && view.runs[this.#runId]
      ? this.#runId
      : view.currentRunId ?? view.runOrder.at(-1);
    return id ? view.runs[id] : undefined;
  }

  /** Executing Run used for Working / phase; never follows historical selection. */
  activeRun(): RunView | undefined {
    const view = this.#view;
    if (!view?.currentRunId) return undefined;
    const run = view.runs[view.currentRunId];
    if (!run) return undefined;
    if (run.status === "active" || run.status === "triggered") return run;
    return undefined;
  }

  selectedStep(): StepView | undefined {
    const run = this.selectedRun();
    if (!run) return undefined;
    const id = this.#stepId && run.steps[this.#stepId] ? this.#stepId : run.stepOrder.at(-1);
    return id ? run.steps[id] : undefined;
  }

  selectedAction(): ActionView | undefined {
    const run = this.selectedRun();
    if (!run) return undefined;
    if (this.#actionId && run.actions[this.#actionId]) return run.actions[this.#actionId];
    const selectedStepId = this.selectedStep()?.stepId;
    const ids = this.actionOrder(run).filter((id) => !selectedStepId || run.actions[id]?.stepId === selectedStepId);
    const id = ids.at(-1) ?? this.actionOrder(run).at(-1);
    return id ? run.actions[id] : undefined;
  }

  /** Decoded run.failed / run.parked detail for the selected Run. */
  selectedRunFailureDetail(): string | undefined {
    const run = this.selectedRun();
    return run ? runOutcomeDetail(run, this.#events) : undefined;
  }

  /** Short recovery tip when failure is an unadvertised capability-gated tool. */
  selectedRunFailureGuidance(): string | undefined {
    return unadvertisedCapabilityNotice(
      this.selectedRunFailureDetail(),
      this.launch.capabilities,
      this.#locale,
    );
  }

  phase(): TuiPhase {
    const run = this.activeRun();
    if (!run) return "Waiting";
    const action = this.activeAction(run);
    if (action?.status === "running") {
      if (["shell", "script", "verify", "task"].includes(action.toolName)) return "Running";
      if (["write", "edit", "move", "remove"].includes(action.toolName)) return "Editing";
      if (DISCOVERY_TOOLS.has(action.toolName)) return "Reading";
      return "Running";
    }
    const stepId = run.stepOrder.at(-1);
    const step = stepId ? run.steps[stepId] : undefined;
    if (step?.status === "running" && this.#modelActivity.has(step.stepId)) return "Thinking";
    if (step?.status === "running") return "Thinking";
    return "Waiting";
  }

  statusline(activeRun: boolean): StatuslineModel {
    const active = this.activeRun();
    const stepId = active?.stepOrder.at(-1);
    const step = stepId && active ? active.steps[stepId] : this.selectedStep();
    const contextPercent = step?.context
      ? Math.round((step.context.estimatedTokens / step.context.budgetTokens) * 100)
      : undefined;
    const filesChanged = this.#actionIndex.filesChangedByRun.get(active?.runId ?? this.selectedRun()?.runId ?? "") ?? 0;
    const runningTasks = (this.#view?.taskOrder ?? [])
      .map((id) => this.#view?.tasks[id])
      .filter((task) => task?.status === "running" || task?.status === "stopping").length;
    return {
      phase: this.phase(),
      model: `${formatProviderLabel(this.launch.provider, this.launch.accountAlias)}/${this.launch.model}`,
      ...(contextPercent === undefined ? {} : { contextPercent }),
      filesChanged,
      workspace: this.launch.workspaceRoot,
      ...(this.launch.branch === undefined ? {} : { branch: this.launch.branch }),
      ...(this.launch.authStatus === undefined ? {} : { auth: this.launch.authStatus }),
      capabilities: this.launch.capabilities.length ? this.launch.capabilities.join("+") : "read",
      activeTasks: runningTasks,
      cancelHint: activeRun ? "ctrl+c to stop" : "ctrl+c to quit",
      mode: formatMode(this.#view?.mode ?? "agent"),
    };
  }

  formatStatusline(activeRun: boolean, width: number): string[] {
    const model = this.statusline(activeRun);
    const usable = Math.max(20, width);
    const left = [
      model.model,
      model.contextPercent === undefined ? undefined : `${model.contextPercent}%`,
      model.filesChanged > 0 ? `${model.filesChanged} files` : undefined,
      model.activeTasks > 0 ? `tasks ${model.activeTasks}` : undefined,
    ].filter((field): field is string => Boolean(field)).join(" · ");
    // Mode is a safety boundary — always keep it on the right.
    const top = splitKeepRight(left, model.mode, usable);
    const path = model.branch
      ? `${shortenPath(model.workspace)} · ${model.branch}`
      : shortenPath(model.workspace);
    return [top, oneLine(path, usable)];
  }

  /** Live working line shown above the composer while a Run is active. */
  renderWorking(activeRun: boolean, now = Date.now(), width = this.#width): string[] {
    if (!activeRun) return [];
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const frame = frames[Math.floor(now / 80) % frames.length] ?? "·";
    const run = this.activeRun();
    const phase = this.phase();
    const action = this.activeAction(run);
    const stepId = run?.stepOrder.at(-1);
    const step = stepId && run ? run.steps[stepId] : undefined;
    // Main strip = parent agent context only; Subagent tokens live on the Subagents block.
    const tokens = step?.context?.estimatedTokens;
    const tokenPart = tokens === undefined ? undefined : `${formatTokens(tokens)} tokens`;
    const parts = [frame, "Running", phase];
    if (action?.status === "running") {
      if (action.toolName === "delegate") {
        parts.push("waiting on subagent");
      } else if (action.toolName === "shell" || action.toolName === "script" || action.toolName === "verify") {
        const events = this.actionEventsFor(action.actionId);
        const input = record(events.proposed?.data.input);
        const command = action.toolName === "verify"
          ? `verify ${String(input?.profile ?? "?")}`
          : action.toolName === "script"
            ? `script ${String(input?.profile ?? "?")}`
            : `$ ${oneLine(String(input?.command ?? action.toolName), 40)}`;
        parts.push(command);
      } else {
        parts.push(action.toolName);
      }
    }
    if (tokenPart) parts.push(tokenPart);
    const actionActivity = action ? this.#actionActivity.get(action.actionId) : undefined;
    const modelActivity = stepId ? this.#modelActivity.get(stepId) : undefined;
    const activityText = actionActivity?.text || modelActivity?.text;
    const liveTail = activityText
      ?.replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3);
    if (!liveTail || liveTail.length === 0) return [parts.join("  ")];
    const stream = actionActivity?.stream;
    const prefix = stream === "stderr" ? "stderr · " : "";
    return [
      parts.join("  "),
      ...liveTail.map((line) =>
        `  · ${truncateToWidth(`${prefix}${line}`, Math.max(1, width - 4), "…")}`
      ),
    ];
  }

  render(width = 120): string[] {
    this.#width = width;
    const startup = !this.#view || this.#view.runOrder.length === 0;
    const version = this.launch.version ?? "0.5.1";
    const lines: string[] = [];
    if (startup) {
      lines.push(...this.renderWelcome(width), "");
    } else {
      lines.push(`Qi  v${version}`, "");
    }
    lines.push(...this.renderChat());
    // Keep notices near the end of the transcript (line mode) / above the composer (interactive Working strip).
    const notice = this.notice();
    if (notice) lines.push("", `notice  ${notice}`);
    // Line mode still snapshots via setPanel/pushInspection; interactive uses temporary panels.
    const inspection = this.#inspections.at(-1);
    if (inspection) {
      const rule = "─".repeat(Math.max(24, Math.min(this.#width, 72)));
      lines.push("", inspection.command, rule, ...inspection.lines);
    }
    return lines;
  }

  renderWelcome(width = 120): string[] {
    const version = this.launch.version ?? "0.5.1";
    if (width < 40) {
      return [
        "栖 · QI",
        `v${version}`,
        t(this.#locale, "welcome.tip.short"),
        ...(this.launch.discoveryTip ? [this.launch.discoveryTip] : []),
        `Model: ${formatProviderLabel(this.launch.provider, this.launch.accountAlias)}/${this.launch.model}`,
      ];
    }
    const mark = renderQiMark(Math.min(width, 48));
    return [
      ...mark,
      "",
      `  Version:   ${version}`,
      `  Directory: ${this.launch.workspaceRoot}`,
      `  Model:     ${formatProviderLabel(this.launch.provider, this.launch.accountAlias)}/${this.launch.model}`,
      `  Mode:      ${formatMode(this.#view?.mode ?? "agent")}`,
      "",
      t(this.#locale, "welcome.tip.long"),
      ...(this.launch.discoveryTip ? [`  ${this.launch.discoveryTip}`] : []),
    ];
  }

  renderSelectionBar(): string {
    const view = this.#view;
    const run = this.selectedRun();
    const step = this.selectedStep();
    const action = this.selectedAction();
    if (!view || !run) return "session  new · run — · step — · action —";
    const runIndex = view.runOrder.indexOf(run.runId) + 1;
    const stepIndex = step ? run.stepOrder.indexOf(step.stepId) + 1 : 0;
    const actions = this.actionOrder(run);
    const actionIndex = action ? actions.indexOf(action.actionId) + 1 : 0;
    const tasks = (view.taskOrder ?? []).length;
    return [
      `session ${short(view.sessionId)}`,
      `run ${runIndex}/${view.runOrder.length} ${runDisplayStatus(run)}`,
      `step ${stepIndex || "—"}/${run.stepOrder.length || "—"}`,
      `action ${actionIndex || "—"}/${actions.length || "—"}${action ? ` ${action.status}` : ""}`,
      tasks > 0 ? `tasks ${tasks}` : undefined,
    ].filter(Boolean).join(" · ");
  }

  /** Engineering projection for /status; the default surface is renderChat(). */
  renderOverview(): string[] {
    return this.renderStatusDetail();
  }

  renderChat(): string[] {
    const view = this.#view;
    if (!view || view.runOrder.length === 0) return [];
    const maximumRuns = 30;
    const visibleRunIds = view.runOrder.slice(-maximumRuns);
    const lines: string[] = [];
    if (view.runOrder.length > maximumRuns) {
      lines.push(`… ${view.runOrder.length - maximumRuns} earlier Runs · /runs`, "");
    }
    const visible = new Set(visibleRunIds);
    for (const cachedId of this.#runChatCache.keys()) {
      if (!visible.has(cachedId)) this.#runChatCache.delete(cachedId);
    }
    const liveStepIds = new Set<string>();
    for (const runId of visibleRunIds) {
      const run = view.runs[runId];
      if (!run) continue;
      for (const stepId of run.stepOrder) liveStepIds.add(stepId);
    }
    for (const cachedId of this.#stepChatCache.keys()) {
      if (!liveStepIds.has(cachedId)) this.#stepChatCache.delete(cachedId);
    }
    visibleRunIds.forEach((runId, runIndex) => {
      const run = view.runs[runId];
      if (!run) return;
      if (runIndex > 0) lines.push("");
      const isLast = runIndex === visibleRunIds.length - 1;
      const showTodo = isLast && this.shouldShowStreamTodo();
      const showHandoff = isLast && (
        shouldShowHandoff(run, this.#events) ||
        this.#view?.pendingReview?.status === "pending" ||
        this.#view?.pendingQuestion?.status === "pending"
      );
      lines.push(...this.renderRunChat(run, { isLast, showTodo, showHandoff }));
    });
    return lines;
  }

  /** One Run's chat block; settled Runs reuse a fingerprint cache across paints. */
  private renderRunChat(
    run: RunView,
    options: { isLast: boolean; showTodo: boolean; showHandoff: boolean },
  ): string[] {
    const cacheKey = this.runChatCacheKey(run, options);
    if (cacheKey) {
      const hit = this.#runChatCache.get(run.runId);
      if (hit?.key === cacheKey) return hit.lines;
    }
    const lines: string[] = [];
    lines.push(...this.renderUserMessage(run));
    const isActive = run.status === "active" || run.status === "triggered";
    const historyKey = `run:${run.runId}:history`;
    const historyExpanded = this.#expanded.has(historyKey);
    let foldBefore = 0;
    if (isActive && !historyExpanded && run.stepOrder.length > ACTIVE_RUN_KEEP_STEPS) {
      foldBefore = run.stepOrder.length - ACTIVE_RUN_KEEP_STEPS;
      const foldedIds = run.stepOrder.slice(0, foldBefore);
      let actionCount = 0;
      for (const stepId of foldedIds) {
        actionCount += this.actionOrder(run).filter((id) => run.actions[id]?.stepId === stepId).length;
      }
      lines.push("");
      lines.push(`… ${foldedIds.length} earlier steps · ${actionCount} actions · Ctrl+O`);
    }
    for (const [stepIndex, stepId] of run.stepOrder.entries()) {
      if (stepIndex < foldBefore) continue;
      const step = run.steps[stepId];
      if (!step) continue;
      const isFinalStep = stepIndex === run.stepOrder.length - 1;
      const stepLines = this.renderStepTimeline(run, step, { collapse: !isFinalStep });
      if (stepLines.length > 0) {
        lines.push("");
        lines.push(...stepLines);
      }
    }
    const delegationLines = this.renderDelegations(run);
    if (delegationLines.length > 0) {
      lines.push("");
      lines.push(...delegationLines);
    }
    if (options.showTodo) {
      lines.push("");
      lines.push(...this.renderTodoStrip());
    }
    if (options.showHandoff) {
      lines.push(...this.renderHandoff(run));
    }
    if (cacheKey) this.#runChatCache.set(run.runId, { key: cacheKey, lines });
    return lines;
  }

  private runChatCacheKey(
    run: RunView,
    options: { isLast: boolean; showTodo: boolean; showHandoff: boolean },
  ): string | undefined {
    if (run.status === "active" || run.status === "triggered") return undefined;
    for (const action of Object.values(run.actions)) {
      if (this.#actionActivity.has(action.actionId)) return undefined;
    }
    for (const stepId of run.stepOrder) {
      if (this.#modelActivity.has(stepId)) return undefined;
    }
    const expanded = [...this.#expanded]
      .filter((key) => {
        if (key === `paste:${run.runId}`) return true;
        if (key === `run:${run.runId}:history`) return true;
        if (key === "markdown:final") return options.isLast;
        if (key.startsWith("action:")) return Boolean(run.actions[key.slice("action:".length)]);
        if (key.startsWith("step:")) return Boolean(run.steps[key.slice("step:".length)]);
        return false;
      })
      .sort()
      .join(",");
    const actionSig = Object.values(run.actions)
      .map((action) => `${action.actionId}:${action.status}`)
      .sort()
      .join(",");
    const stepSig = run.stepOrder.map((stepId) => {
      const step = run.steps[stepId];
      return `${stepId}:${step?.status ?? ""}:${step?.model?.text?.length ?? 0}:${step?.model?.finishReason ?? ""}`;
    }).join(",");
    const selection = `${this.#runId === run.runId ? this.#actionId ?? "" : ""}`;
    return [
      this.#width,
      options.isLast ? 1 : 0,
      options.showTodo ? 1 : 0,
      options.showHandoff ? 1 : 0,
      run.status,
      run.input?.length ?? 0,
      actionSig,
      stepSig,
      expanded,
      selection,
      Object.keys(run.delegations).join(","),
    ].join("|");
  }

  /** Todo appears in-stream only after Plan accept has started at least one item Run. */
  private shouldShowStreamTodo(): boolean {
    const view = this.#view;
    if (!view?.currentPlanId) return false;
    const plan = view.plans[view.currentPlanId];
    if (!plan?.acceptedRevision) return false;
    const revision = plan.acceptedRevision;
    if (plan.revisions[revision]?.format === "formal_markdown") return false;
    return view.runOrder.some((runId) => {
      const run = view.runs[runId];
      return (
        run?.planBinding?.planId === plan.planId &&
        run.planBinding.revision === revision
      );
    });
  }

  /** Panel body for temporary inspect surfaces (UI-only; not written to Session). */
  renderPanel(panel: TuiPanel): string[] {
    return this.panelBody(panel);
  }

  private activeAction(run: RunView | undefined): ActionView | undefined {
    if (!run) return undefined;
    const ids = this.actionOrder(run);
    const ordered = ids.length > 0 ? ids : Object.keys(run.actions);
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const action = run.actions[ordered[index]!];
      if (action?.status === "running") return action;
    }
    const last = ordered.at(-1);
    return last ? run.actions[last] : undefined;
  }

  renderStatusDetail(): string[] {
    const view = this.#view;
    const lines = [
      "Status",
      `  ${this.renderSelectionBar()}`,
      `  model      ${formatProviderLabel(this.launch.provider, this.launch.accountAlias)}/${this.launch.model}`,
      `  workspace  ${this.launch.workspaceRoot}${this.launch.branch ? ` · ${this.launch.branch}` : ""}`,
      `  capability read${this.launch.capabilities.length ? ` + ${this.launch.capabilities.join(" + ")}` : ""}`,
    ];
    if (!view || view.runOrder.length === 0) {
      lines.push("  No Run yet.");
      return lines;
    }
    const run = this.selectedRun();
    if (!run) return lines;
    lines.push(
      `  run        ${runDisplayStatus(run)} · ${run.stepOrder.length} steps · ${Object.keys(run.actions).length} actions`,
    );
    const step = this.selectedStep();
    if (step?.context) {
      lines.push(`  context    ${formatTokens(step.context.estimatedTokens)}/${formatTokens(step.context.budgetTokens)}`);
    }
    return lines;
  }

  renderConfig(): string[] {
    const shell = this.launch.shell;
    const shellLines = shell === undefined
      ? ["  shell       disabled"]
      : [
          `  shell       default ${shell.default} · allowed ${shell.allowed.length ? shell.allowed.join(", ") : "none"}`,
          ...(shell.directEnabled ? ["              direct available (executable + argv)"] : []),
          ...shell.available.map((profile) =>
            `              ${profile.id} available · ${profile.executable}${profile.version ? ` · ${profile.version}` : ""}`),
          ...shell.unavailable.map((profile) =>
            `              ${profile.id} ${profile.status} · ${profile.reason}`),
        ];
    return [
      "Effective configuration",
      `  model       ${formatProviderLabel(this.launch.provider, this.launch.accountAlias)}/${this.launch.model}`,
      `  base URL    ${this.launch.baseURL ?? "provider default"}`,
      `  wire API    ${this.launch.wireApi ?? "unknown"}`,
      `  auth        ${this.launch.authStatus ?? "unknown"}`,
      `  workspace   ${this.launch.workspaceRoot}`,
      `  data        ${this.launch.dataRoot}`,
      `  config      ${this.launch.configPath ?? "not loaded"}`,
      `  project     ${this.launch.projectConfigPath ?? "default under QI_HOME/projects"}`,
      `  mounts      ${this.launch.mounts?.length
        ? this.launch.mounts.map((mount) => `${mount.id} → ${mount.path}`).join("; ")
        : "none (use /add-dir or --add-dir)"}`,
      `  capability  read${this.launch.capabilities.length ? ` + ${this.launch.capabilities.join(" + ")}` : ""}`,
      `  verify      ${this.launch.verification ? `${this.launch.verification.origin} · ${this.launch.verification.path} · ${this.launch.verification.profiles.join(", ")}` : "disabled"}`,
      ...shellLines,
      `  skills      workspace ${this.launch.skillRoots?.workspace ?? "not configured"}`,
      `              user ${this.launch.skillRoots?.user ?? "not configured"}`,
      `  context     ${formatTokens(this.launch.contextBudgetTokens)} prompt + ${formatTokens(this.launch.outputReserveTokens)} output / ${formatTokens(this.launch.contextWindowTokens)} window`,
      "  secrets     sealed store + env; never loaded from config.toml",
    ];
  }

  renderContext(): string[] {
    const run = this.selectedRun();
    const step = this.selectedStep();
    const context = step?.context;
    const lines = ["Context"];
    if (!run || !step) {
      lines.push("  No compiled Step context is selected.");
      return lines;
    }
    if (!context) {
      lines.push(
        `  Step        ${position(run.stepOrder, step.stepId)} · ${short(step.stepId)}`,
        `  compaction  ${step.compactions?.length ? `${step.compactions.length} settled exchange(s), ${formatTokens(step.compactions.reduce((sum, item) => sum + item.originalEstimatedTokens - item.compactedEstimatedTokens, 0))} reclaimed` : "not available"}`,
        "  boundary    context did not compile; inspect the Run parking or failure detail",
      );
      return lines;
    }
    const ratio = context.estimatedTokens / context.budgetTokens;
    lines.push(
      `  Step        ${position(run.stepOrder, step.stepId)} · ${short(step.stepId)}`,
      `  usage       ${formatTokens(context.estimatedTokens)} / ${formatTokens(context.budgetTokens)} · ${Math.round(ratio * 100)}% ${progressBar(ratio, 20)}`,
      `  included    ${context.includedBlockIds.length} blocks`,
      `  omitted     ${context.omittedBlockIds.length ? context.omittedBlockIds.join(", ") : "none"}`,
      `  history     newest completed turns, capped at ${formatTokens(this.launch.historyBudgetTokens)} per new Run`,
      `  compaction  ${step.compactions?.length ? `${step.compactions.length} settled exchange(s), ${formatTokens(step.compactions.reduce((sum, item) => sum + item.originalEstimatedTokens - item.compactedEstimatedTokens, 0))} reclaimed` : context.omittedBlockIds.some((id) => id.startsWith("history:")) ? "older Session turns were omitted" : "not triggered for this Step"}`,
      `  boundary    safe between Steps; parks if required context still exceeds ${formatTokens(context.budgetTokens)}`,
    );
    return lines;
  }

  renderRuns(): string[] {
    const view = this.#view;
    const lines = ["Runs  (select in /runs)"];
    if (!view || view.runOrder.length === 0) return [...lines, "  No Runs."];
    const selected = this.selectedRun()?.runId;
    view.runOrder.forEach((id, index) => {
      const run = view.runs[id];
      if (!run) return;
      lines.push(`  ${id === selected ? "›" : " "} ${index + 1}. ${short(id)}  ${runDisplayStatus(run).padEnd(9)}  ${run.stepOrder.length} steps · ${Object.keys(run.actions).length} actions${run.input ? ` · ${oneLine(run.input, 80)}` : ""}`);
    });
    return lines;
  }

  renderSteps(): string[] {
    const run = this.selectedRun();
    const lines = ["Steps  (select in /runs → Steps)"];
    if (!run || run.stepOrder.length === 0) return [...lines, "  No Steps."];
    const selected = this.selectedStep()?.stepId;
    run.stepOrder.forEach((id, index) => {
      const step = run.steps[id];
      if (!step) return;
      const context = step.context ? ` · ${formatTokens(step.context.estimatedTokens)}/${formatTokens(step.context.budgetTokens)}` : "";
      const actions = Object.values(run.actions).filter((action) => action.stepId === id).length;
      lines.push(`  ${id === selected ? "›" : " "} ${index + 1}. ${short(id)}  ${step.status.padEnd(9)} · ${step.finishReason ?? "model"} · ${actions} actions${context}`);
    });
    return lines;
  }

  renderActions(): string[] {
    const run = this.selectedRun();
    const lines = ["Actions  (select in /runs → Actions)"];
    if (!run) return [...lines, "  No selected Run."];
    const ids = this.actionOrder(run);
    if (ids.length === 0) return [...lines, "  No Actions."];
    const selected = this.selectedAction()?.actionId;
    ids.forEach((id, index) => {
      const action = run.actions[id];
      if (!action) return;
      const events = this.actionEventsFor(id);
      lines.push(`  ${id === selected ? "›" : " "} ${index + 1}. ${statusGlyph(action.status)} ${action.toolName.padEnd(9)} ${action.status.padEnd(18)} ${summarizeInput(action.toolName, events.proposed?.data.input)}`.trimEnd());
    });
    return lines;
  }

  renderAgents(): string[] {
    const run = this.selectedRun();
    const lines = ["Subagents  (select in /runs → Agents)", "  depth-1 only · child transcript stays in its Session"];
    if (!run) return [...lines, "  No selected Run."];
    const ids = Object.keys(run.delegations);
    if (ids.length === 0) return [...lines, "  No delegations in this Run."];
    ids.forEach((id, index) => {
      const delegation = run.delegations[id];
      if (!delegation) return;
      const selected = this.#delegationId === id ? "›" : " ";
      lines.push(
        `  ${selected} ${index + 1}. ${short(id)} · ${delegation.status} · child ${short(delegation.childSessionId)}`,
        `     ${oneLine(delegation.outcome, 100)}`,
      );
      if (delegation.summaryRef) lines.push(`     summary ${delegation.summaryRef}`);
      if (delegation.reasons?.length) lines.push(`     ${delegation.reasons.join(" · ")}`);
      if (delegation.coordinationWallTimeMs !== undefined) {
        lines.push(`     wall ${formatDuration(delegation.coordinationWallTimeMs)}`);
      }
    });
    return lines;
  }

  renderSkills(): string[] {
    const lines = ["Skills  (/skill install [--workspace] <name-or-path>)"];
    if (this.#skills.length === 0) return [...lines, "  No installed Skills were discovered."];
    for (const skill of this.#skills) {
      lines.push(
        `  ${skill.name}  ${skill.version} · ${skill.scope}${skill.shadowedUserRoot ? " · shadows user Skill" : ""}`,
        `    ${oneLine(skill.description, 120)}`,
      );
    }
    return lines;
  }

  renderTasks(): string[] {
    const view = this.#view;
    const tasks = (view?.taskOrder ?? []).map((taskId) => view?.tasks[taskId]).filter(Boolean);
    const lines = [`ProcessTasks ${tasks.length}`];
    if (tasks.length === 0) return [...lines, "  No background tasks. They require the background capability and the task tool."];
    tasks.forEach((task, index) => {
      if (!task) return;
      const activity = this.#taskActivity.get(task.taskId);
      const command = [task.command, ...task.args].join(" ");
      lines.push(
        `  ${index + 1}. ${task.status === "running" ? "●" : task.status === "stopping" ? "◐" : "○"} ${short(task.taskId)} · ${task.status} · pid ${task.pid}`,
        `     ${oneLine(command, 110)}`,
        `     cwd ${task.workdir} · expires ${task.expiresAt}${task.terminalReason ? ` · ${task.terminalReason}` : ""}`,
      );
      if (activity?.text) {
        lines.push(`     ${activity.stream} · live${activity.truncated ? " · truncated" : ""}`);
        lines.push(...boundedTailLines(activity.text, 4).map((line) => `       ${line}`));
      }
      if (task.status === "running") lines.push(`     /tasks → Enter · /tasks stop ${task.taskId}`);
    });
    return lines;
  }

  renderDiff(): string[] {
    const run = this.selectedRun();
    const selected = this.selectedAction();
    const candidates = run
      ? this.actionOrder(run).map((id) => run.actions[id]).filter((action): action is ActionView => Boolean(action))
      : [];
    const action = selected && this.actionDiffFor(selected.actionId)
      ? selected
      : [...candidates].reverse().find((candidate) => this.actionDiffFor(candidate.actionId));
    if (!action) return ["Diff", "  No completed file or shell-observed Git diff exists in the selected Run."];
    const diff = this.actionDiffFor(action.actionId) ?? "";
    const all = diff.replace(/\r/g, "").split("\n");
    const limit = this.#expanded.has(`action:${action.actionId}`) ? 200 : 80;
    const hidden = Math.max(0, all.length - limit);
    return [
      `Diff  ${action.toolName} · ${short(action.actionId)}`,
      ...all.slice(0, limit).map((line) => `  ${line}`),
      ...(hidden > 0 ? [`  … ${hidden} lines hidden · Ctrl+O to expand`] : []),
    ];
  }

  renderPlan(): string[] {
    const view = this.#view;
    const planId = view?.currentPlanId;
    const plan = planId ? view?.plans[planId] : undefined;
    const revision = plan ? plan.revisions[plan.latestRevision] : undefined;
    if (!plan || !revision) {
      return [
        "Plan",
        "  No durable Plan revision is recorded yet.",
        "  Switch to Plan mode (/mode plan) and use plan_document after exploration.",
      ];
    }
    const review = view?.pendingReview;
    const lines = [
      `Plan  ${short(plan.planId)} · revision ${revision.revision}` +
        (plan.acceptedRevision === undefined ? "" : ` · accepted ${plan.acceptedRevision}`),
      `  ${oneLine(revision.title, 100)}`,
      `  ${oneLine(revision.overview, 120)}`,
      `  path ${revision.path}`,
    ];
    if (revision.format === "formal_markdown" && revision.markdown) {
      lines.push("", ...revision.markdown.split(/\r?\n/).slice(0, 400));
    } else {
      lines.push(
        "",
        "Items",
        ...revision.items.map((item, index) => `  ${index + 1}. ${item.title} · ${short(item.planItemId)}`),
      );
    }
    const delegationStats = revision.sourceRunId
      ? summarizeDelegations(view?.runs[revision.sourceRunId])
      : undefined;
    if (delegationStats) {
      lines.push(
        "",
        `Subagents  accepted ${delegationStats.accepted} · failed ${delegationStats.failed}` +
          (delegationStats.other > 0 ? ` · other ${delegationStats.other}` : ""),
      );
    }
    if (review?.status === "pending" && review.planId === plan.planId && review.revision === revision.revision) {
      lines.push(
        "",
        "Plan Review pending",
        "  1 /plan accept — 开始实现：switch to Agent and start the first item Run",
        "  2 /plan revise [feedback] — 修改计划并更新 plan_document",
        "  3 /plan reject [feedback] — dismiss, or revise when feedback is provided",
      );
    }
    return lines;
  }

  renderActionDetail(action: ActionView): string[] {
    return [
      `Action  ${short(action.actionId)} · ${action.resources.join(", ") || "no resources"}`,
      ...renderToolCard(this.toolCard(action), { expanded: true, outputLines: 10 }).map((line) => `  ${line}`),
    ];
  }

  private panelBody(panel: TuiPanel): string[] {
    switch (panel) {
      case "config": return this.renderConfig();
      case "context": return this.renderContext();
      case "runs": return this.renderRuns();
      case "steps": return this.renderSteps();
      case "actions": return this.renderActions();
      case "agents": return this.renderAgents();
      case "skills": return this.renderSkills();
      case "tasks": return this.renderTasks();
      case "diff": return this.renderDiff();
      case "plan": return this.renderPlan();
      case "providers": return this.renderProviders();
      case "coord": return this.renderCoord();
      case "work": return this.renderWork();
      case "gate": return this.renderGate();
      case "extensions": return this.renderExtensions();
      case "help": return commandHelp(undefined, this.#locale);
      case "overview": return this.renderStatusDetail();
    }
  }

  private renderUserMessage(run: RunView): string[] {
    const input = run.input?.trim() ?? "";
    if (!input) return [`${USER_MESSAGE_PREFIX}(no input recorded)`];
    const key = `paste:${run.runId}`;
    const rawLines = input.split(/\r?\n/);
    const isLongPaste = rawLines.length > 4 || input.length > 400;
    if (isLongPaste && !this.#expanded.has(key)) {
      return [
        `${USER_MESSAGE_PREFIX}[Pasted text · ${rawLines.length} lines · ${input.length} chars]`,
        `${USER_MESSAGE_PREFIX}${oneLine(rawLines[0] ?? "", 120)}`,
        ...(rawLines.length > 1 ? [`${USER_MESSAGE_PREFIX}…`, `${USER_MESSAGE_PREFIX}${oneLine(rawLines.at(-1) ?? "", 120)}`] : []),
        `${USER_MESSAGE_PREFIX}Ctrl+O to expand`,
      ];
    }
    return rawLines.map((line) => `${USER_MESSAGE_PREFIX}${line}`);
  }

  /**
   * Chronological Step projection: narration / live model text before tools when the model
   * requested Actions; final stop text after any Actions on that Step.
   */
  private renderStepTimeline(
    run: RunView,
    step: StepView,
    options: { collapse?: boolean } = {},
  ): string[] {
    const cacheKey = this.stepChatCacheKey(run, step, options);
    if (cacheKey) {
      const hit = this.#stepChatCache.get(step.stepId);
      if (hit?.key === cacheKey) return hit.lines;
    }
    const stepActions = this.actionOrder(run).filter((id) => run.actions[id]?.stepId === step.stepId);
    const actionLines = this.renderStepActions(run, stepActions, options);
    const agentLines = this.renderAgentText(step, run, options);
    const narrationFirst = step.model?.finishReason === "actions"
      || (step.status === "running" && Boolean(this.#modelActivity.get(step.stepId)?.text))
      || (Boolean(step.model?.text?.trim()) && stepActions.length > 0 && step.model?.finishReason !== "stop");
    const lines: string[] = [];
    const pushBlock = (block: readonly string[]): void => {
      if (block.length === 0) return;
      if (lines.length > 0) lines.push("");
      lines.push(...block);
    };
    if (narrationFirst) {
      pushBlock(agentLines);
      pushBlock(actionLines);
    } else {
      pushBlock(actionLines);
      pushBlock(agentLines);
    }
    if (cacheKey) this.#stepChatCache.set(step.stepId, { key: cacheKey, lines });
    return lines;
  }

  private stepChatCacheKey(
    run: RunView,
    step: StepView,
    options: { collapse?: boolean },
  ): string | undefined {
    if (step.status === "running") return undefined;
    if (this.#modelActivity.has(step.stepId)) return undefined;
    const stepActions = this.actionOrder(run).filter((id) => run.actions[id]?.stepId === step.stepId);
    for (const actionId of stepActions) {
      const action = run.actions[actionId];
      if (!action) continue;
      if (
        action.status === "running"
        || action.status === "proposed"
        || action.status === "awaiting-authority"
        || action.status === "granted"
      ) {
        return undefined;
      }
      if (this.#actionActivity.has(actionId)) return undefined;
    }
    const expanded = [...this.#expanded]
      .filter((key) => {
        if (key === `step:${step.stepId}`) return true;
        if (key === "markdown:final") return run.stepOrder.at(-1) === step.stepId;
        if (key.startsWith("action:")) {
          const actionId = key.slice("action:".length);
          return stepActions.includes(actionId);
        }
        return false;
      })
      .sort()
      .join(",");
    const actionSig = stepActions
      .map((actionId) => {
        const action = run.actions[actionId];
        return `${actionId}:${action?.status ?? ""}`;
      })
      .join(",");
    const selectedAction = this.#actionId && stepActions.includes(this.#actionId)
      ? this.#actionId
      : "";
    return [
      this.#width,
      options.collapse ? 1 : 0,
      step.status,
      step.model?.text?.length ?? 0,
      step.model?.finishReason ?? "",
      actionSig,
      expanded,
      selectedAction,
    ].join("|");
  }

  private renderStepActions(
    run: RunView,
    actionIds: readonly string[],
    options: { collapse?: boolean } = {},
  ): string[] {
    const lines: string[] = [];
    const activeRun = run.status === "active" || run.status === "triggered";
    for (const actionId of actionIds) {
      const action = run.actions[actionId];
      if (!action) continue;
      const card = this.toolCard(action);
      const stepExpanded = this.#expanded.has(`step:${action.stepId}`);
      // One-line summaries only mid-Run; settled Runs keep full Cursor cards (already fingerprint-cached).
      const retainedMutationDiff = action.status === "completed"
        && ["write", "edit", "move", "remove"].includes(action.toolName)
        && typeof card.output?.diff === "string"
        && card.output.diff.length > 0;
      if (activeRun && options.collapse && !stepExpanded && !retainedMutationDiff) {
        lines.push(...renderToolCard(card, { summaryOnly: true }));
        continue;
      }
      // Show each Action as its own card; do not collapse discovery into an explore summary.
      const expanded = this.#expanded.has(`action:${actionId}`)
        || this.#actionId === actionId
        || shouldExpandByDefault(action.status);
      const rendered = renderToolCard(card, { expanded, outputLines: expanded ? 12 : 4 });
      lines.push(...rendered);
    }
    return lines;
  }

  private renderAgentText(
    step: StepView,
    run: RunView,
    options: { collapse?: boolean } = {},
  ): string[] {
    const final = step.model?.text;
    if (final) {
      if (options.collapse && !this.#expanded.has(`step:${step.stepId}`)) {
        return [`· ${oneLine(final, 100)}`];
      }
      if (isPlainShortText(final)) return [final.trim()];
      const isTerminalStep = run.stepOrder.at(-1) === step.stepId && run.status !== "active" && run.status !== "triggered";
      return renderMarkdown(final, {
        width: Math.max(40, this.#width - 2),
        expandCodeBlocks: this.#expanded.has("markdown:final") || this.#expanded.has(`step:${step.stepId}`),
        maxCodeLines: isTerminalStep ? 40 : 16,
      });
    }
    const liveModel = this.#modelActivity.get(step.stepId);
    if (!liveModel?.text) return [];
    if (options.collapse) return [`· ${oneLine(liveModel.text, 100)}`];
    if (isPlainShortText(liveModel.text)) return [liveModel.text.trim()];
    return boundedTailLines(liveModel.text, 8);
  }

  private renderDelegations(run: RunView): string[] {
    const ids = Object.keys(run.delegations);
    if (ids.length === 0) return [];
    const running = ids.filter((id) => run.delegations[id]?.status === "running").length;
    const finished = ids.length - running;
    const header = running > 0
      ? `Subagents · ${running} running${finished > 0 ? ` · ${finished} finished` : ""} · /agents`
      : `Subagents · ${ids.length} finished · /agents`;
    const lines = [header];
    for (const id of ids) {
      const delegation = run.delegations[id];
      if (!delegation) continue;
      const label = delegation.status === "running" ? "Running" : delegation.status === "accepted" ? "Finished" : delegation.status;
      const title = oneLine(delegation.outcome || short(id), 72);
      const childTokens = this.childSessionTokens(delegation.childSessionId);
      const tokenPart = childTokens === undefined ? undefined : `${formatTokens(childTokens)} tokens`;
      lines.push(`  ${delegationGlyph(delegation.status)} ${title}`);
      lines.push(
        `    ${[label, tokenPart, delegation.summaryRef].filter(Boolean).join(" · ")}`,
      );
      if (delegation.reasons?.length) lines.push(`    ${delegation.reasons.join(" · ")}`);
    }
    return lines;
  }

  private childSessionTokens(childSessionId: string): number | undefined {
    const child = this.#childViewLookup?.(childSessionId);
    if (!child?.currentRunId) return undefined;
    const childRun = child.runs[child.currentRunId];
    if (!childRun) return undefined;
    const stepId = childRun.stepOrder.at(-1);
    const step = stepId ? childRun.steps[stepId] : undefined;
    return step?.context?.estimatedTokens;
  }

  private renderTodoStrip(): string[] {
    const durable = this.durablePlanProgress();
    if (!durable) return [];
    const allDone = durable.done === durable.total && durable.parked === 0 && durable.failed === 0;
    const working = durable.items.some((item) => item.state === "active");
    const header = allDone
      ? "Todo  All done"
      : working
        ? `Todo  Working on ${durable.total} · ${durable.done}/${durable.total} complete`
        : `Todo  ${durable.done}/${durable.total} complete`;
    const meta = [
      durable.parked > 0 ? `${durable.parked} parked` : undefined,
      durable.failed > 0 ? `${durable.failed} failed` : undefined,
    ].filter(Boolean).join(" · ");
    const lines = [meta ? `${header} · ${meta}` : header];
    const maxVisible = 8;
    const visible = durable.items.slice(0, maxVisible);
    for (const item of visible) {
      lines.push(`  ${todoGlyph(item.state)} ${oneLine(item.title, 100)}`);
    }
    if (durable.items.length > maxVisible) {
      lines.push(`  … +${durable.items.length - maxVisible} more · /plan`);
    }
    return lines;
  }

  private durablePlanProgress(): {
    done: number;
    total: number;
    parked: number;
    failed: number;
    current?: string;
    remaining: string[];
    items: Array<{ title: string; state: TodoItemState }>;
  } | undefined {
    const view = this.#view;
    if (!view?.currentPlanId) return undefined;
    const plan = view.plans[view.currentPlanId];
    if (!plan?.acceptedRevision) return undefined;
    const revision = plan.revisions[plan.acceptedRevision];
    if (!revision || revision.format === "formal_markdown") return undefined;
    const remaining: string[] = [];
    const items: Array<{ title: string; state: TodoItemState }> = [];
    let done = 0;
    let parked = 0;
    let failed = 0;
    for (const item of revision.items) {
      const boundRun = view.runOrder
        .map((runId) => view.runs[runId])
        .find((run) =>
          run?.planBinding?.planId === plan.planId &&
          run.planBinding.revision === revision.revision &&
          run.planBinding.planItemId === item.planItemId,
        );
      let state: TodoItemState = "pending";
      if (boundRun?.status === "completed") {
        state = "done";
        done += 1;
      } else if (boundRun?.status === "parked") {
        state = "parked";
        parked += 1;
        remaining.push(`${item.title} (parked)`);
      } else if (boundRun?.status === "failed" || boundRun?.status === "cancelled") {
        state = "failed";
        failed += 1;
        remaining.push(`${item.title} (${boundRun.status})`);
      } else if (boundRun && (boundRun.status === "active" || boundRun.status === "triggered")) {
        state = "active";
        remaining.push(item.title);
      } else {
        remaining.push(item.title);
      }
      items.push({ title: item.title, state });
    }
    return {
      done,
      total: revision.items.length,
      parked,
      failed,
      ...(remaining[0] === undefined ? {} : { current: remaining[0] }),
      remaining,
      items,
    };
  }

  private renderHandoff(run: RunView): string[] {
    const locale = this.#locale;
    const question = this.#view?.pendingQuestion;
    if (this.#view?.pendingReview?.status === "pending") {
      // Interactive TUI opens a ↑↓ / Enter Plan Review panel; keep transcript quiet.
      return [
        "",
        "Plan Review pending",
        "  ↑↓ / Enter in the review panel · Esc to discuss · say 开始实现 to execute",
        "  1 开始实现 · 2 修改计划 · 3 拒绝 · /plan",
      ];
    }
    if (question?.status === "pending" && question.kind === "next_run") {
      // Interactive TUI opens a ↑↓ / Enter Next Run panel; keep transcript quiet.
      return [
        "",
        "Next Run pending",
        `  ${oneLine(question.prompt, 100)}`,
        "  ↑↓ / Enter in the choice panel · Esc to chat · /next · 继续 / 停 / 回到 Plan",
        "  stop 后可用 /next 再开；回到 Plan 后改计划 → 审阅 → 开始实现",
      ];
    }
    const lastStepId = run.stepOrder.at(-1);
    const lastStep = lastStepId ? run.steps[lastStepId] : undefined;
    const text = lastStep?.model?.text?.trim() ?? "";
    const progress = this.durablePlanProgress();
    const remaining = progress?.remaining ?? [];
    const failure = runOutcomeDetail(run, this.#events);
    const statusKey = handoffStatusKey(run);
    const summary = text
      ? t(locale, "handoff.withReply", { result: oneLine(text.split(/\n\n/)[0] ?? text, 160) })
      : lastStep?.finishReason === "handoff"
        ? t(locale, "handoff.deterministic", {
          steps: String(run.stepOrder.length),
          actions: String(Object.keys(run.actions).length),
        })
        : t(locale, "handoff.noReply");
    const lines = [
      "",
      `· ${summary}`,
      `  ${t(locale, "handoff.status", { status: t(locale, statusKey) })}`,
    ];
    if (failure) {
      lines.push(`  ${t(locale, "handoff.reason", { reason: oneLine(failure, 160) })}`);
    }
    if (remaining.length > 0) {
      lines.push(
        `  ${t(locale, "handoff.remaining", { items: remaining.slice(0, 3).join(" · ") })}`,
      );
    }
    const capabilityNext = unadvertisedCapabilityNext(failure, this.launch.capabilities, locale);
    const budgetNext = run.status === "parked" && run.terminal?.reason === "budget"
      ? t(locale, "handoff.next.budget")
      : undefined;
    lines.push(`  ${capabilityNext ?? budgetNext ?? t(locale, "handoff.next")}`);
    return lines;
  }

  renderProviders(): string[] {
    const label = formatProviderLabel(this.launch.provider, this.launch.accountAlias);
    const lines = [
      "Providers",
      `  profile     ${label}`,
    ];
    if (this.launch.provider === "compatible" && label !== this.launch.provider) {
      lines.push(`  wire id     compatible · OpenAI Chat Completions`);
    } else {
      lines.push(`  provider    ${this.launch.provider}`);
    }
    if (this.launch.accountAlias && this.launch.accountAlias !== "default") {
      lines.push(`  name        ${this.launch.accountAlias}`);
    }
    lines.push(
      `  model       ${this.launch.model}`,
      `  wire API    ${this.launch.wireApi ?? "unknown"}`,
      `  base URL    ${this.launch.baseURL ?? "provider default"}`,
      `  auth        ${this.launch.authStatus ?? "unknown"}`,
      "  secrets     sealed store + env; never loaded from config.toml",
      "  routing     /route why requires P3 provider routing backend",
    );
    return lines;
  }

  renderCoord(): string[] {
    return [
      "Coordination",
      "  Fan-out aggregation is not available in this runtime build.",
      "  No simulated settled/running/failed members are shown (ADR 0010 / P2a).",
      "  Depth-1 Subagents remain visible under /agents.",
    ];
  }

  renderWork(): string[] {
    return [
      "Worktree DAG",
      "  Durable branch/merge DAG projection is not available in this runtime build.",
      "  No simulated blocked/ready/conflicted nodes are shown (ADR 0010 / P2b).",
    ];
  }

  renderGate(): string[] {
    return [
      "Baseline gate",
      "  Paired single-vs-multi gate metrics are not available in this runtime build.",
      "  No simulated success rates or fingerprints are shown (ADR 0010 / P2a).",
    ];
  }

  renderExtensions(): string[] {
    return [
      "Extensions",
      "  MCP binding review and extension quarantine UI require the P3 surface.",
      "  Installed Skills remain visible under /skills; capability grants under /config.",
      "  Remote metadata never grants authority.",
    ];
  }

  private latestPasteKey(): string | undefined {
    const run = this.selectedRun();
    if (!run?.input) return undefined;
    const lines = run.input.split(/\r?\n/);
    if (lines.length > 4 || run.input.length > 400) return `paste:${run.runId}`;
    return undefined;
  }

  /** Ctrl+O target when an active Run has folded older Steps into a summary line. */
  private latestFoldedHistoryKey(): string | undefined {
    const run = this.activeRun() ?? this.selectedRun();
    if (!run) return undefined;
    if (run.status !== "active" && run.status !== "triggered") return undefined;
    if (run.stepOrder.length <= ACTIVE_RUN_KEEP_STEPS) return undefined;
    return `run:${run.runId}:history`;
  }

  private toolCard(action: ActionView): ToolCardModel {
    const events = this.actionEventsFor(action.actionId);
    const output = structuredOutput(events.terminal);
    const duration = elapsed(events.started?.occurredAt, events.terminal?.occurredAt);
    const activity = this.#actionActivity.get(action.actionId);
    const activityLines = activity ? normalizedLineCount(activity.text) : 0;
    return {
      actionId: action.actionId,
      toolName: action.toolName,
      status: action.status,
      ...(events.proposed?.data.input === undefined ? {} : { input: events.proposed.data.input }),
      ...(output === undefined ? {} : { output }),
      ...(events.terminal?.type === "action.failed" ? { errorCode: events.terminal.data.errorCode } : {}),
      ...(duration === undefined ? {} : { elapsed: duration }),
      resources: action.resources,
      ...(activity === undefined ? {} : {
        liveTail: {
          stream: activity.stream,
          text: activity.text,
          droppedLines: Math.max(0, activityLines - 6),
        },
      }),
    };
  }

  private actionOrder(run: RunView | undefined): string[] {
    if (!run) return [];
    return (this.#actionIndex.orderByRun.get(run.runId) ?? []).filter((id) => Boolean(run.actions[id]));
  }

  private actionEventsFor(actionId: string): ActionEvents {
    return this.#actionIndex.byId.get(actionId) ?? {};
  }

  private actionDiffFor(actionId: string): string | undefined {
    const output = structuredOutput(this.actionEventsFor(actionId).terminal);
    if (typeof output?.diff === "string") return output.diff;
    const process = processOutput(output);
    const change = record(process?.workspaceChange);
    return typeof change?.diff === "string" && change.diff ? change.diff : undefined;
  }

}

interface ActionIndex {
  readonly byId: ReadonlyMap<string, ActionEvents>;
  readonly orderByRun: ReadonlyMap<string, readonly string[]>;
  readonly filesChangedByRun: ReadonlyMap<string, number>;
}

function emptyActionIndex(): ActionIndex {
  return {
    byId: new Map(),
    orderByRun: new Map(),
    filesChangedByRun: new Map(),
  };
}

/** Single pass over the Session event stream for Action cards and chat renders. */
function buildActionIndex(events: readonly SessionEvent[]): ActionIndex {
  const byId = new Map<string, ActionEvents>();
  const orderByRun = new Map<string, string[]>();
  const filesByRun = new Map<string, Set<string>>();

  for (const event of events) {
    if (event.type === "action.proposed") {
      const actionId = event.data.actionId;
      const runId = event.data.runId;
      const entry = byId.get(actionId) ?? {};
      entry.proposed = event;
      byId.set(actionId, entry);
      const order = orderByRun.get(runId) ?? [];
      order.push(actionId);
      orderByRun.set(runId, order);
      if (["write", "edit", "move", "remove"].includes(event.data.toolName)) {
        const input = record(event.data.input);
        const path = typeof input?.path === "string"
          ? input.path
          : typeof input?.from === "string"
            ? input.from
            : undefined;
        if (path) {
          const set = filesByRun.get(runId) ?? new Set();
          set.add(path);
          filesByRun.set(runId, set);
        }
      }
      continue;
    }
    if (!("actionId" in event.data)) continue;
    const actionId = event.data.actionId;
    if (typeof actionId !== "string") continue;
    const entry = byId.get(actionId) ?? {};
    if (event.type === "action.started") entry.started = event;
    else if (
      event.type === "action.completed" ||
      event.type === "action.failed" ||
      event.type === "action.cancelled" ||
      event.type === "action.indeterminate"
    ) {
      entry.terminal = event;
    } else {
      continue;
    }
    byId.set(actionId, entry);
  }

  const filesChangedByRun = new Map<string, number>();
  for (const [runId, paths] of filesByRun) filesChangedByRun.set(runId, paths.size);
  return { byId, orderByRun, filesChangedByRun };
}

function structuredOutput(event: ActionEvents["terminal"]): Record<string, unknown> | undefined {
  if (!event || (event.type !== "action.completed" && event.type !== "action.failed")) return undefined;
  const parts = event.data.modelOutput;
  if (!parts) return undefined;
  for (const part of parts) {
    if (typeof part !== "object" || part === null || !("text" in part) || typeof part.text !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(part.text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Human rendering falls back to the durable terminal status.
    }
  }
  return undefined;
}

function processOutput(output: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!output) return undefined;
  if ("exitCode" in output) return output;
  const details = record(output.details);
  return details && "exitCode" in details ? details : undefined;
}

function isChatOnlyRun(run: RunView): boolean {
  return Object.keys(run.actions).length === 0 && Object.keys(run.delegations).length === 0;
}

function shouldShowHandoff(run: RunView, _events: readonly SessionEvent[]): boolean {
  if (run.status === "active" || run.status === "triggered") return false;
  // Quiet success path: final Agent reply + tool cards are enough. Keep Handoff for
  // exceptional outcomes, evidence-backed verification, or Plan-bound work needing next-Run.
  if (run.status === "failed" || run.status === "parked" || run.status === "cancelled") return true;
  if (run.terminal?.reason === "verified") return true;
  return run.planBinding !== undefined;
}

function handoffStatusKey(
  run: RunView,
): "handoff.status.failed" | "handoff.status.parked" | "handoff.status.cancelled" | "handoff.status.verified" | "handoff.status.responded" | "handoff.status.completed" {
  if (run.status === "failed") return "handoff.status.failed";
  if (run.status === "parked") return "handoff.status.parked";
  if (run.status === "cancelled") return "handoff.status.cancelled";
  if (run.terminal?.reason === "verified") return "handoff.status.verified";
  if (run.terminal?.reason === "response") return "handoff.status.responded";
  return "handoff.status.completed";
}

function isPlainShortText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 200) return false;
  if (trimmed.includes("\n")) return false;
  return !/^#{1,6}\s|```|^\s*[-*+](?:\s+\[[ xX]\])?\s|^\s*\d+\.\s|^\|/.test(trimmed);
}

function runDisplayStatus(run: RunView): string {
  if (run.status !== "completed") return run.status;
  if (run.terminal?.reason === "response") return "responded";
  if (run.terminal?.reason === "verified") return "verified";
  return run.status;
}

function runOutcomeDetail(run: RunView, events: readonly SessionEvent[]): string | undefined {
  if (run.status === "parked") {
    if (run.terminal?.detail) {
      return run.terminal.reason
        ? `${run.terminal.reason}: ${run.terminal.detail}`
        : run.terminal.detail;
    }
    if (run.terminal?.reason) return run.terminal.reason;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "run.parked" || event.data.runId !== run.runId) continue;
      return event.data.detail
        ? `${event.data.reason}: ${event.data.detail}`
        : event.data.reason;
    }
    return undefined;
  }
  if (run.status !== "failed") return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "run.failed" || event.data.runId !== run.runId) continue;
    const decoded = decodeInlineDiagnostic(event.data.diagnosticRef);
    return decoded ? `${event.data.code}: ${decoded}` : event.data.code;
  }
  return run.terminal?.reason;
}

/** Maps optional tools to launch capability labels (see TuiRuntime.capabilityLabels). */
const UNADVERTISED_TOOL_CAPABILITY: Readonly<Record<string, {
  label: string;
  messageKey: "permissions.cap.write" | "permissions.cap.verify" | "permissions.cap.network"
    | "permissions.cap.execute" | "permissions.cap.background" | "permissions.cap.delegate";
}>> = {
  write: { label: "write", messageKey: "permissions.cap.write" },
  edit: { label: "write", messageKey: "permissions.cap.write" },
  move: { label: "write", messageKey: "permissions.cap.write" },
  remove: { label: "write", messageKey: "permissions.cap.write" },
  verify: { label: "verify", messageKey: "permissions.cap.verify" },
  fetch: { label: "network", messageKey: "permissions.cap.network" },
  shell: { label: "host execute", messageKey: "permissions.cap.execute" },
  script: { label: "host execute", messageKey: "permissions.cap.execute" },
  task: { label: "background tasks", messageKey: "permissions.cap.background" },
  delegate: { label: "delegate", messageKey: "permissions.cap.delegate" },
};

function missingCapabilityForUnadvertisedTool(
  failure: string | undefined,
  capabilities: readonly string[],
): { label: string; messageKey: typeof UNADVERTISED_TOOL_CAPABILITY[string]["messageKey"] } | undefined {
  if (!failure) return undefined;
  const match = /unadvertised tool\s+([A-Za-z_][\w-]*)/i.exec(failure);
  if (!match?.[1]) return undefined;
  const mapped = UNADVERTISED_TOOL_CAPABILITY[match[1].toLowerCase()];
  if (!mapped) return undefined;
  if (capabilities.includes(mapped.label)) return undefined;
  return mapped;
}

function unadvertisedCapabilityNext(
  failure: string | undefined,
  capabilities: readonly string[],
  locale: Locale,
): string | undefined {
  const missing = missingCapabilityForUnadvertisedTool(failure, capabilities);
  if (!missing) return undefined;
  return t(locale, "handoff.next.capability", { capability: t(locale, missing.messageKey) });
}

function unadvertisedCapabilityNotice(
  failure: string | undefined,
  capabilities: readonly string[],
  locale: Locale,
): string | undefined {
  const missing = missingCapabilityForUnadvertisedTool(failure, capabilities);
  if (!missing) return undefined;
  return t(locale, "handoff.notice.capability", { capability: t(locale, missing.messageKey) });
}

function decodeInlineDiagnostic(ref: string | undefined): string | undefined {
  if (!ref?.startsWith("diagnostic:inline:")) return undefined;
  try {
    return decodeURIComponent(ref.slice("diagnostic:inline:".length));
  } catch {
    return ref.slice("diagnostic:inline:".length);
  }
}

function delegationGlyph(status: string): string {
  if (status === "running") return "●";
  if (status === "accepted") return "✓";
  if (status === "rejected" || status === "failed" || status === "timed_out") return "!";
  if (status === "cancelled") return "×";
  return "○";
}

function todoGlyph(state: TodoItemState): string {
  if (state === "done") return "✔";
  if (state === "active") return "◐";
  if (state === "parked") return "?";
  if (state === "failed") return "!";
  return "○";
}

function latestPlan(events: readonly SessionEvent[], runId: string): PlanDocument | undefined {
  const documents = new Map<string, PlanDocument>();
  const completed = new Set(events.filter((event) => event.type === "action.completed").map((event) => event.data.actionId));
  for (const event of events) {
    if (event.type !== "action.proposed" || event.data.runId !== runId || !completed.has(event.data.actionId)) continue;
    const input = record(event.data.input);
    const path = typeof input?.path === "string" ? input.path : undefined;
    if (!path || !/\.md$/i.test(path)) continue;
    if (event.data.toolName === "write" && typeof input?.content === "string") {
      documents.set(path, { path, content: input.content, sequence: event.sequence });
    } else if (event.data.toolName === "edit" && typeof input?.oldText === "string" && typeof input?.newText === "string") {
      const previous = documents.get(path);
      const content = previous?.content.includes(input.oldText)
        ? previous.content.replace(input.oldText, input.newText)
        : input.newText;
      documents.set(path, { path, content, sequence: event.sequence });
    }
  }
  return [...documents.values()]
    .filter((document) => checklist(document.content).length > 0 || /(?:plan|todo|task)/i.test(document.path))
    .sort((left, right) => right.sequence - left.sequence)[0];
}

function renderPlanDocument(plan: PlanDocument, expanded: boolean, width: number): string[] {
  const tasks = checklist(plan.content);
  const done = tasks.filter((task) => task.done).length;
  const ratio = tasks.length === 0 ? 0 : done / tasks.length;
  const lines = [`Plan  ${plan.path}`, `  progress  ${done}/${tasks.length} · ${Math.round(ratio * 100)}% ${progressBar(ratio, 16)}`];
  if (expanded || tasks.length <= 6) {
    for (const task of tasks.slice(0, expanded ? 30 : 6)) lines.push(`  ${task.done ? "☑" : "☐"} ${task.text}`);
    if (tasks.length > (expanded ? 30 : 6)) lines.push(`  … ${tasks.length - (expanded ? 30 : 6)} more`);
  }
  if (expanded && /```mermaid/i.test(plan.content)) {
    lines.push("  mermaid source present · rendered as fenced block below");
  }
  void width;
  return lines;
}

function checklist(content: string): Array<{ done: boolean; text: string }> {
  return content.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    return match ? [{ done: match[1]?.toLowerCase() === "x", text: match[2] ?? "" }] : [];
  });
}

function summarizeInput(tool: string, value: unknown): string {
  const input = record(value);
  if (!input) return value === undefined ? "" : oneLine(JSON.stringify(value), 120);
  if (tool === "shell") {
    const command = typeof input.command === "string" ? input.command : "?";
    const args = Array.isArray(input.args) ? input.args.map(shellArg).join(" ") : "";
    const workdir = typeof input.workdir === "string" ? ` · cwd ${input.workdir}` : "";
    const timeout = typeof input.timeoutMs === "number" ? ` · ${formatDuration(input.timeoutMs)} timeout` : "";
    return `${command}${args ? ` ${args}` : ""}${workdir}${timeout}`;
  }
  if (tool === "write") return `${String(input.path ?? "file")} · ${typeof input.content === "string" ? `${input.content.split(/\r?\n/).length} lines` : "replace"}`;
  if (tool === "edit") return `${String(input.path ?? "file")} · ${typeof input.oldText === "string" ? `replace ${oneLine(input.oldText, 48)}` : "patch"}`;
  if (tool === "verify") return `profile ${String(input.profile ?? "?")}`;
  if (typeof input.path === "string") return input.path;
  if (typeof input.query === "string") return oneLine(input.query, 100);
  if (typeof input.pattern === "string") return oneLine(input.pattern, 100);
  return oneLine(JSON.stringify(input), 120);
}

function selectId(ids: readonly string[], current: string | undefined, rawTarget: string): string | undefined {
  if (ids.length === 0) return undefined;
  const target = rawTarget.trim() || "latest";
  if (target === "latest") return ids.at(-1);
  const currentIndex = Math.max(0, current ? ids.indexOf(current) : ids.length - 1);
  if (target === "prev") return ids[Math.max(0, currentIndex - 1)];
  if (target === "next") return ids[Math.min(ids.length - 1, currentIndex + 1)];
  if (/^\d+$/.test(target)) return ids[Number(target) - 1];
  return ids.find((id) => id === target || id.startsWith(target));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function elapsed(start: string | undefined, end: string | undefined): string | undefined {
  if (!start || !end) return undefined;
  const milliseconds = Date.parse(end) - Date.parse(start);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? formatDuration(milliseconds) : undefined;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function formatTokens(tokens: number): string {
  return tokens < 1_000 ? String(tokens) : `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

function progressBar(ratio: number, width: number): string {
  const bounded = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(bounded * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function boundedTailLines(value: string, limit: number): string[] {
  const lines = value.replace(/\r/g, "").split("\n");
  return lines.slice(-limit);
}

function normalizedLineCount(value: string): number {
  return value.replace(/\r/g, "").split("\n").length;
}

function shellArg(value: unknown): string {
  const text = String(value);
  return /[\s"']/u.test(text) ? JSON.stringify(text) : text;
}

function position(ids: readonly string[], id: string): string {
  const index = ids.indexOf(id);
  return `${index + 1}/${ids.length}`;
}

function oneLine(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

function formatMode(mode: string): string {
  switch (mode) {
    case "ask":
      return "Ask";
    case "plan":
      return "Plan";
    default:
      return "Agent";
  }
}

function summarizeDelegations(
  run: RunView | undefined,
): { accepted: number; failed: number; other: number } | undefined {
  if (!run) return undefined;
  const delegations = Object.values(run.delegations);
  if (delegations.length === 0) return undefined;
  let accepted = 0;
  let failed = 0;
  let other = 0;
  for (const delegation of delegations) {
    if (delegation.status === "accepted") accepted += 1;
    else if (
      delegation.status === "failed" ||
      delegation.status === "rejected" ||
      delegation.status === "cancelled" ||
      delegation.status === "timed_out"
    ) {
      failed += 1;
    } else other += 1;
  }
  return { accepted, failed, other };
}

function short(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}
