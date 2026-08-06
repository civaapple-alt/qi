import {
  getProviderModelProfile,
  listProviderProfiles,
  mergeProviderModels,
  providerModelContextTokens,
  providerModelOutputReserveTokens,
  resolveModelCapabilities,
  resolveProviderWireApi,
  type MergedProviderModel,
  type ProviderProfile,
} from "@civaapple/qi-ai";
import type { VerificationCandidate } from "@civaapple/qi-node/tools";
import { SHELL_PROFILE_IDS, type ShellProfileId } from "@civaapple/qi-node/tools";
import type { PluginSkillStatus } from "@civaapple/qi-node/plugins";
import type { ProcessTaskView } from "@civaapple/qi-agent/kernel";
import type { Effect } from "@civaapple/qi-agent/capability";
import {
  bindingKey,
  type McpBinding,
  type McpCandidate,
  type McpReviewDocument,
  type McpServerStatus,
} from "@civaapple/qi-node/mcp";
import type { PanelItem } from "@civaapple/qi-tui";
import type { AuthSession } from "../auth.js";
import {
  DELEGATE_BATCH_MAX,
  DELEGATE_DEPTH,
  DELEGATE_PERCENT_PRESETS,
  DELEGATE_WALL_TIME_PRESETS_MS,
  DEFAULT_DELEGATE_CONTEXT_TOKENS_PERCENT,
  DEFAULT_DELEGATE_MAX_STEPS_PERCENT,
  DEFAULT_DELEGATE_WALL_TIME_MS,
  defaultUserConfigPath,
  loadUserConfig,
  type CompatibleEndpoint,
  type QiCapabilityConfig,
  type QiDelegateConfig,
  type QiShellConfig,
  type ResolvedDelegateConfig,
} from "../config.js";
import { t, type Locale, type MessageKey } from "../i18n.js";
import type { PresentedSkill, PresentedSkillCandidate, TuiPresenter } from "../presenter.js";
import type { TimelineDensity } from "../presenter.js";
import { formatProviderLabel } from "../provider.js";
import {
  parseChatOutputTokenField,
  parseChatThinkingDialect,
  buildCompatibleModelFromFields,
  parseProviderWireApi,
  parseResponsesThinkingDialect,
  writeCustomOpenAiCompatibleProvider,
} from "../provider-catalog-write.js";
import {
  resolveOutputReserveTokens,
  TUI_MAX_ACTIONS_PER_STEP_PRESETS,
  TUI_MAX_STEPS_PRESETS,
} from "../runtime.js";
import type { ThemeName } from "../theme/index.js";
import type { SessionId } from "@civaapple/qi-protocol";
import type { SessionEntry } from "../session-list.js";
import { FormPanel, type FormField, type FormFieldOption } from "./form-panel.js";
import type { PanelHost } from "./host.js";
import { ListPanel } from "./list-panel.js";
import { McpBindingPanel, type McpDraftEffect } from "./mcp-binding-panel.js";
import { MultiSelectPanel } from "./multi-select-panel.js";
import { SkillBrowserPanel, type SkillBrowserItem } from "./skill-browser-panel.js";
import { ScrollPanel } from "./scroll-panel.js";
import {
  NEW_SESSION_ID,
  SessionsPanel,
  sessionEntriesToPanelItems,
} from "./sessions-panel.js";

type McpPanelCandidate = McpCandidate | {
  kind: "instructions";
  name: "instructions";
  description: string;
};

export const CAPABILITY_IDS = [
  "write",
  "verify",
  "network",
  "execute",
  "background",
  "delegate",
  "publish",
  "spend",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface PanelFlowContext {
  readonly panels: PanelHost;
  readonly presenter: TuiPresenter;
  readonly auth: AuthSession | undefined;
  readonly terminalRows: number;
  readonly locale: () => Locale;
  readonly changeLocale: (locale: Locale) => void;
  readonly theme: () => ThemeName;
  readonly changeTheme: (theme: ThemeName) => void;
  readonly density: () => TimelineDensity;
  readonly changeDensity: (density: TimelineDensity, persist: boolean) => void;
  readonly mode: () => string;
  readonly changeMode: (mode: "ask" | "plan" | "agent") => void;
  readonly mcpStatuses: () => Promise<readonly McpServerStatus[]>;
  readonly mcpReview: () => Promise<McpReviewDocument>;
  readonly refreshMcp: (server: string) => Promise<{ drifted: readonly string[] }>;
  readonly bindMcp: (input: {
    server: string;
    kind: McpBinding["kind"];
    name: string;
    effect: Effect;
    resourcePatterns?: readonly string[];
  }) => Promise<McpBinding>;
  readonly unbindMcp: (server: string, kind: McpBinding["kind"], name: string) => Promise<boolean>;
  readonly beginMcpLogin: (server: string) => Promise<string>;
  readonly finishMcpLogin: (server: string, callbackUrl: string) => Promise<void>;
  readonly logoutMcp: (server: string) => Promise<void>;
  readonly startLoginDevice: (
    provider: string,
    options?: {
      model?: string;
      reasoningEffort?: string;
      contextWindowTokens?: number;
      imageInput?: boolean;
    },
  ) => void;
  readonly configureModel: (
    routing: {
      model: string;
      reasoningEffort?: string;
      contextWindowTokens: number;
      outputReserveTokens: number;
      imageInput?: boolean;
    },
    persistence: "account" | "session",
  ) => void;
  readonly startLoginApiKey: (
    provider: string,
    apiKey: string,
    options?: {
      alias?: string;
      model?: string;
      baseURL?: string;
      reasoningEffort?: string;
      contextWindowTokens?: number;
    },
  ) => void;
  readonly startLogout: (provider: string, alias?: string) => void;
  readonly startUseCompatible: (name: string) => void;
  readonly startUseAccount: (
    provider: string,
    alias?: string,
    routing?: {
      model?: string;
      baseURL?: string;
      reasoningEffort?: string;
      contextWindowTokens?: number;
    },
  ) => void;
  readonly openInspect: (panel: "overview" | "config" | "context" | "runs" | "steps" | "actions" | "agents" | "skills" | "jobs" | "tasks" | "providers", title: string) => void;
  readonly discoveredSkills: () => readonly PresentedSkill[];
  readonly skillCandidates: () => readonly PresentedSkillCandidate[];
  readonly pluginSkillStatuses?: (query?: string) => Promise<readonly PluginSkillStatus[]>;
  /** Enabled marketplace names; Skills hub tabs omit disabled marketplaces (same as `/plugins`). */
  readonly listEnabledMarketplaces?: () => Promise<readonly string[]>;
  readonly togglePluginSkillSelection?: (id: string, selected: boolean, onSuccess?: () => void) => void;
  readonly saveAgentSkillActivation: (names: readonly string[]) => void;
  readonly openHistoryList: (kind: "runs" | "steps" | "actions" | "agents") => void;
  readonly addMount: (path: string) => void;
  readonly removeMount: (mountId: string) => void;
  readonly effectiveCapabilities: () => readonly CapabilityId[];
  readonly saveCapabilities: (capabilities: QiCapabilityConfig) => void;
  readonly saveShell: (shell: QiShellConfig) => void;
  readonly currentMaxSteps: () => number;
  readonly saveMaxSteps: (maxSteps: number) => void;
  readonly currentMaxActionsPerStep: () => number;
  readonly saveMaxActionsPerStep: (maxActionsPerStep: number) => void;
  readonly currentDelegateConfig: () => ResolvedDelegateConfig;
  readonly saveDelegateConfig: (patch: QiDelegateConfig) => void;
  readonly applyVerificationSetup: (selected: readonly VerificationCandidate[]) => void;
  readonly installSkill: (source: string, scope: "user" | "workspace") => void;
  readonly installGithubSkill: (url: string, name: string, scope: "user" | "workspace") => void;
  readonly removeSkill: (name: string, scope: "user" | "workspace") => void;
  readonly listTasks: () => ProcessTaskView[];
  readonly stopTask: (taskId: string) => void;
  readonly listSessions: () => SessionEntry[];
  readonly currentSessionId: () => string;
  readonly workspaceRoot: () => string;
  readonly resumeSession: (sessionId: SessionId) => void;
  readonly archiveSession: (sessionId: SessionId) => void;
  readonly restoreSession: (sessionId: SessionId) => void;
  readonly startNewSession: () => void;
  readonly render: () => void;
}

function maxVisible(rows: number): number {
  return Math.max(6, rows - 12);
}

/** SessionsPanel entries are multi-line (title + meta + preview + gap); keep the overlay compact. */
function sessionsMaxVisible(rows: number): number {
  const linesPerSession = 4;
  const chrome = 16;
  return Math.max(3, Math.min(5, Math.floor(Math.max(0, rows - chrome) / linesPerSession)));
}

/**
 * Providers list items are label + description (~2 lines). Cap visible rows so the
 * overlay stays near the editor instead of climbing into the transcript.
 */
function providersMaxVisible(rows: number): number {
  const linesPerItem = 2;
  const chrome = 18;
  return Math.max(4, Math.min(7, Math.floor(Math.max(0, rows - chrome) / linesPerItem)));
}

/** MCP capability entries are two lines and catalogs can contain dozens of Tools; keep review near the editor. */
export function mcpServerMaxVisible(rows: number): number {
  const linesPerItem = 2;
  const chrome = 18;
  return Math.max(5, Math.min(7, Math.floor(Math.max(0, rows - chrome) / linesPerItem)));
}

export function openSettingsPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  ctx.panels.push(new ListPanel({
    title: t(locale, "settings.title"),
    hints: t(locale, "settings.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    items: [
      { id: "mode", label: t(locale, "settings.mode"), description: t(locale, "settings.mode.desc") },
      { id: "permissions", label: t(locale, "settings.permissions"), description: t(locale, "settings.permissions.desc") },
      { id: "shell", label: t(locale, "settings.shell"), description: t(locale, "settings.shell.desc") },
      { id: "max-steps", label: t(locale, "settings.max-steps"), description: t(locale, "settings.max-steps.desc") },
      {
        id: "max-actions-per-step",
        label: t(locale, "settings.max-actions-per-step"),
        description: t(locale, "settings.max-actions-per-step.desc"),
      },
      {
        id: "subagent",
        label: t(locale, "settings.subagent"),
        description: t(locale, "settings.subagent.desc"),
      },
      { id: "providers", label: t(locale, "settings.providers"), description: t(locale, "settings.providers.desc") },
      { id: "config", label: t(locale, "settings.config"), description: t(locale, "settings.config.desc") },
      { id: "context", label: t(locale, "settings.context"), description: t(locale, "settings.context.desc") },
      { id: "theme", label: t(locale, "settings.theme"), description: t(locale, "settings.theme.desc") },
      {
        id: "timeline-density",
        label: t(locale, "settings.timeline-density"),
        description: t(locale, "settings.timeline-density.desc"),
      },
      { id: "language", label: t(locale, "settings.language"), description: t(locale, "settings.language.desc") },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      if (item.id === "mode") {
        openModePanel(ctx);
        return;
      }
      if (item.id === "permissions") {
        openPermissionsPanel(ctx);
        return;
      }
      if (item.id === "shell") {
        openShellPanel(ctx);
        return;
      }
      if (item.id === "max-steps") {
        openMaxStepsPanel(ctx);
        return;
      }
      if (item.id === "max-actions-per-step") {
        openMaxActionsPerStepPanel(ctx);
        return;
      }
      if (item.id === "subagent") {
        openSubagentSettingsPanel(ctx);
        return;
      }
      if (item.id === "providers") {
        openProvidersPanel(ctx);
        return;
      }
      if (item.id === "theme") {
        openThemePanel(ctx);
        return;
      }
      if (item.id === "timeline-density") {
        openTimelineDensityPanel(ctx);
        return;
      }
      if (item.id === "language") {
        openLanguagePanel(ctx);
        return;
      }
      openScroll(ctx, `/${item.id}`, ctx.presenter.renderPanel(item.id as "config" | "context"));
    },
  }));
}

export function openLanguagePanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  ctx.panels.push(new ListPanel({
    title: t(locale, "language.title"),
    hints: t(locale, "settings.hints"),
    items: [
      {
        id: "zh",
        label: t(locale, "language.zh"),
        description: t(locale, "language.zh.desc"),
        current: locale === "zh",
      },
      {
        id: "en",
        label: t(locale, "language.en"),
        description: t(locale, "language.en.desc"),
        current: locale === "en",
      },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      ctx.panels.closeAll();
      ctx.changeLocale(item.id as Locale);
    },
  }));
}

export function openModePanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const current = ctx.mode();
  ctx.panels.push(new ListPanel({
    title: t(locale, "mode.title"),
    hints: t(locale, "settings.hints"),
    items: [
      { id: "ask", label: t(locale, "mode.ask"), description: t(locale, "mode.ask.desc"), current: current === "ask" },
      { id: "plan", label: t(locale, "mode.plan"), description: t(locale, "mode.plan.desc"), current: current === "plan" },
      { id: "agent", label: t(locale, "mode.agent"), description: t(locale, "mode.agent.desc"), current: current === "agent" },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      ctx.panels.closeAll();
      ctx.changeMode(item.id as "ask" | "plan" | "agent");
    },
  }));
}

export function openThemePanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const current = ctx.theme();
  ctx.panels.push(new ListPanel({
    title: t(locale, "theme.title"),
    hints: t(locale, "settings.hints"),
    items: [
      {
        id: "auto",
        label: t(locale, "theme.auto"),
        description: t(locale, "theme.auto.desc"),
        current: current === "auto",
      },
      {
        id: "dark",
        label: t(locale, "theme.dark"),
        description: t(locale, "theme.dark.desc"),
        current: current === "dark",
      },
      {
        id: "light",
        label: t(locale, "theme.light"),
        description: t(locale, "theme.light.desc"),
        current: current === "light",
      },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      ctx.panels.closeAll();
      ctx.changeTheme(item.id as ThemeName);
    },
  }));
}

export function openProvidersPanel(ctx: PanelFlowContext): void {
  void openProvidersPanelAsync(ctx);
}

async function openProvidersPanelAsync(ctx: PanelFlowContext): Promise<void> {
  const locale = ctx.locale();
  const status = ctx.auth?.status();
  const profiles = listProviderProfiles();
  const accounts = ctx.auth ? await ctx.auth.listAccounts() : [];
  const sealedByProvider = new Map<string, { authKind: string; model?: string; alias: string }>();
  for (const account of accounts) {
    // Prefer default alias; otherwise keep the first seen sealed account for the badge.
    const existing = sealedByProvider.get(account.provider);
    if (!existing || account.alias === "default") {
      sealedByProvider.set(account.provider, {
        authKind: account.authKind,
        alias: account.alias,
        ...(account.model === undefined ? {} : { model: account.model }),
      });
    }
  }
  const statusLabel = status
    ? `${formatProviderLabel(status.provider, status.accountAlias)}/${status.model} · ${status.authStatus} · ${status.wireApi}`
    : locale === "zh" ? "当前模式不可用 Auth session" : "Auth session unavailable";
  ctx.panels.push(new ListPanel({
    title: t(locale, "settings.providers"),
    hints: t(locale, "settings.hints"),
    searchable: true,
    maxVisible: providersMaxVisible(ctx.terminalRows),
    items: [
      {
        id: "status",
        label: locale === "zh" ? "当前状态" : "Current status",
        description: statusLabel,
      },
      {
        id: "add-openai-compatible",
        label: locale === "zh" ? "添加 OpenAI 兼容厂商" : "Add OpenAI-compatible provider",
        description: locale === "zh"
          ? "名称 / key / URL / wire / 模型与窗口 → ~/.qi/providers/<名称>.toml"
          : "Name / key / URL / wire / models → ~/.qi/providers/<name>.toml",
      },
      ...profiles.map((profile) => {
        const sealed = sealedByProvider.get(profile.id);
        const sealedLabel = sealed
          ? (locale === "zh"
            ? `已配置${sealed.model ? ` · ${sealed.model}` : ""} · ${sealed.authKind}`
            : `configured${sealed.model ? ` · ${sealed.model}` : ""} · ${sealed.authKind}`)
          : undefined;
        const baseDescription = profile.id === "compatible"
          ? (locale === "zh"
            ? `OpenAI 兼容 Chat Completions · 可保存多个名称并切换 · ${profile.officialBaseURL}`
            : `OpenAI-compatible Chat Completions · save multiple names and switch · ${profile.officialBaseURL}`)
          : `${profile.officialBaseURL} · ${profile.wireApi}`;
        return {
          id: profile.id,
          label: profile.displayName,
          description: sealedLabel ? `${sealedLabel} · ${baseDescription}` : baseDescription,
          current: status?.provider === profile.id,
        };
      }),
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      if (item.id === "status") {
        openScroll(ctx, "/providers", ctx.presenter.renderPanel("providers"));
        return;
      }
      if (item.id === "add-openai-compatible") {
        openAddOpenAiCompatibleProviderForm(ctx);
        return;
      }
      if (item.id === "compatible") {
        void openCompatiblePanel(ctx);
        return;
      }
      void openProviderAuthPanel(ctx, item.id);
    },
  }));
}

/** Collect name/key/url/wire + one model (window/reserve fields); write providers/<id>.toml and login. */
function openAddOpenAiCompatibleProviderForm(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  ctx.panels.push(new FormPanel({
    title: locale === "zh" ? "添加 OpenAI 兼容厂商" : "Add OpenAI-compatible provider",
    description: locale === "zh"
      ? "写入 ~/.qi/providers/<名称>.toml。额外模型可之后编辑该文件。窗口/预留支持 256k、32k。"
      : "Writes ~/.qi/providers/<name>.toml. Edit the file later for more models. Window/reserve accept 256k, 32k.",
    fields: [
      {
        id: "name",
        label: locale === "zh" ? "名称" : "Name",
        placeholder: "xiaomi",
        required: true,
      },
      {
        id: "apiKey",
        label: "API key",
        placeholder: "paste key",
        secret: true,
        required: true,
      },
      {
        id: "baseURL",
        label: "Base URL",
        placeholder: "https://api.example.com/v1",
        required: true,
      },
      {
        id: "wireApi",
        label: locale === "zh" ? "Wire 协议" : "Wire API",
        initialValue: "chat.completions",
        options: [
          {
            value: "chat.completions",
            label: "Chat Completions",
            description: locale === "zh"
              ? "多数兼容网关默认"
              : "Default for most compatible gateways",
          },
          {
            value: "responses",
            label: "Responses",
            description: locale === "zh"
              ? "OpenAI Responses 兼容端点"
              : "OpenAI Responses-compatible endpoints",
          },
        ],
        required: true,
      },
      {
        id: "chatThinking",
        label: locale === "zh" ? "Chat thinking 方言" : "Chat thinking dialect",
        initialValue: "none",
        options: [
          { value: "none", label: "none", description: locale === "zh" ? "不发 thinking 字段" : "No thinking fields" },
          { value: "reasoning_effort", label: "reasoning_effort", description: "top-level reasoning_effort" },
          { value: "kimi_effort", label: "kimi_effort", description: "Kimi-style disable + effort" },
          { value: "thinking_keep_all", label: "thinking_keep_all", description: "thinking.keep=all" },
          { value: "thinking_type_and_effort", label: "thinking_type_and_effort", description: "DeepSeek Chat style" },
          { value: "enable_thinking_and_effort", label: "enable_thinking_and_effort", description: "enable_thinking + effort" },
        ],
      },
      {
        id: "responsesThinking",
        label: locale === "zh" ? "Responses thinking 方言" : "Responses thinking dialect",
        initialValue: "reasoning_effort",
        options: [
          { value: "reasoning_effort", label: "reasoning_effort", description: "reasoning.effort" },
          {
            value: "thinking_type_and_reasoning_effort",
            label: "thinking_type_and_reasoning_effort",
            description: "thinking.type + reasoning.effort",
          },
        ],
      },
      {
        id: "chatOutputTokenField",
        label: locale === "zh" ? "Chat 输出字段" : "Chat output token field",
        initialValue: "max_tokens",
        options: [
          { value: "max_tokens", label: "max_tokens" },
          { value: "max_completion_tokens", label: "max_completion_tokens" },
        ],
      },
      {
        id: "modelId",
        label: locale === "zh" ? "模型 ID" : "Model ID",
        placeholder: "step-3.7-flash",
        required: true,
      },
      {
        id: "contextWindowTokens",
        label: locale === "zh" ? "上下文窗口" : "Context window",
        placeholder: locale === "zh" ? "例如 256k（默认 128000）" : "e.g. 256k (default 128000)",
        initialValue: "128000",
      },
      {
        id: "outputReserveTokens",
        label: locale === "zh" ? "输出预留" : "Output reserve",
        placeholder: locale === "zh" ? "例如 32k（默认 16000）" : "e.g. 32k (default 16000)",
        initialValue: "16000",
      },
    ],
    submitLabel: locale === "zh" ? "保存并登录" : "Save and login",
    onClose: ctx.panels.dismiss,
    onSubmit: (values) => {
      void (async () => {
        try {
          const model = buildCompatibleModelFromFields({
            modelId: values.modelId ?? "",
            contextWindowTokens: values.contextWindowTokens,
            outputReserveTokens: values.outputReserveTokens,
          });
          const wireApi = parseProviderWireApi(values.wireApi);
          const written = await writeCustomOpenAiCompatibleProvider({
            name: values.name ?? "",
            baseURL: values.baseURL ?? "",
            models: [model],
            wireApi,
            chatThinking: parseChatThinkingDialect(values.chatThinking),
            responsesThinking: parseResponsesThinkingDialect(values.responsesThinking),
            chatOutputTokenField: parseChatOutputTokenField(values.chatOutputTokenField),
          });
          ctx.panels.closeAll();
          ctx.startLoginApiKey(written.providerId, values.apiKey ?? "", {
            model: model.id,
            baseURL: written.profile.officialBaseURL,
          });
          ctx.presenter.setNotice(
            locale === "zh"
              ? `已写入 ${written.path} · ${wireApi} · 正在登录 ${written.displayName}/${model.id}`
              : `Wrote ${written.path} · ${wireApi} · logging in ${written.displayName}/${model.id}`,
          );
          ctx.render();
        } catch (error) {
          ctx.presenter.setNotice(
            error instanceof Error ? error.message : String(error),
          );
          ctx.render();
        }
      })();
    },
  }));
}

async function openCompatiblePanel(ctx: PanelFlowContext): Promise<void> {
  const locale = ctx.locale();
  const status = ctx.auth?.status();
  const configPath = ctx.presenter.launch.configPath ?? defaultUserConfigPath();
  let catalog: readonly CompatibleEndpoint[] = [];
  try {
    catalog = (await loadUserConfig(configPath)).config.compatible ?? [];
  } catch {
    catalog = [];
  }
  const sealed = ctx.auth
    ? (await ctx.auth.listAccounts()).filter((account) => account.provider === "compatible")
    : [];
  const currentName = status?.provider === "compatible" ? status.accountAlias : undefined;
  const names = new Set<string>();
  const endpoints: {
    name: string;
    model?: string;
    baseURL?: string;
    sealed: boolean;
  }[] = [];
  for (const entry of catalog) {
    names.add(entry.name);
    const account = sealed.find((candidate) => candidate.alias === entry.name);
    endpoints.push({
      name: entry.name,
      model: entry.model ?? account?.model,
      baseURL: entry.baseURL ?? account?.baseURL,
      sealed: account !== undefined,
    });
  }
  for (const account of sealed) {
    if (names.has(account.alias)) continue;
    names.add(account.alias);
    endpoints.push({
      name: account.alias,
      ...(account.model === undefined ? {} : { model: account.model }),
      ...(account.baseURL === undefined ? {} : { baseURL: account.baseURL }),
      sealed: true,
    });
  }
  if (currentName && !names.has(currentName)) {
    endpoints.push({
      name: currentName,
      ...(status?.model === undefined ? {} : { model: status.model }),
      ...(status?.baseURL === undefined ? {} : { baseURL: status.baseURL }),
      sealed: sealed.some((account) => account.alias === currentName),
    });
  }
  ctx.panels.push(new ListPanel({
    title: locale === "zh" ? "OpenAI 兼容" : "OpenAI Compatible",
    hints: locale === "zh"
      ? "选择端点可切换或重新配置 · Enter · Esc 返回"
      : "Select an endpoint to switch or reconfigure · Enter · Esc back",
    maxVisible: maxVisible(ctx.terminalRows),
    items: [
      {
        id: "add",
        label: locale === "zh" ? "添加 / 登录" : "Add / login",
        description: locale === "zh"
          ? "新建名称（如 zhipu）并密封 API key"
          : "Create a name (e.g. zhipu) and seal an API key",
      },
      ...endpoints.map((entry) => {
        const routing = [entry.model, entry.baseURL].filter(Boolean).join(" · ");
        const badge = entry.sealed
          ? (locale === "zh" ? "已配置" : "configured")
          : (locale === "zh" ? "仅 catalog" : "catalog only");
        return {
          id: `endpoint:${entry.name}`,
          label: entry.name,
          description: routing ? `${badge} · ${routing}` : badge,
          current: currentName === entry.name,
        };
      }),
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      if (item.id === "add") {
        const profile = listProviderProfiles().find((candidate) => candidate.id === "compatible");
        if (!profile) return;
        void openApiKeyForm(ctx, "compatible", profile);
        return;
      }
      if (item.id.startsWith("endpoint:")) {
        const name = item.id.slice("endpoint:".length);
        const entry = endpoints.find((candidate) => candidate.name === name);
        void openCompatibleEndpointPanel(ctx, {
          name,
          ...(entry?.model === undefined ? {} : { model: entry.model }),
          ...(entry?.baseURL === undefined ? {} : { baseURL: entry.baseURL }),
          sealed: entry?.sealed ?? false,
        });
      }
    },
  }));
}

async function openCompatibleEndpointPanel(
  ctx: PanelFlowContext,
  endpoint: { name: string; model?: string; baseURL?: string; sealed: boolean },
): Promise<void> {
  const locale = ctx.locale();
  const status = ctx.auth?.status();
  const isCurrent = status?.provider === "compatible" && status.accountAlias === endpoint.name;
  const routing = [endpoint.model, endpoint.baseURL].filter(Boolean).join(" · ");
  const profile = listProviderProfiles().find((candidate) => candidate.id === "compatible");
  if (!profile) return;
  ctx.panels.push(new ListPanel({
    title: locale === "zh" ? `OpenAI 兼容 · ${endpoint.name}` : `OpenAI Compatible · ${endpoint.name}`,
    hints: locale === "zh"
      ? "↑↓ 选择 · Enter · Esc 返回"
      : "↑↓ navigate · Enter · Esc back",
    items: [
      ...(endpoint.sealed && !isCurrent
        ? [{
          id: "switch",
          label: locale === "zh" ? "切换到此端点" : "Switch to this endpoint",
          description: locale === "zh"
            ? `仅切换生效端点；保留全部已配置凭证${routing ? ` · ${routing}` : ""}`
            : `Activate only; keep all sealed credentials${routing ? ` · ${routing}` : ""}`,
        }]
        : []),
      ...(isCurrent
        ? [{
          id: "current",
          label: locale === "zh" ? "当前已生效" : "Already active",
          description: routing || status?.model || "",
        }]
        : []),
      {
        id: "relogin",
        label: endpoint.sealed
          ? (locale === "zh" ? "重新配置（API key）" : "Reconfigure (API key)")
          : (locale === "zh" ? "登录（API key）" : "Login (API key)"),
        description: endpoint.sealed
          ? (locale === "zh"
            ? "覆盖已密封的 key / model / base URL"
            : "Replace sealed key / model / base URL")
          : (locale === "zh"
            ? "密封 API key 并保存 routing"
            : "Seal API key and save routing"),
      },
      {
        id: "logout",
        label: locale === "zh" ? "退出并清除此端点" : "Logout this endpoint",
        description: endpoint.sealed
          ? (locale === "zh"
            ? `仅清除 ${endpoint.name}；其他名称与提供商保留`
            : `Clear only ${endpoint.name}; keep other names and providers`)
          : (locale === "zh" ? "尚无密封凭证" : "No sealed credential"),
      },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      if (item.id === "current") {
        ctx.panels.dismiss();
        return;
      }
      if (item.id === "switch") {
        ctx.panels.closeAll();
        ctx.startUseCompatible(endpoint.name);
        return;
      }
      if (item.id === "relogin") {
        void openApiKeyForm(ctx, "compatible", profile, {
          alias: endpoint.name,
          ...(endpoint.model === undefined ? {} : { model: endpoint.model }),
          ...(endpoint.baseURL === undefined ? {} : { baseURL: endpoint.baseURL }),
        });
        return;
      }
      if (item.id === "logout") {
        if (!endpoint.sealed) {
          ctx.presenter.setNotice(locale === "zh"
            ? "没有可退出的密封凭证。"
            : "No sealed credential to log out.");
          ctx.render();
          return;
        }
        ctx.panels.closeAll();
        ctx.startLogout("compatible", endpoint.name);
      }
    },
  }));
}

export function openMountsPanel(
  ctx: PanelFlowContext,
  mounts: readonly { id: string; path: string; source: string }[],
): void {
  const locale = ctx.locale();
  const mountLines = mounts.length === 0
    ? [t(locale, "mounts.list.empty"), t(locale, "mounts.empty.hint")]
    : mounts.map((mount) => `mount:${mount.id}/ → ${mount.path} (${mount.source})`);
  ctx.panels.push(new ListPanel({
    title: t(locale, "mounts.title"),
    hints: t(locale, "mounts.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    items: [
      {
        id: "list",
        label: t(locale, "mounts.list"),
        description: mounts.length === 0
          ? t(locale, "mounts.list.empty")
          : mounts.map((mount) => mount.id).join(", "),
      },
      { id: "add", label: t(locale, "mounts.add"), description: t(locale, "mounts.add.desc") },
      { id: "unmount", label: t(locale, "mounts.unmount"), description: t(locale, "mounts.unmount.desc") },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      if (item.id === "list") {
        openScroll(ctx, "/mounts", [
          t(locale, "mounts.title"),
          ...mountLines.map((line) => `  ${line}`),
        ]);
        return;
      }
      if (item.id === "add") {
        openMountAddForm(ctx);
        return;
      }
      openMountUnmountPanel(ctx, mounts);
    },
  }));
}

function openMountAddForm(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  ctx.panels.push(new FormPanel({
    title: t(locale, "mounts.add.title"),
    description: t(locale, "mounts.add.form.desc"),
    fields: [
      {
        id: "path",
        label: t(locale, "mounts.add.path"),
        placeholder: locale === "zh" ? "D:/docs 或 /home/me/docs" : "D:/docs or /home/me/docs",
        required: true,
      },
    ],
    submitLabel: t(locale, "mounts.add.submit"),
    onClose: ctx.panels.dismiss,
    onSubmit: (values) => {
      const path = (values.path ?? "").trim();
      if (!path) return;
      ctx.panels.closeAll();
      ctx.addMount(path);
    },
  }));
}

function openMountUnmountPanel(
  ctx: PanelFlowContext,
  mounts: readonly { id: string; path: string; source: string }[],
): void {
  const locale = ctx.locale();
  if (mounts.length === 0) {
    ctx.presenter.setNotice(t(locale, "mounts.list.empty"));
    ctx.render();
    return;
  }
  ctx.panels.push(new ListPanel({
    title: t(locale, "mounts.unmount.title"),
    hints: t(locale, "mounts.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    items: mounts.map((mount) => ({
      id: mount.id,
      label: mount.id,
      description: `${mount.path} (${mount.source})`,
    })),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      ctx.panels.closeAll();
      ctx.removeMount(item.id);
    },
  }));
}

export function openPermissionsPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const effective = new Set(ctx.effectiveCapabilities());
  const items = CAPABILITY_IDS.map((id) => ({
    id,
    label: t(locale, `permissions.cap.${id}` as MessageKey),
    description: t(locale, `permissions.cap.${id}.desc` as MessageKey),
  }));
  ctx.panels.push(new MultiSelectPanel({
    title: t(locale, "permissions.title"),
    hints: t(locale, "permissions.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    items,
    selectedIds: [...effective],
    currentIds: [...effective],
    onClose: ctx.panels.dismiss,
    onApply: (selectedIds) => {
      const selected = new Set(selectedIds);
      const capabilities: QiCapabilityConfig = {
        write: selected.has("write"),
        verify: selected.has("verify"),
        network: selected.has("network"),
        execute: selected.has("execute"),
        background: selected.has("background"),
        delegate: selected.has("delegate"),
        publish: selected.has("publish"),
        spend: selected.has("spend"),
      };
      ctx.panels.closeAll();
      ctx.saveCapabilities(capabilities);
    },
  }));
}

/** Effort levels advertised by the current model profile (empty when thinking is unavailable). */
export function supportedEffortsForModel(profile: ProviderProfile, model: string): readonly string[] {
  return resolveModelCapabilities(profile, model).effortsForUi;
}

/** Catalog truth for built-in/custom profiles; generic compatible endpoints remain operator-declared. */
export function modelCatalogAllowsImage(profile: ProviderProfile, model: string): boolean {
  return resolveModelCapabilities(profile, model).catalogAllowsImage;
}

function modelInputCapabilityLabel(profile: ProviderProfile, model: string, locale: Locale): string {
  if (profile.id === "compatible") return locale === "zh" ? "图片能力可配置" : "image configurable";
  return modelCatalogAllowsImage(profile, model)
    ? (locale === "zh" ? "支持图片" : "image")
    : (locale === "zh" ? "仅文本" : "text only");
}

export function openMaxStepsPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const current = ctx.currentMaxSteps();
  const presets = (TUI_MAX_STEPS_PRESETS as readonly number[]).includes(current)
    ? [...TUI_MAX_STEPS_PRESETS]
    : [...TUI_MAX_STEPS_PRESETS, current].sort((left, right) => left - right);
  ctx.panels.push(new ListPanel({
    title: t(locale, "max_steps.title"),
    hints: t(locale, "max_steps.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    items: presets.map((steps) => ({
      id: String(steps),
      label: String(steps),
      description: steps === current
        ? (locale === "zh" ? "当前" : "Current")
        : (locale === "zh" ? `每个 Run 最多 ${steps} Steps` : `Up to ${steps} Steps per Run`),
      current: steps === current,
    })),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      const steps = Number(item.id);
      ctx.panels.closeAll();
      ctx.saveMaxSteps(steps);
    },
  }));
}

export function openSubagentSettingsPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const config = ctx.currentDelegateConfig();
  const enabled = ctx.effectiveCapabilities().includes("delegate");
  const wallLabel = formatDelegateWall(config.wallTimeMs, locale);
  const defaultWall = formatDelegateWall(DEFAULT_DELEGATE_WALL_TIME_MS, locale);
  ctx.panels.push(new ListPanel({
    title: t(locale, "subagent.title"),
    hints: t(locale, "settings.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    items: [
      {
        id: "enabled",
        label: t(locale, "subagent.enabled"),
        description: enabled
          ? t(locale, "subagent.enabled.on")
          : t(locale, "subagent.enabled.off"),
        current: enabled,
      },
      {
        id: "wall",
        label: t(locale, "subagent.wall"),
        description: t(locale, "subagent.wall.desc", {
          value: wallLabel,
          default: defaultWall,
        }),
      },
      {
        id: "max-steps-percent",
        label: t(locale, "subagent.max_steps_percent"),
        description: t(locale, "subagent.max_steps_percent.desc", {
          value: String(config.maxStepsPercent),
          default: String(DEFAULT_DELEGATE_MAX_STEPS_PERCENT),
        }),
      },
      {
        id: "context-percent",
        label: t(locale, "subagent.context_tokens_percent"),
        description: t(locale, "subagent.context_tokens_percent.desc", {
          value: String(config.contextTokensPercent),
          default: String(DEFAULT_DELEGATE_CONTEXT_TOKENS_PERCENT),
        }),
      },
      {
        id: "batch-max",
        label: t(locale, "subagent.batch_max"),
        description: t(locale, "subagent.batch_max.desc", { value: String(DELEGATE_BATCH_MAX) }),
      },
      {
        id: "depth",
        label: t(locale, "subagent.depth"),
        description: t(locale, "subagent.depth.desc", { value: String(DELEGATE_DEPTH) }),
      },
      {
        id: "tasks",
        label: t(locale, "subagent.open_tasks"),
        description: t(locale, "subagent.open_tasks.desc"),
      },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      if (item.id === "enabled") {
        openPermissionsPanel(ctx);
        return;
      }
      if (item.id === "wall") {
        openSubagentWallPanel(ctx);
        return;
      }
      if (item.id === "max-steps-percent") {
        openSubagentPercentPanel(ctx, "maxStepsPercent");
        return;
      }
      if (item.id === "context-percent") {
        openSubagentPercentPanel(ctx, "contextTokensPercent");
        return;
      }
      if (item.id === "tasks") {
        ctx.panels.closeAll();
        openSubagentTasksHubPanel(ctx);
        return;
      }
      // Fixed product constants — keep the hub open (no stack push).
    },
  }));
}

function formatDelegateWall(wallTimeMs: number, locale: Locale): string {
  const minutes = Math.max(1, Math.round(wallTimeMs / 60_000));
  return locale === "zh" ? `${minutes} 分钟` : `${minutes}m`;
}

export function openSubagentWallPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const current = ctx.currentDelegateConfig().wallTimeMs;
  const presets = (DELEGATE_WALL_TIME_PRESETS_MS as readonly number[]).includes(current)
    ? [...DELEGATE_WALL_TIME_PRESETS_MS]
    : [...DELEGATE_WALL_TIME_PRESETS_MS, current].sort((left, right) => left - right);
  ctx.panels.push(new ListPanel({
    title: t(locale, "subagent.wall.title"),
    hints: t(locale, "settings.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    items: presets.map((ms) => ({
      id: String(ms),
      label: formatDelegateWall(ms, locale),
      description: ms === DEFAULT_DELEGATE_WALL_TIME_MS
        ? (ms === current
          ? t(locale, "subagent.value.current_default")
          : t(locale, "subagent.value.default"))
        : (ms === current
          ? t(locale, "subagent.value.current")
          : t(locale, "subagent.wall.item_desc")),
      current: ms === current,
    })),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      ctx.panels.closeAll();
      ctx.saveDelegateConfig({ wallTimeMs: Number(item.id) });
    },
  }));
}

export function openSubagentPercentPanel(
  ctx: PanelFlowContext,
  field: "maxStepsPercent" | "contextTokensPercent",
): void {
  const locale = ctx.locale();
  const config = ctx.currentDelegateConfig();
  const current = config[field];
  const defaultValue = field === "maxStepsPercent"
    ? DEFAULT_DELEGATE_MAX_STEPS_PERCENT
    : DEFAULT_DELEGATE_CONTEXT_TOKENS_PERCENT;
  const titleKey = field === "maxStepsPercent"
    ? "subagent.max_steps_percent.title"
    : "subagent.context_tokens_percent.title";
  const presets = (DELEGATE_PERCENT_PRESETS as readonly number[]).includes(current)
    ? [...DELEGATE_PERCENT_PRESETS]
    : [...DELEGATE_PERCENT_PRESETS, current].sort((left, right) => left - right);
  ctx.panels.push(new ListPanel({
    title: t(locale, titleKey),
    hints: t(locale, "settings.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    items: presets.map((percent) => ({
      id: String(percent),
      label: `${percent}%`,
      description: percent === defaultValue
        ? (percent === current
          ? t(locale, "subagent.value.current_default")
          : t(locale, "subagent.value.default"))
        : (percent === current
          ? t(locale, "subagent.value.current")
          : t(locale, "subagent.percent.item_desc")),
      current: percent === current,
    })),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      ctx.panels.closeAll();
      const value = Number(item.id);
      ctx.saveDelegateConfig(
        field === "maxStepsPercent"
          ? { maxStepsPercent: value }
          : { contextTokensPercent: value },
      );
    },
  }));
}

export function openMaxActionsPerStepPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const current = ctx.currentMaxActionsPerStep();
  const presets = (TUI_MAX_ACTIONS_PER_STEP_PRESETS as readonly number[]).includes(current)
    ? [...TUI_MAX_ACTIONS_PER_STEP_PRESETS]
    : [...TUI_MAX_ACTIONS_PER_STEP_PRESETS, current].sort((left, right) => left - right);
  ctx.panels.push(new ListPanel({
    title: t(locale, "max_actions_per_step.title"),
    hints: t(locale, "max_actions_per_step.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    items: presets.map((count) => ({
      id: String(count),
      label: String(count),
      description: count === current
        ? (locale === "zh" ? "当前" : "Current")
        : (locale === "zh"
          ? `每个 Step 最多执行 ${count} 个 Action`
          : `Execute up to ${count} Actions per Step`),
      current: count === current,
    })),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      const count = Number(item.id);
      ctx.panels.closeAll();
      ctx.saveMaxActionsPerStep(count);
    },
  }));
}

/** Empty string = operator unset; adapters omit effort on the wire. */
const UNSET_REASONING_EFFORT = "";

function effortDescription(locale: Locale, effort: string): string {
  if (effort === UNSET_REASONING_EFFORT) {
    return locale === "zh" ? "不传 effort，由 API 默认" : "Omit effort; provider API default";
  }
  if (effort === "low") return locale === "zh" ? "较快" : "Faster";
  if (effort === "medium") return locale === "zh" ? "中等" : "Balanced";
  if (effort === "high") return locale === "zh" ? "较强思考" : "Stronger reasoning";
  if (effort === "xhigh") return locale === "zh" ? "更高思考" : "Extra-high reasoning";
  if (effort === "max") return locale === "zh" ? "最强思考" : "Maximum reasoning";
  if (effort === "none") return locale === "zh" ? "关闭思考" : "Disable thinking";
  return effort;
}

function effortFieldOptions(
  locale: Locale,
  efforts: readonly string[],
): FormFieldOption[] {
  return [
    {
      value: UNSET_REASONING_EFFORT,
      label: locale === "zh" ? "不设置（API 默认）" : "Unset (API default)",
      description: effortDescription(locale, UNSET_REASONING_EFFORT),
    },
    ...efforts.map((effort) => ({
      value: effort,
      label: effort,
      description: effortDescription(locale, effort),
    })),
  ];
}

export function openShellPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const snapshot = ctx.presenter.launch.shell;
  const selected = new Set<string>(snapshot?.allowed ?? ["direct"]);
  const items = SHELL_PROFILE_IDS.map((id) => {
    const available = snapshot?.available.find((profile) => profile.id === id);
    const unavailable = snapshot?.unavailable.find((profile) => profile.id === id);
    const platformBlocked = id === "cmd" && process.platform !== "win32";
    let description: string;
    if (id === "direct") {
      description = t(locale, "shell.profile.direct.desc");
    } else if (platformBlocked) {
      description = t(locale, "shell.profile.windows_only");
    } else if (available) {
      description = t(locale, "shell.profile.available", {
        executable: available.executable,
        version: available.version ? ` · ${available.version}` : "",
      });
    } else if (unavailable?.status === "unavailable") {
      description = t(locale, "shell.profile.unavailable", { reason: unavailable.reason });
    } else {
      description = t(locale, "shell.profile.disabled");
    }
    return {
      id,
      label: id,
      description,
      disabled: platformBlocked,
    };
  });
  ctx.panels.push(new MultiSelectPanel({
    title: t(locale, "shell.title"),
    hints: t(locale, "shell.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    items,
    selectedIds: [...selected],
    currentIds: [...selected],
    onClose: ctx.panels.dismiss,
    onApply: (selectedIds) => {
      const allowed = selectedIds.filter((id): id is ShellProfileId =>
        (SHELL_PROFILE_IDS as readonly string[]).includes(id)
      );
      if (allowed.length === 0) {
        ctx.presenter.setNotice(t(locale, "shell.empty"));
        ctx.render();
        return;
      }
      const shell: QiShellConfig = {
        default: allowed.includes("direct") ? "direct" : allowed[0]!,
        allowed,
      };
      ctx.panels.closeAll();
      ctx.saveShell(shell);
    },
  }));
}

export function openVerifySetupPanel(
  ctx: PanelFlowContext,
  candidates: readonly VerificationCandidate[],
  currentNames: readonly string[],
): void {
  const locale = ctx.locale();
  if (candidates.length === 0) {
    ctx.presenter.setNotice(t(locale, "verify.setup.empty"));
    ctx.render();
    return;
  }
  const items = candidates.map((candidate) => ({
    id: candidate.name,
    label: candidate.name,
    description: `${candidate.command} ${candidate.args.join(" ")} — ${candidate.source}` +
      (candidate.available ? "" : ` (${t(locale, "verify.setup.notfound")})`),
    disabled: !candidate.available,
  }));
  ctx.panels.push(new MultiSelectPanel({
    title: t(locale, "verify.setup.title"),
    hints: t(locale, "verify.setup.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    items,
    selectedIds: candidates.filter((candidate) => candidate.recommended && candidate.available).map((candidate) => candidate.name),
    currentIds: currentNames,
    onClose: ctx.panels.dismiss,
    onApply: (selectedIds) => {
      const chosen = candidates.filter((candidate) => selectedIds.includes(candidate.name));
      ctx.panels.closeAll();
      ctx.applyVerificationSetup(chosen);
    },
  }));
}

/** Map launch capability labels onto stable capability ids. */
export function capabilityIdsFromLaunchLabels(labels: readonly string[]): CapabilityId[] {
  const ids: CapabilityId[] = [];
  for (const label of labels) {
    if (label === "write") ids.push("write");
    else if (label === "verify") ids.push("verify");
    else if (label === "network") ids.push("network");
    else if (label === "host execute" || label === "execute") ids.push("execute");
    else if (label === "background tasks" || label === "background") ids.push("background");
    else if (label === "delegate") ids.push("delegate");
    else if (label === "publish") ids.push("publish");
    else if (label === "spend") ids.push("spend");
  }
  return ids;
}

function alwaysOnSkills(skills: readonly PresentedSkill[]): PresentedSkill[] {
  return skills.filter((skill) => !(skill.scope === "user" && skill.origin === "agent"));
}

export function openSkillsHubPanel(ctx: PanelFlowContext): void {
  if (!ctx.pluginSkillStatuses) {
    openSkillsHubPanelContents(ctx, []);
    return;
  }
  void openSkillsHubPanelAsync(ctx);
}

async function openSkillsHubPanelAsync(ctx: PanelFlowContext): Promise<void> {
  const [pluginSkills, enabledMarketplaces] = await Promise.all([
    (ctx.pluginSkillStatuses?.() ?? Promise.resolve([])).catch(() => [] as readonly PluginSkillStatus[]),
    (ctx.listEnabledMarketplaces?.() ?? Promise.resolve(undefined)).catch(() => undefined),
  ]);
  // Match `/plugins`: disabled marketplaces stay out of the horizontal tab strip even when
  // their plugin caches (and Skill rows) remain on disk.
  const enabled = enabledMarketplaces === undefined
    ? undefined
    : new Set(enabledMarketplaces);
  const visible = enabled === undefined
    ? pluginSkills
    : pluginSkills.filter((status) => enabled.has(status.ref.marketplace));
  openSkillsHubPanelContents(ctx, visible);
}

function openSkillsHubPanelContents(ctx: PanelFlowContext, pluginSkills: readonly PluginSkillStatus[]): void {
  const active = ctx.discoveredSkills();
  const candidates = ctx.skillCandidates();
  const alwaysOn = alwaysOnSkills(active);
  const activeGlobal = active.filter((skill) => skill.scope === "user" && skill.origin === "agent");
  const globalCandidates = candidates.filter((skill) => skill.source === "global-agent");
  let browser: SkillBrowserPanel | undefined;
  browser = new SkillBrowserPanel({
    native: alwaysOn.map((skill) => ({
      id: skill.name,
      label: skill.name,
      description: `${skill.scope} · ${skill.origin ?? "qi"} · ${skill.version}`,
    })),
    global: globalCandidates.map((skill) => ({
      id: skill.name,
      label: `${activeGlobal.some((activeSkill) => activeSkill.name === skill.name) ? "[*]" : "[ ]"} ${skill.name}`,
      description: `${skill.version} · ${skill.description}`,
    })),
    pluginMarkets: groupPluginSkills(pluginSkills),
    maxVisible: maxVisible(ctx.terminalRows),
    onClose: ctx.panels.dismiss,
    onSelect: (tab, item) => {
      if (tab === "native") {
        openAlwaysOnSkillsPanel(ctx);
        return;
      }
      if (tab === "global") {
        openSkillActivationPanel(ctx);
        return;
      }
      if (tab.startsWith("plugin:")) {
        void openPluginSkillDetails(ctx, item);
      }
    },
    onToggle: (tab, item) => {
      if (!tab.startsWith("plugin:")) return;
      const current = pluginSkills.find((status) => status.ref.id === item.id);
      if (!current) return;
      const nextSelected = !current.selected;
      ctx.togglePluginSkillSelection?.(item.id, nextSelected, () => {
        browser?.updateItem({
          ...item,
          label: `${nextSelected ? "[*]" : "[ ]"} ${current.ref.name}@${current.ref.marketplace}`,
        });
      });
    },
    onInstall: () => {
      openSkillManagePanel(ctx);
    },
  });
  ctx.panels.push(browser);
}

function openAlwaysOnSkillsPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const skills = alwaysOnSkills(ctx.discoveredSkills());
  if (skills.length === 0) {
    ctx.presenter.setNotice(t(locale, "skills.always_on.empty"));
    ctx.render();
    return;
  }
  ctx.panels.push(new ListPanel({
    title: t(locale, "skills.always_on.title"),
    hints: t(locale, "skills.always_on.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    searchable: true,
    items: skills.map((skill) => ({
      id: skill.name,
      label: skill.name,
      description: `${skill.scope} · ${skill.origin ?? "qi"} · ${skill.version}`,
    })),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      ctx.panels.dismiss();
      ctx.presenter.setNotice(t(locale, "skills.always_on.use", { name: item.id }));
      ctx.render();
    },
  }));
}

function groupPluginSkills(pluginSkills: readonly PluginSkillStatus[]): readonly { marketplace: string; items: readonly SkillBrowserItem[] }[] {
  const grouped = new Map<string, SkillBrowserItem[]>();
  for (const { ref, enabled, selected } of pluginSkills) {
    const items = grouped.get(ref.marketplace) ?? [];
    items.push({
      id: ref.id,
      label: `${enabled ? "[*]" : selected ? "[~]" : "[ ]"} ${ref.name}@${ref.marketplace}`,
      description: `${ref.invocationMode} · ${ref.description}`,
    });
    grouped.set(ref.marketplace, items);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([marketplace, items]) => ({ marketplace, items }));
}

async function openPluginSkillDetails(ctx: PanelFlowContext, item: SkillBrowserItem): Promise<void> {
  const locale = ctx.locale();
  const status = (await (ctx.pluginSkillStatuses?.() ?? Promise.resolve([]))).find((entry) => entry.ref.id === item.id);
  if (!status) {
    ctx.presenter.setNotice(locale === "zh" ? "找不到这个插件 Skill。" : "Plugin Skill not found.");
    ctx.render();
    return;
  }
  const state = status.enabled ? "enabled" : status.selected ? "selected but blocked" : "not selected";
  const lines = [
    `${status.ref.name}@${status.ref.marketplace}`,
    `State · ${state}`,
    `Invocation · ${status.ref.invocationMode}`,
    "",
    status.ref.description,
    "",
    status.ref.userInvocable
      ? `Explicit invocation · /skill:${status.ref.id} <task>`
      : "Invocation · model-only via plugin_skill",
    locale === "zh" ? "在 Skills 列表中按 Space 可直接切换该 Skill。" : "Press Space on this row in Skills to toggle it.",
  ];
  ctx.panels.push(new ScrollPanel({
    title: `${status.ref.name}@${status.ref.marketplace}`,
    lines,
    maxVisible: maxVisible(ctx.terminalRows),
    hints: locale === "zh" ? "Esc 返回 · ↑↓ 滚动" : "Esc back · ↑↓ scroll",
    onClose: ctx.panels.dismiss,
  }));
}

export function openMcpPanel(ctx: PanelFlowContext): void {
  void openMcpPanelAsync(ctx);
}

async function openMcpPanelAsync(ctx: PanelFlowContext): Promise<void> {
  const locale = ctx.locale();
  try {
    const statuses = await ctx.mcpStatuses();
    ctx.panels.push(new ListPanel({
      title: locale === "zh" ? "MCP 管理" : "MCP manager",
      hints: locale === "zh" ? "↑↓ 选择 · Enter 打开 · Esc 返回" : "↑↓ navigate · Enter open · Esc back",
      maxVisible: maxVisible(ctx.terminalRows),
      searchable: true,
      items: statuses.length === 0
        ? [{
          id: "empty",
          label: locale === "zh" ? "没有 MCP 声明" : "No MCP declarations",
          description: locale === "zh" ? "在 .qi/mcp 或用户 MCP 目录添加声明文件。" : "Add a declaration under .qi/mcp or the user MCP directory.",
          disabled: true,
        }]
        : statuses.map((status) => ({
          id: status.name,
          label: mcpDisplayName(status),
          description: formatMcpStatus(status, locale),
        })),
      onClose: ctx.panels.dismiss,
      onSelect: (item) => {
        if (item.id === "empty") return;
        void openMcpServerPanel(ctx, item.id);
      },
    }));
  } catch (error) {
    ctx.presenter.setNotice(error instanceof Error ? error.message : String(error));
    ctx.render();
  }
}

async function openMcpServerPanel(ctx: PanelFlowContext, server: string): Promise<void> {
  const locale = ctx.locale();
  try {
    const [statuses, review] = await Promise.all([ctx.mcpStatuses(), ctx.mcpReview()]);
    const status = statuses.find((entry) => entry.name === server);
    const displayName = status ? mcpDisplayName(status) : server;
    const snapshot = review.snapshots[server];
    const bindings = new Map(
      Object.values(review.bindings)
        .filter((binding) => binding.server === server)
        .map((binding) => [bindingKey(binding), binding]),
    );
    const candidates: McpPanelCandidate[] = snapshot === undefined
      ? []
      : [
        ...snapshot.tools,
        ...snapshot.resources,
        ...snapshot.resourceTemplates,
        ...snapshot.prompts,
        ...(snapshot.instructions === undefined
          ? []
          : [{
            kind: "instructions" as const,
            name: "instructions" as const,
            description: locale === "zh" ? "远端服务器说明（不可信数据）。" : "Remote server instructions (untrusted data).",
          }]),
      ];
    const actions = [
      {
        id: "refresh",
        label: locale === "zh" ? "刷新发现" : "Refresh discovery",
        description: locale === "zh" ? "重新读取远端工具、资源、提示与说明，并检测漂移。" : "Rediscover remote tools, resources, prompts, and instructions; detect drift.",
      },
      ...(status?.status === "needs-auth"
        ? [{ id: "login", label: locale === "zh" ? "登录 MCP" : "Log in to MCP", description: locale === "zh" ? "开始 OAuth 授权流程。" : "Start the OAuth authorization flow." }]
        : []),
      ...(status?.status === "ready" || status?.status === "idle"
        ? [{ id: "logout", label: locale === "zh" ? "清除登录" : "Log out", description: locale === "zh" ? "清除该 MCP 的 OAuth 凭证。" : "Remove OAuth credentials for this MCP." }]
        : []),
    ];
    const handleAction = (id: string): void => {
      if (id === "refresh") {
        runMcpServerPanelAction(ctx, server, async () => {
          const result = await ctx.refreshMcp(server);
          return locale === "zh"
            ? `${server} 已刷新 · ${result.drifted.length} 个绑定需要重新审阅。`
            : `${server} refreshed · ${result.drifted.length} binding(s) need review.`;
        });
        return;
      }
      if (id === "login") {
        runMcpPanelAction(ctx, async () => {
          const url = await ctx.beginMcpLogin(server);
          ctx.presenter.setNotice(locale === "zh" ? `请打开授权 URL，然后粘贴回调地址。\n${url}` : `Open the authorization URL, then paste the callback URL.\n${url}`);
          openMcpCallbackForm(ctx, server);
          return undefined;
        }, false);
        return;
      }
      if (id === "logout") {
        runMcpServerPanelAction(ctx, server, async () => {
          await ctx.logoutMcp(server);
          return locale === "zh" ? `${server} 的 MCP 凭证已清除。` : `${server} MCP credentials removed.`;
        });
      }
    };
    if (candidates.length === 0) {
      ctx.panels.push(new ListPanel({
        title: `${displayName} · MCP`,
        hints: locale === "zh" ? "↑↓ 选择 · Enter 执行 · Esc 返回" : "↑↓ navigate · Enter run · Esc back",
        maxVisible: mcpServerMaxVisible(ctx.terminalRows),
        items: [
          ...actions,
          {
            id: "no-snapshot",
            label: locale === "zh" ? "尚未发现能力" : "No capabilities discovered",
            description: locale === "zh" ? "先选择“刷新发现”。" : "Choose Refresh discovery first.",
            disabled: true,
          },
        ],
        onClose: ctx.panels.dismiss,
        onSelect: (item) => handleAction(item.id),
      }));
      return;
    }
    ctx.panels.push(new McpBindingPanel({
      title: `${displayName} · MCP`,
      locale,
      maxVisible: mcpServerMaxVisible(ctx.terminalRows),
      actions,
      candidates: candidates.map((candidate) => {
        const binding = bindings.get(bindingKey({ server, kind: candidate.kind, name: candidate.name }));
        return {
          id: candidateId(candidate),
          label: `${candidate.kind} · ${candidate.name}`,
          description: candidate.description ?? (locale === "zh" ? "无描述" : "No description"),
          effects: candidate.kind === "instructions"
            ? ["read"]
            : ["read", "write", "execute", "publish", "spend"],
          ...(binding === undefined ? {} : { currentEffect: binding.effect }),
          state: binding?.state ?? "unbound",
        };
      }),
      onClose: ctx.panels.dismiss,
      onAction: handleAction,
      onApply: (changes) => applyMcpBindingChanges(ctx, server, locale, candidates, bindings, changes),
    }));
  } catch (error) {
    ctx.presenter.setNotice(error instanceof Error ? error.message : String(error));
    ctx.render();
  }
}

function applyMcpBindingChanges(
  ctx: PanelFlowContext,
  server: string,
  locale: Locale,
  candidates: readonly McpPanelCandidate[],
  bindings: ReadonlyMap<string, McpBinding>,
  changes: readonly { id: string; effect: McpDraftEffect }[],
): void {
  if (changes.length === 0) {
    ctx.presenter.setNotice(locale === "zh" ? "没有待保存的 MCP 绑定变更。" : "No pending MCP binding changes.");
    ctx.render();
    return;
  }
  ctx.panels.closeAll();
  void (async () => {
    let applied = 0;
    for (const change of changes) {
      const candidate = candidates.find((entry) => candidateId(entry) === change.id);
      if (!candidate) throw new Error(`MCP candidate disappeared before save: ${change.id}`);
      const binding = bindings.get(bindingKey({ server, kind: candidate.kind, name: candidate.name }));
      if (change.effect === "unbound") {
        if (await ctx.unbindMcp(server, candidate.kind, candidate.name)) applied += 1;
        continue;
      }
      await ctx.bindMcp({
        server,
        kind: candidate.kind,
        name: candidate.name,
        effect: change.effect,
        ...(binding?.resourcePatterns.length ? { resourcePatterns: binding.resourcePatterns } : {}),
      });
      applied += 1;
    }
    return applied;
  })()
    .then((applied) => {
      ctx.presenter.setNotice(locale === "zh" ? `${server} 已保存 ${applied} 项绑定变更。` : `${server} saved ${applied} binding change(s).`);
      void openMcpServerPanel(ctx, server);
    })
    .catch((error: unknown) => {
      ctx.presenter.setNotice(error instanceof Error ? error.message : String(error));
      ctx.render();
    });
}

function openMcpCallbackForm(ctx: PanelFlowContext, server: string): void {
  const locale = ctx.locale();
  ctx.panels.push(new FormPanel({
    title: locale === "zh" ? `${server} · OAuth 回调` : `${server} · OAuth callback`,
    description: locale === "zh" ? "将授权页面重定向后的完整回调 URL 粘贴到这里。" : "Paste the complete callback URL after the authorization page redirects.",
    fields: [{ id: "callbackUrl", label: locale === "zh" ? "回调 URL" : "Callback URL", required: true }],
    submitLabel: locale === "zh" ? "完成登录" : "Finish login",
    onClose: ctx.panels.dismiss,
    onSubmit: (values) => {
      const callbackUrl = values.callbackUrl?.trim();
      if (!callbackUrl) return;
      ctx.panels.closeAll();
      void ctx.finishMcpLogin(server, callbackUrl)
        .then(() => {
          ctx.presenter.setNotice(locale === "zh" ? `${server} MCP 登录完成。` : `${server} MCP login completed.`);
          ctx.render();
        })
        .catch((error: unknown) => {
          ctx.presenter.setNotice(error instanceof Error ? error.message : String(error));
          ctx.render();
        });
    },
  }));
}

function runMcpPanelAction(ctx: PanelFlowContext, action: () => Promise<string | undefined>, reopen = true): void {
  ctx.panels.closeAll();
  void action()
    .then((notice) => {
      if (notice !== undefined) ctx.presenter.setNotice(notice);
      if (reopen) openMcpPanel(ctx);
      else ctx.render();
    })
    .catch((error: unknown) => {
      ctx.presenter.setNotice(error instanceof Error ? error.message : String(error));
      ctx.render();
    });
}

function runMcpServerPanelAction(ctx: PanelFlowContext, server: string, action: () => Promise<string | undefined>): void {
  ctx.panels.closeAll();
  void action()
    .then((notice) => {
      if (notice !== undefined) ctx.presenter.setNotice(notice);
      void openMcpServerPanel(ctx, server);
    })
    .catch((error: unknown) => {
      ctx.presenter.setNotice(error instanceof Error ? error.message : String(error));
      ctx.render();
    });
}

function candidateId(candidate: McpPanelCandidate): string {
  return `candidate:${candidate.kind}:${encodeURIComponent(candidate.name)}`;
}

function mcpDisplayName(status: Pick<McpServerStatus, "name" | "marketplace">): string {
  // Marketplace declarations already use the qualified server id `name@marketplace`.
  return status.name;
}

function formatMcpSource(status: Pick<McpServerStatus, "scope" | "marketplace">, locale: Locale): string {
  if (status.marketplace !== undefined) {
    return locale === "zh" ? "插件市场" : "plugin marketplace";
  }
  if (status.scope === "workspace") {
    return locale === "zh" ? "工作区" : "workspace";
  }
  return locale === "zh" ? "用户" : "user";
}

function formatMcpStatus(status: McpServerStatus, locale: Locale): string {
  const state = locale === "zh"
    ? ({ disabled: "禁用", quarantined: "隔离（未连接）", connecting: "连接中", ready: "就绪", "needs-auth": "需要登录", drifted: "发生漂移", failed: "失败", idle: "空闲" } as const)[status.status]
    : status.status;
  const bindingSummary = status.candidateCount > 0
    ? `${status.bindingCount}/${status.candidateCount} ${locale === "zh" ? "已绑定" : "bound"}`
    : `${status.bindingCount} ${locale === "zh" ? "个绑定" : "binding(s)"}`;
  return `${formatMcpSource(status, locale)} · ${state} · ${status.transport} · ${status.candidateCount} ${locale === "zh" ? "项能力" : "capabilities"} · ${bindingSummary}`;
}

function openSkillActivationPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const active = ctx.discoveredSkills();
  const candidates = ctx.skillCandidates();
  const enabled = active
    .filter((skill) => skill.scope === "user" && skill.origin === "agent")
    .map((skill) => skill.name);
  const globalCandidates = candidates.filter((skill) => skill.source === "global-agent");
  if (enabled.length === 0 && globalCandidates.length === 0) {
    ctx.presenter.setNotice(t(locale, "skills.activation.empty"));
    ctx.render();
    return;
  }
  ctx.panels.push(new MultiSelectPanel({
    title: t(locale, "skills.activation.title"),
    hints: t(locale, "skills.activation.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    items: [
      ...active
        .filter((skill) => skill.scope === "user" && skill.origin === "agent")
        .map((skill) => ({
          id: skill.name,
          label: skill.name,
          description: `${t(locale, "skills.active")} · global .agents · ${skill.version}`,
        })),
      ...globalCandidates.map((skill) => ({
        id: skill.name,
        label: skill.name,
        description: `${t(locale, "skills.inactive")} · global .agents · ${skill.version}`,
      })),
    ],
    selectedIds: enabled,
    currentIds: enabled,
    onClose: ctx.panels.dismiss,
    onApply: (selectedIds) => {
      ctx.panels.closeAll();
      ctx.saveAgentSkillActivation(selectedIds);
    },
  }));
}

type SkillInstallAction = (scope: "user" | "workspace") => void;

/** Install tab hub: install new Qi Skills or remove user/Workspace copies. */
function openSkillManagePanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const removable = managedQiSkills(ctx.discoveredSkills());
  ctx.panels.push(new ListPanel({
    title: t(locale, "skills.manage.title"),
    hints: t(locale, "skills.hints"),
    items: [
      {
        id: "install",
        label: t(locale, "skills.install"),
        description: t(locale, "skills.install.desc"),
      },
      {
        id: "remove",
        label: t(locale, "skills.remove"),
        description: removable.length === 0
          ? t(locale, "skills.remove.empty")
          : t(locale, "skills.remove.desc", { count: String(removable.length) }),
      },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      if (item.id === "install") {
        openSkillInstallSourcePanel(ctx);
        return;
      }
      openSkillRemovePanel(ctx);
    },
  }));
}

function managedQiSkills(skills: readonly PresentedSkill[]): readonly PresentedSkill[] {
  return skills
    .filter((skill) => (skill.origin ?? "qi") === "qi")
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope));
}

function openSkillRemovePanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  // Prefer active catalog rows (winning scope). Shadowed user copies stay until the
  // workspace copy is removed, or the operator uses `qi skill remove --scope user`.
  const removable = managedQiSkills(ctx.discoveredSkills());
  if (removable.length === 0) {
    ctx.presenter.setNotice(t(locale, "skills.remove.empty"));
    ctx.render();
    return;
  }
  ctx.panels.push(new ListPanel({
    title: t(locale, "skills.remove.title"),
    hints: t(locale, "skills.remove.hints"),
    maxVisible: maxVisible(ctx.terminalRows),
    searchable: true,
    items: removable.map((skill) => ({
      id: `${skill.scope}:${skill.name}`,
      label: skill.name,
      description: `${skill.scope} · ${skill.origin ?? "qi"} · ${skill.version}`,
    })),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      const skill = removable.find((candidate) => `${candidate.scope}:${candidate.name}` === item.id);
      if (!skill) return;
      openSkillRemoveConfirmPanel(ctx, skill);
    },
  }));
}

function openSkillRemoveConfirmPanel(ctx: PanelFlowContext, skill: PresentedSkill): void {
  const locale = ctx.locale();
  ctx.panels.push(new ListPanel({
    title: t(locale, "skills.remove.confirm.title", { name: skill.name }),
    hints: locale === "zh" ? "Enter 确认 · Esc 取消" : "Enter confirm · Esc cancel",
    items: [
      {
        id: "remove",
        label: t(locale, "skills.remove.confirm"),
        description: t(locale, "skills.remove.confirm.desc", {
          name: skill.name,
          scope: skill.scope,
        }),
      },
      {
        id: "cancel",
        label: locale === "zh" ? "取消" : "Cancel",
      },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (choice) => {
      if (choice.id === "cancel") {
        ctx.panels.dismiss();
        return;
      }
      ctx.panels.closeAll();
      ctx.removeSkill(skill.name, skill.scope);
    },
  }));
}

function openSkillInstallSourcePanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  ctx.panels.push(new ListPanel({
    title: locale === "zh" ? "安装 Skill" : "Install Skill",
    hints: locale === "zh" ? "↑↓ 选择来源 · Enter 打开 · Esc 返回" : "↑↓ choose source · Enter open · Esc back",
    items: [
      {
        id: "github",
        label: "GitHub repository",
        description: locale === "zh"
          ? "仓库 URL + Skill 名；先锁定当前 commit，再安装"
          : "Repository URL + Skill name; pin current commit before install",
      },
      {
        id: "local",
        label: locale === "zh" ? "本地路径或兼容目录" : "Local path or compatibility directory",
        description: locale === "zh"
          ? "已有目录，例如 ~/.codex/skills/.system 下的一个 Skill"
          : "An existing directory, e.g. one Skill under ~/.codex/skills/.system",
      },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      if (item.id === "github") openGithubSkillInstallForm(ctx);
      else openLocalSkillInstallForm(ctx);
    },
  }));
}

function openSkillInstallScopePanel(ctx: PanelFlowContext, install: SkillInstallAction): void {
  const locale = ctx.locale();
  ctx.panels.push(new ListPanel({
    title: t(locale, "skills.install.scope.title"),
    hints: t(locale, "skills.hints"),
    items: [
      {
        id: "user",
        label: t(locale, "skills.install.scope.user"),
        description: t(locale, "skills.install.scope.user.desc"),
      },
      {
        id: "workspace",
        label: t(locale, "skills.install.scope.workspace"),
        description: t(locale, "skills.install.scope.workspace.desc"),
      },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      ctx.panels.closeAll();
      install(item.id === "workspace" ? "workspace" : "user");
    },
  }));
}

function openLocalSkillInstallForm(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  ctx.panels.push(new FormPanel({
    title: locale === "zh" ? "本地 Skill 来源" : "Local Skill source",
    description: locale === "zh"
      ? "选择一个包含 SKILL.md 的本地目录或已配置兼容目录。安装位置下一步再选。"
      : "Choose a local directory containing SKILL.md or a configured compatibility entry. Choose the destination next.",
    fields: [
      {
        id: "source",
        label: t(locale, "skills.install.form.source"),
        placeholder: locale === "zh"
          ? "技能名或本地路径，例如 skill-creator"
          : "Skill name or local path, e.g. skill-creator",
        required: true,
      },
    ],
    submitLabel: t(locale, "skills.install.form.submit"),
    onClose: ctx.panels.dismiss,
    onSubmit: (values) => {
      const source = (values.source ?? "").trim();
      if (!source) return;
      openSkillInstallScopePanel(ctx, (scope) => ctx.installSkill(source, scope));
    },
  }));
}

function openGithubSkillInstallForm(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  ctx.panels.push(new FormPanel({
    title: locale === "zh" ? "GitHub Skill 来源" : "GitHub Skill source",
    description: locale === "zh"
      ? "等同于 npx skills add <仓库> --skill <名称>。Qi 先解析当前 HEAD 并锁定 commit；请先审阅该 Skill 的 SKILL.md。"
      : "Equivalent to npx skills add <repository> --skill <name>. Qi resolves and locks current HEAD first; review SKILL.md before installing.",
    fields: [
      {
        id: "url",
        label: locale === "zh" ? "GitHub 仓库 URL" : "GitHub repository URL",
        placeholder: "https://github.com/shadcn/ui",
        required: true,
      },
      {
        id: "name",
        label: locale === "zh" ? "Skill 名称" : "Skill name",
        placeholder: "shadcn",
        required: true,
      },
    ],
    submitLabel: locale === "zh" ? "选择安装位置" : "Choose install location",
    onClose: ctx.panels.dismiss,
    onSubmit: (values) => {
      const url = (values.url ?? "").trim();
      const name = (values.name ?? "").trim();
      if (!url || !name) return;
      openSkillInstallScopePanel(ctx, (scope) => ctx.installGithubSkill(url, name, scope));
    },
  }));
}

/** Background ProcessTasks (operator surface: Jobs). */
export function openJobsHubPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const jobs = ctx.listTasks().sort((left, right) => {
    const leftActive = left.status === "running" ? 0 : left.status === "stopping" ? 1 : 2;
    const rightActive = right.status === "running" ? 0 : right.status === "stopping" ? 1 : 2;
    return leftActive - rightActive || right.startedAt.localeCompare(left.startedAt);
  });
  if (jobs.length === 0) {
    ctx.presenter.setNotice(t(locale, "jobs.empty"));
    ctx.render();
    return;
  }
  ctx.panels.push(new ListPanel({
    title: t(locale, "jobs.title"),
    hints: t(locale, "jobs.hints"),
    items: jobs.map((task) => ({
      id: task.taskId,
      label: `${task.status === "running" ? "●" : task.status === "stopping" ? "◐" : "○"} ${[task.command, ...task.args].join(" ")}`,
      description: `${task.status} · pid ${task.pid} · cwd ${task.workdir}${task.terminalReason ? ` · ${task.terminalReason}` : ""}`,
      disabled: task.status !== "running",
    })),
    maxVisible: maxVisible(ctx.terminalRows),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      ctx.panels.closeAll();
      ctx.stopTask(item.id);
    },
  }));
}

/** @deprecated Use openJobsHubPanel — ProcessTasks moved to /jobs (ADR-0035). */
export function openTasksHubPanel(ctx: PanelFlowContext): void {
  openJobsHubPanel(ctx);
}

/** Subagent research Tasks for the selected/current Run. */
export function openSubagentTasksHubPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const items = ctx.presenter.historyAgentItems();
  if (items.length === 0) {
    ctx.presenter.setNotice(t(locale, "tasks.empty"));
    ctx.render();
    return;
  }
  ctx.panels.push(new ListPanel({
    title: t(locale, "tasks.title"),
    hints: t(locale, "tasks.hints"),
    items: items.map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description,
      current: item.current,
    })),
    maxVisible: maxVisible(ctx.terminalRows),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      ctx.panels.closeAll();
      ctx.presenter.selectDelegation(item.id);
      ctx.openInspect("tasks", "/tasks");
    },
  }));
}

export function openTimelineDensityPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const current = ctx.density();
  const labels: Record<TimelineDensity, [string, string]> = locale === "zh"
    ? {
        compact: ["简洁", "只保留意图、结果、变更和异常"],
        standard: ["标准", "合组探索过程，保留关键执行证据"],
        diagnostic: ["诊断", "展开 Thinking、Action 和更多工程细节"],
      }
    : {
        compact: ["Compact", "Keep intent, results, changes, and exceptions"],
        standard: ["Standard", "Group exploration and retain important evidence"],
        diagnostic: ["Diagnostic", "Expand Thinking, Actions, and engineering detail"],
      };
  ctx.panels.push(new ListPanel({
    title: locale === "zh" ? "时间线密度" : "Timeline density",
    hints: t(locale, "settings.hints"),
    items: (["compact", "standard", "diagnostic"] as const).map((id) => ({
      id,
      label: labels[id][0],
      description: labels[id][1],
      current: current === id,
    })),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      const density = item.id as TimelineDensity;
      ctx.panels.push(new ListPanel({
        title: labels[density][0],
        hints: t(locale, "settings.hints"),
        items: [
          {
            id: "session",
            label: locale === "zh" ? "仅当前 Session" : "This Session",
            description: locale === "zh" ? "立即应用，不修改配置" : "Apply now without changing config",
          },
          {
            id: "default",
            label: locale === "zh" ? "保存为用户默认" : "Save as user default",
            description: locale === "zh" ? "应用并写入 $QI_HOME/config.toml" : "Apply and persist to $QI_HOME/config.toml",
          },
        ],
        onClose: ctx.panels.dismiss,
        onSelect: (scope) => {
          ctx.panels.closeAll();
          ctx.changeDensity(density, scope.id === "default");
        },
      }));
    },
  }));
}

/** Open the current Session's Run list (sessions-style); Enter drills into Steps or Agents (Actions via Step). */
export function openRunsHubPanel(ctx: PanelFlowContext): void {
  openHistoryListPanel(ctx, "runs");
}

export function openHistoryListPanel(
  ctx: PanelFlowContext,
  kind: "runs" | "steps" | "actions" | "agents",
): void {
  const locale = ctx.locale();
  const presenter = ctx.presenter;
  const items = kind === "runs"
    ? presenter.historyRunItems()
    : kind === "steps"
      ? presenter.historyStepItems()
      : kind === "actions"
        ? presenter.historyActionItems()
        : presenter.historyAgentItems();
  const titleKey = kind === "runs"
    ? "runs.list.runs"
    : kind === "steps"
      ? "runs.list.steps"
      : kind === "actions"
        ? "runs.list.actions"
        : "runs.list.agents";
  const emptyKey = kind === "runs"
    ? "runs.list.empty.runs"
    : kind === "steps"
      ? "runs.list.empty.steps"
      : kind === "actions"
        ? "runs.list.empty.actions"
        : "runs.list.empty.agents";
  if (items.length === 0) {
    presenter.setNotice(t(locale, emptyKey));
    ctx.render();
    return;
  }
  const currentIndex = items.findIndex((item) => item.current);
  ctx.panels.push(new ListPanel({
    title: kind === "runs" ? t(locale, "runs.title") : t(locale, titleKey),
    hints: t(locale, "runs.list.hints"),
    items,
    searchable: true,
    ...(currentIndex >= 0 ? { initialSelected: currentIndex } : {}),
    maxVisible: maxVisible(ctx.terminalRows),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      const notice = kind === "runs"
        ? presenter.selectRun(item.id)
        : kind === "steps"
          ? presenter.selectStep(item.id)
          : kind === "actions"
            ? presenter.selectAction(item.id)
            : presenter.selectDelegation(item.id);
      presenter.setNotice(notice);
      if (kind === "runs") {
        openHistoryRunEntry(ctx);
        ctx.render();
        return;
      }
      if (kind === "steps") {
        openHistoryStepActions(ctx);
        ctx.render();
        return;
      }
      ctx.panels.dismiss();
      ctx.render();
    },
  }));
}

function openHistoryRunEntry(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const run = ctx.presenter.selectedRun();
  if (!run) return;
  const hasSteps = run.stepOrder.length > 0;
  const hasAgents = Object.keys(run.delegations).length > 0;
  if (hasSteps && hasAgents) {
    ctx.panels.push(new ListPanel({
      title: t(locale, "runs.drilldown.title", { runId: run.runId }),
      hints: t(locale, "runs.drilldown.hints"),
      items: [
        {
          id: "steps",
          label: t(locale, "runs.steps"),
          description: t(locale, "runs.drilldown.steps.desc", { count: String(run.stepOrder.length) }),
        },
        {
          id: "agents",
          label: t(locale, "runs.agents"),
          description: t(locale, "runs.drilldown.agents.desc", { count: String(Object.keys(run.delegations).length) }),
        },
      ],
      onClose: ctx.panels.dismiss,
      onSelect: (item) => openHistoryListPanel(ctx, item.id as "steps" | "agents"),
    }));
    return;
  }
  if (hasSteps) {
    openHistoryListPanel(ctx, "steps");
    return;
  }
  if (hasAgents) {
    openHistoryListPanel(ctx, "agents");
    return;
  }
  ctx.presenter.setNotice(t(locale, "runs.empty.detail"));
}

function openHistoryStepActions(ctx: PanelFlowContext): void {
  const step = ctx.presenter.selectedStep();
  if (!step) return;
  const items = ctx.presenter.historyActionItems(step.stepId);
  if (items.length === 0) {
    ctx.presenter.setNotice("The selected Step has no Actions.");
    return;
  }
  ctx.panels.push(new ListPanel({
    title: `Step · ${step.stepId} → Actions`,
    hints: t(ctx.locale(), "runs.list.hints"),
    items,
    searchable: true,
    maxVisible: maxVisible(ctx.terminalRows),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      ctx.presenter.setNotice(ctx.presenter.selectAction(item.id));
      ctx.panels.dismiss();
      ctx.render();
    },
  }));
}

export function openSessionsPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const entries = ctx.listSessions();
  const items = sessionEntriesToPanelItems(
    entries,
    ctx.currentSessionId(),
    t(locale, "sessions.new"),
  );
  const currentIndex = items.findIndex((item) => item.current);
  ctx.panels.push(new SessionsPanel({
    title: t(locale, "sessions.title"),
    hints: t(locale, "sessions.hints"),
    emptyLabel: t(locale, "sessions.empty"),
    currentMark: t(locale, "sessions.current"),
    showingLabel: (from, to, total) => t(locale, "sessions.showing", {
      from: String(from),
      to: String(to),
      total: String(total),
    }),
    items,
    ...(currentIndex > 0 ? { initialSelected: currentIndex } : {}),
    maxVisible: sessionsMaxVisible(ctx.terminalRows),
    onClose: ctx.panels.dismiss,
    onArchive: (item) => {
      const sessionId = (item.sessionId ?? item.id) as SessionId;
      ctx.panels.push(new ListPanel({
        title: locale === "zh" ? "确认归档 Session" : "Confirm Session archive",
        hints: locale === "zh" ? "Enter 确认 · Esc 取消" : "Enter confirm · Esc cancel",
        items: [
          {
            id: "archive",
            label: locale === "zh" ? "归档（可恢复）" : "Archive (restorable)",
            description: sessionId,
          },
          {
            id: "cancel",
            label: locale === "zh" ? "取消" : "Cancel",
          },
        ],
        onClose: ctx.panels.dismiss,
        onSelect: (choice) => {
          if (choice.id === "cancel") {
            ctx.panels.dismiss();
            return;
          }
          ctx.panels.closeAll();
          ctx.archiveSession(sessionId);
        },
      }));
    },
    onSelect: (item) => {
      if (item.id === NEW_SESSION_ID || item.isNew) {
        ctx.panels.closeAll();
        ctx.startNewSession();
        return;
      }
      const sessionId = (item.sessionId ?? item.id) as SessionId;
      if (item.location === "archived") {
        ctx.panels.closeAll();
        ctx.restoreSession(sessionId);
        return;
      }
      if (sessionId === ctx.currentSessionId()) {
        ctx.presenter.setNotice(t(locale, "sessions.already"));
        ctx.panels.dismiss();
        ctx.render();
        return;
      }
      ctx.panels.closeAll();
      ctx.resumeSession(sessionId);
    },
  }));
}

export async function openModelConfigurationPanel(ctx: PanelFlowContext): Promise<void> {
  const auth = ctx.auth;
  if (!auth) {
    ctx.presenter.setNotice("Auth session is unavailable in this TUI mode.");
    ctx.render();
    return;
  }
  const status = auth.status();
  const profile = listProviderProfiles().find((candidate) => candidate.id === status.provider);
  if (!profile) return;
  const locale = ctx.locale();
  const availableModels = profile.modelDiscovery === "openai_compatible"
    ? await auth.listAvailableModels()
    : mergeProviderModels(profile, undefined);
  const efforts = supportedEffortsForModel(profile, status.model);
  const modelById = new Map(availableModels.map((model) => [model.id, model]));
  const currentWireApi = resolveProviderWireApi(profile, status.model);
  const imageInputConfigurable = profile.id === "compatible"
    || availableModels.some((model) => modelCatalogAllowsImage(profile, model.id))
    || modelCatalogAllowsImage(profile, status.model);
  const fields: FormField[] = [
    {
      id: "model",
      label: "Model",
      initialValue: status.model,
      required: true,
      ...(availableModels.length > 0
        ? {
            options: [
              ...availableModels.map((model) => {
                const wire = resolveProviderWireApi(profile, model.id);
                return {
                  value: model.id,
                  label: model.displayName,
                  description: `${model.id} · ${wire} · ${formatContextWindow(model.contextTokens)} · ${modelInputCapabilityLabel(profile, model.id, locale)}${
                    model.catalogued ? "" : (locale === "zh" ? " · 远程" : " · remote")
                  }`,
                };
              }),
              ...(profile.modelDiscovery === "openai_compatible"
                ? [{
                    value: "",
                    label: locale === "zh" ? "手动输入模型 ID…" : "Enter model ID manually…",
                    description: locale === "zh" ? "自定义或未来模型" : "Custom or future model",
                    customInput: true as const,
                    placeholder: "model id",
                  }]
                : []),
            ],
          }
        : {}),
    },
    ...(efforts.length > 0
      ? [{
          id: "reasoningEffort",
          label: "Thinking effort",
          initialValue: status.reasoningEffort && efforts.includes(status.reasoningEffort)
            ? status.reasoningEffort
            : UNSET_REASONING_EFFORT,
          required: false,
          options: effortFieldOptions(locale, efforts),
        } satisfies FormField]
      : []),
    {
      id: "contextWindowTokens",
      label: locale === "zh" ? "上下文窗口（tokens）" : "Context window (tokens)",
      initialValue: String(status.contextWindowTokens),
      required: true,
    },
    {
      id: "outputReserveTokens",
      label: locale === "zh" ? "最大输出（tokens）" : "Max output tokens",
      initialValue: String(ctx.presenter.launch.outputReserveTokens),
      required: true,
    },
    ...(imageInputConfigurable
      ? [{
          id: "imageInput",
          label: locale === "zh" ? "图片输入" : "Image input",
          initialValue: status.imageInput ? "true" : "false",
          required: true,
          options: [
            {
              value: "true",
              label: locale === "zh" ? "启用" : "Enabled",
              description: locale === "zh" ? "允许粘贴或附加图片进入模型上下文" : "Allow pasted or attached images in model context",
            },
            {
              value: "false",
              label: locale === "zh" ? "关闭" : "Disabled",
              description: locale === "zh" ? "拒绝本模型的图片输入" : "Reject image input for this model",
            },
          ],
        } satisfies FormField]
      : []),
    {
      id: "persistence",
      label: locale === "zh" ? "保存范围" : "Save scope",
      initialValue: "account",
      required: true,
      options: [
        {
          value: "account",
          label: locale === "zh" ? "用户默认（推荐）" : "User default (recommended)",
          description: locale === "zh"
            ? "写入 ~/.qi/config.toml 与凭证元数据；下次启动仍生效"
            : "Persist to ~/.qi/config.toml and sealed credential metadata",
        },
        {
          value: "session",
          label: locale === "zh" ? "仅当前 Session" : "Current Session only",
          description: locale === "zh"
            ? "只改本次对话，不改配置文件"
            : "Apply now without changing config",
        },
      ],
    },
  ];
  ctx.panels.push(new FormPanel({
    title: locale === "zh" ? "配置模型（无需重新登录）" : "Configure model (no re-login)",
    description: [
      formatProviderLabel(status.provider, status.accountAlias),
      `wire ${currentWireApi}`,
      ...(status.baseURL
        ? [`endpoint ${status.baseURL}`, locale === "zh" ? "endpoint 只读" : "endpoint is read-only"]
        : []),
    ].join("\n"),
    fields,
    onChange: (fieldId, value, values) => {
      if (fieldId === "model" && value) {
        const windowTokens = modelById.get(value)?.contextTokens
          ?? providerModelContextTokens(profile, value);
        const nextEfforts = supportedEffortsForModel(profile, value);
        const currentEffort = values.reasoningEffort ?? UNSET_REASONING_EFFORT;
        return {
          contextWindowTokens: String(windowTokens),
          outputReserveTokens: String(resolveOutputReserveTokens(
            windowTokens,
            providerModelOutputReserveTokens(profile, value),
          )),
          ...(imageInputConfigurable
            ? {
                imageInput: profile.id === "compatible"
                  ? (values.imageInput ?? "false")
                  : modelCatalogAllowsImage(profile, value) ? "true" : "false",
              }
            : {}),
          ...(nextEfforts.length === 0
            ? {}
            : {
                reasoningEffort: currentEffort !== UNSET_REASONING_EFFORT
                    && nextEfforts.includes(currentEffort)
                  ? currentEffort
                  : UNSET_REASONING_EFFORT,
              }),
        };
      }
      if (fieldId === "contextWindowTokens" && value) {
        const windowTokens = Number(value);
        if (!Number.isInteger(windowTokens) || windowTokens < 8_192) return;
        const modelId = (values.model ?? status.model).trim() || status.model;
        return {
          outputReserveTokens: String(resolveOutputReserveTokens(
            windowTokens,
            providerModelOutputReserveTokens(profile, modelId),
          )),
        };
      }
      return;
    },
    submitLabel: locale === "zh" ? "应用" : "Apply",
    onClose: ctx.panels.dismiss,
    onSubmit: (values) => {
      ctx.panels.closeAll();
      const model = (values.model ?? "").trim();
      const contextWindowTokens = parseLoginContextWindow(values.contextWindowTokens);
      const modelEfforts = supportedEffortsForModel(profile, model);
      const selectedEffort = values.reasoningEffort;
      ctx.configureModel({
        model,
        ...(modelEfforts.length === 0
          ? {}
          : { reasoningEffort: selectedEffort ?? UNSET_REASONING_EFFORT }),
        contextWindowTokens,
        outputReserveTokens: parseLoginOutputReserve(values.outputReserveTokens, contextWindowTokens),
        ...(imageInputConfigurable
          ? { imageInput: values.imageInput === "true" }
          : {}),
      }, values.persistence === "session" ? "session" : "account");
    },
  }));
}

async function openProviderAuthPanel(ctx: PanelFlowContext, providerId: string): Promise<void> {
  const profile = listProviderProfiles().find((candidate) => candidate.id === providerId);
  if (!profile) return;
  if (!ctx.auth) {
    ctx.presenter.setNotice("Auth session is unavailable in this TUI mode.");
    ctx.render();
    return;
  }
  const locale = ctx.locale();
  const status = ctx.auth.status();
  const accounts = await ctx.auth.listAccounts();
  const sealed = accounts.filter((account) => account.provider === providerId);
  const primary = sealed.find((account) => account.alias === "default") ?? sealed[0];
  const isCurrent = status.provider === providerId
    && (!primary || status.accountAlias === primary.alias);
  const items = [
    ...(primary && !isCurrent
      ? [{
        id: "switch",
        label: locale === "zh" ? "切换到此提供商" : "Switch to this provider",
        description: locale === "zh"
          ? `仅切换生效提供商；保留全部已配置凭证${primary.model ? ` · ${primary.model}` : ""}`
          : `Activate only; keep all sealed credentials${primary.model ? ` · ${primary.model}` : ""}`,
      }]
      : []),
    ...(primary && isCurrent
      ? [{
        id: "current",
        label: locale === "zh" ? "当前已生效" : "Already active",
        description: `${status.model}${status.baseURL ? ` · ${status.baseURL}` : ""}`,
      }]
      : []),
    ...(primary && isCurrent
      ? [{
          id: "configure",
          label: locale === "zh" ? "配置模型（无需重新登录）" : "Configure model (no re-login)",
          description: locale === "zh"
            ? "修改 model / effort / context / max output / 图片能力，不读取密钥"
            : "Change model / effort / context / max output / image capability without reading the secret",
        }]
      : []),
    ...(profile.authSchemes.includes("api-key")
      ? [{
        id: "api-key",
        label: primary
          ? (locale === "zh" ? "重新登录（API key）" : "Re-login (API key)")
          : "API key",
        description: primary
          ? (locale === "zh" ? "覆盖已密封的 key / model / base URL" : "Replace sealed key / model / base URL")
          : `Seal a key for ${profile.displayName}`,
      }]
      : []),
    ...(profile.authSchemes.includes("oauth-device")
      ? [{
        id: "device",
        label: primary
          ? (locale === "zh" ? "重新设备登录" : "Re-run device login")
          : "Device login",
        description: "OAuth device code (Kimi)",
      }]
      : []),
    {
      id: "logout",
      label: locale === "zh" ? "退出并清除此提供商" : "Logout this provider",
      description: primary
        ? (locale === "zh"
          ? `仅清除 ${providerId}；其他提供商保留`
          : `Clear only ${providerId}; keep other providers`)
        : (locale === "zh" ? "尚无密封凭证" : "No sealed credential"),
    },
  ];
  ctx.panels.push(new ListPanel({
    title: profile.displayName,
    hints: "↑↓ navigate · Enter select · Esc back",
    items,
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      if (item.id === "current") {
        ctx.panels.dismiss();
        return;
      }
      if (item.id === "switch" && primary) {
        ctx.panels.closeAll();
        ctx.startUseAccount(providerId, primary.alias, {
          ...(primary.model === undefined ? {} : { model: primary.model }),
          ...(primary.baseURL === undefined ? {} : { baseURL: primary.baseURL }),
        });
        return;
      }
      if (item.id === "configure") {
        void openModelConfigurationPanel(ctx);
        return;
      }
      if (item.id === "api-key") {
        void openApiKeyForm(ctx, providerId, profile, primary);
        return;
      }
      if (item.id === "device") {
        void openDeviceLoginForm(ctx, providerId, profile, primary?.model);
        return;
      }
      if (item.id === "logout") {
        if (!primary) {
          ctx.presenter.setNotice(locale === "zh"
            ? "没有可退出的密封凭证。"
            : "No sealed credential to log out.");
          ctx.render();
          return;
        }
        ctx.panels.closeAll();
        ctx.startLogout(providerId, primary.alias);
      }
    },
  }));
}

async function openDeviceLoginForm(
  ctx: PanelFlowContext,
  providerId: string,
  profile: ProviderProfile,
  sealedModel?: string,
): Promise<void> {
  const locale = ctx.locale();
  const defaultModel = profile.defaultModel ?? "k3";
  const currentModel = ctx.auth?.status().provider === providerId
    ? ctx.auth.status().model
    : undefined;
  const availableModels = profile.modelDiscovery === "openai_compatible" && ctx.auth
    ? await ctx.auth.listAvailableModels()
    : mergeProviderModels(profile, undefined);
  ctx.panels.push(new FormPanel({
    title: locale === "zh"
      ? `设备登录 · ${profile.displayName}`
      : `Device login · ${profile.displayName}`,
    description: locale === "zh"
      ? "OAuth 设备码登录。模型、effort 和上下文窗口会写入 ~/.qi/config.toml。"
      : "OAuth device-code login. Model, effort, and context window are saved to ~/.qi/config.toml.",
    fields: catalogModelFields(
      profile,
      currentModel ?? sealedModel ?? defaultModel,
      ctx.auth?.status(),
      locale,
      availableModels,
    ),
    onChange: catalogLoginFieldChange(profile, availableModels),
    submitLabel: locale === "zh" ? "继续授权" : "Continue",
    onClose: ctx.panels.dismiss,
    onSubmit: (values) => {
      ctx.panels.closeAll();
      const model = (values.model ?? "").trim() || defaultModel;
      const modelEfforts = supportedEffortsForModel(profile, model);
      ctx.startLoginDevice(providerId, {
        model,
        ...(modelEfforts.length === 0 || values.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: values.reasoningEffort }),
        contextWindowTokens: parseLoginContextWindow(values.contextWindowTokens),
      });
    },
  }));
}

async function openApiKeyForm(
  ctx: PanelFlowContext,
  providerId: string,
  profile: ProviderProfile,
  sealed?: { model?: string; baseURL?: string; alias?: string },
): Promise<void> {
  const locale = ctx.locale();
  const defaultModel = sealed?.model ?? profile.defaultModel ?? "";
  const defaultBase = sealed?.baseURL ?? profile.officialBaseURL;
  const isCompatible = providerId === "compatible";
  const availableModels = profile.modelDiscovery === "openai_compatible" && ctx.auth
    ? await ctx.auth.listAvailableModels()
    : mergeProviderModels(profile, undefined);
  const useCatalogModelUi = (profile.models?.length ?? 0) > 0
    || profile.modelDiscovery === "openai_compatible";
  const modelFields = useCatalogModelUi
    ? catalogModelFields(profile, defaultModel, ctx.auth?.status(), locale, availableModels)
    : [{
        id: "model",
        label: "Model",
        placeholder: defaultModel || "model id",
        ...(defaultModel ? { initialValue: defaultModel } : {}),
        required: !defaultModel,
      } satisfies FormField];
  const fields: FormField[] = [
    ...(isCompatible
      ? [{
        id: "name",
        label: locale === "zh" ? "名称" : "Name",
        placeholder: "zhipu",
        ...(sealed?.alias ? { initialValue: sealed.alias } : {}),
        required: true as const,
      }]
      : []),
    { id: "apiKey", label: "API key", placeholder: "paste key", secret: true as const, required: true as const },
    {
      id: "baseURL",
      label: "Base URL",
      placeholder: defaultBase,
      initialValue: defaultBase,
      required: true as const,
    },
    ...modelFields,
  ];
  ctx.panels.push(new FormPanel({
    title: isCompatible
      ? (locale === "zh" ? "登录 · OpenAI 兼容" : "Login · OpenAI Compatible")
      : `Login · ${profile.displayName}`,
    description: isCompatible
      ? (locale === "zh"
        ? "OpenAI 兼容 Chat Completions。名称用于显示与账号别名（如 zhipu）；可保存多套并用 /login use <name> 切换。千问 Token Plan 请用一等 Provider qianwenai。Key 密封；routing 写入 config.toml。"
        : "OpenAI-compatible Chat Completions. Name is the display/account alias (e.g. zhipu); save several and switch with /login use <name>. For Qianwen Token Plan use first-class provider qianwenai. Keys stay sealed; routing is saved to config.toml.")
      : (locale === "zh"
        ? `API key 密封保存在 QI_HOME。Base URL / model / provider${useCatalogModelUi ? " / effort / 上下文窗口" : ""} 写入 ~/.qi/config.toml。`
        : `API keys are sealed under QI_HOME. Base URL / model / provider${useCatalogModelUi ? " / effort / context window" : ""} are saved to ~/.qi/config.toml.`),
    fields,
    ...(useCatalogModelUi ? { onChange: catalogLoginFieldChange(profile, availableModels) } : {}),
    submitLabel: "Authenticate",
    onClose: ctx.panels.dismiss,
    onSubmit: (values) => {
      ctx.panels.closeAll();
      const model = (values.model ?? "").trim() || defaultModel || undefined;
      const baseURL = (values.baseURL ?? "").trim() || defaultBase;
      const alias = (values.name ?? "").trim() || undefined;
      const modelEfforts = model === undefined ? [] : supportedEffortsForModel(profile, model);
      ctx.startLoginApiKey(providerId, values.apiKey ?? "", {
        ...(alias === undefined ? {} : { alias }),
        ...(model === undefined ? {} : { model }),
        baseURL,
        ...(useCatalogModelUi
          ? {
              ...(modelEfforts.length === 0 || values.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: values.reasoningEffort }),
              contextWindowTokens: parseLoginContextWindow(values.contextWindowTokens),
            }
          : {}),
      });
    },
  }));
}

function catalogModelFields(
  profile: ProviderProfile,
  initialModel: string,
  status: ReturnType<AuthSession["status"]> | undefined,
  locale: Locale,
  availableModels: readonly MergedProviderModel[] = mergeProviderModels(profile, undefined),
): FormField[] {
  const activeStatus = status?.provider === profile.id ? status : undefined;
  const model = initialModel || profile.defaultModel || availableModels[0]?.id || "";
  const modelProfile = availableModels.find((candidate) => candidate.id === model)?.profile
    ?? profile.models?.find((candidate) => candidate.id === model);
  const contextWindowTokens = activeStatus?.model === model
    ? activeStatus.contextWindowTokens
    : availableModels.find((candidate) => candidate.id === model)?.contextTokens
      ?? providerModelContextTokens(profile, model);
  const efforts = supportedEffortsForModel(profile, model);
  const effort = (activeStatus?.model === model ? activeStatus.reasoningEffort : undefined)
    ?? modelProfile?.thinking?.defaultEffort
    ?? efforts[0]
    ?? "high";
  return [
    {
      id: "model",
      label: "Model",
      initialValue: model,
      required: true,
      options: [
        ...availableModels.map((candidate) => ({
          value: candidate.id,
          label: candidate.displayName,
          description: `${candidate.id} · ${resolveProviderWireApi(profile, candidate.id)} · ${formatContextWindow(candidate.contextTokens)}${
            candidate.catalogued ? "" : (locale === "zh" ? " · 远程" : " · remote")
          }`,
        })),
        {
          value: "",
          label: locale === "zh" ? "手动输入模型 ID…" : "Enter model ID manually…",
          description: locale === "zh" ? "自定义或未来模型" : "Custom or future model",
          customInput: true,
          placeholder: "model id",
        },
      ],
    },
    ...(efforts.length > 0
      ? [{
          id: "reasoningEffort",
          label: locale === "zh" ? "Thinking effort" : "Thinking effort",
          initialValue: efforts.includes(effort) ? effort : UNSET_REASONING_EFFORT,
          required: false,
          options: effortFieldOptions(locale, efforts),
        } satisfies FormField]
      : []),
    {
      id: "contextWindowTokens",
      label: locale === "zh" ? "上下文窗口（tokens）" : "Context window (tokens)",
      placeholder: String(contextWindowTokens),
      initialValue: String(contextWindowTokens),
      required: true,
    },
  ];
}

function catalogLoginFieldChange(
  profile: ProviderProfile,
  availableModels: readonly MergedProviderModel[] = mergeProviderModels(profile, undefined),
): NonNullable<
  ConstructorParameters<typeof FormPanel>[0]["onChange"]
> {
  const modelById = new Map(availableModels.map((model) => [model.id, model]));
  return (fieldId, value) => {
    if (fieldId !== "model" || !value) return;
    const model = modelById.get(value)?.profile
      ?? profile.models?.find((candidate) => candidate.id === value);
    const efforts = supportedEffortsForModel(profile, value);
    return {
      contextWindowTokens: String(
        modelById.get(value)?.contextTokens ?? providerModelContextTokens(profile, value),
      ),
      ...(efforts.length === 0
        ? {}
        : { reasoningEffort: model?.thinking?.defaultEffort ?? efforts[0]! }),
    };
  };
}

function parseLoginContextWindow(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 8_192 || parsed > 2_000_000) {
    throw new RangeError("Context window must be an integer from 8192 to 2000000 tokens.");
  }
  return parsed;
}

function parseLoginOutputReserve(value: string | undefined, contextWindowTokens: number): number {
  const parsed = Number(value);
  const hardCap = Math.floor(contextWindowTokens / 8);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > hardCap) {
    throw new RangeError(
      `Max output tokens must be an integer from 1 to ${hardCap} (1/8 of the context window).`,
    );
  }
  return parsed;
}

function formatContextWindow(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_048_576).toFixed(tokens % 1_048_576 === 0 ? 0 : 1)}M`
    : `${Math.round(tokens / 1_024)}K`;
}

export function openHelpPanel(ctx: PanelFlowContext, lines: readonly string[]): void {
  openScroll(ctx, "help", lines);
}

function openScroll(ctx: PanelFlowContext, title: string, lines: readonly string[]): void {
  ctx.panels.push(new ScrollPanel({
    title,
    lines,
    maxVisible: maxVisible(ctx.terminalRows),
    hints: ctx.panels.depth > 0
      ? (ctx.locale() === "zh" ? "Esc 返回 · ↑↓ 滚动" : "Esc back · ↑↓ scroll")
      : (ctx.locale() === "zh" ? "Esc / Enter / q 关闭 · ↑↓ 滚动" : "Esc / Enter / q close · ↑↓ scroll"),
    onClose: ctx.panels.dismiss,
  }));
}
