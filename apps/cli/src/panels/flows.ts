import {
  listProviderProfiles,
  providerModelContextTokens,
  type ProviderProfile,
} from "@civaapple/qi-ai";
import type { VerificationCandidate } from "@civaapple/qi-node/tools";
import type { ProcessTaskView } from "@civaapple/qi-agent/kernel";
import type { AuthSession } from "../auth.js";
import {
  defaultUserConfigPath,
  loadUserConfig,
  type CompatibleEndpoint,
  type QiCapabilityConfig,
} from "../config.js";
import { t, type Locale, type MessageKey } from "../i18n.js";
import type { TuiPresenter } from "../presenter.js";
import { formatProviderLabel } from "../provider.js";
import type { ThemeName } from "../theme/index.js";
import type { SessionId } from "@civaapple/qi-protocol";
import type { SessionEntry } from "../session-list.js";
import { FormPanel, type FormField } from "./form-panel.js";
import type { PanelHost } from "./host.js";
import { ListPanel } from "./list-panel.js";
import { MultiSelectPanel } from "./multi-select-panel.js";
import { ScrollPanel } from "./scroll-panel.js";
import {
  NEW_SESSION_ID,
  SessionsPanel,
  sessionEntriesToPanelItems,
} from "./sessions-panel.js";

export const CAPABILITY_IDS = [
  "write",
  "verify",
  "network",
  "execute",
  "background",
  "delegate",
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
  readonly mode: () => string;
  readonly changeMode: (mode: "ask" | "plan" | "agent") => void;
  readonly startLoginDevice: (
    provider: string,
    options?: {
      model?: string;
      reasoningEffort?: string;
      contextWindowTokens?: number;
    },
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
  readonly openInspect: (panel: "overview" | "config" | "context" | "runs" | "steps" | "actions" | "agents" | "skills" | "tasks" | "providers", title: string) => void;
  readonly openHistoryList: (kind: "runs" | "steps" | "actions" | "agents") => void;
  readonly addMount: (path: string) => void;
  readonly removeMount: (mountId: string) => void;
  readonly effectiveCapabilities: () => readonly CapabilityId[];
  readonly saveCapabilities: (capabilities: QiCapabilityConfig) => void;
  readonly applyVerificationSetup: (selected: readonly VerificationCandidate[]) => void;
  readonly installSkill: (source: string, scope: "user" | "workspace") => void;
  readonly listTasks: () => ProcessTaskView[];
  readonly stopTask: (taskId: string) => void;
  readonly listSessions: () => SessionEntry[];
  readonly currentSessionId: () => string;
  readonly workspaceRoot: () => string;
  readonly resumeSession: (sessionId: SessionId) => void;
  readonly startNewSession: () => void;
  readonly render: () => void;
}

function maxVisible(rows: number): number {
  return Math.max(6, rows - 12);
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
      { id: "providers", label: t(locale, "settings.providers"), description: t(locale, "settings.providers.desc") },
      { id: "runs", label: t(locale, "settings.runs"), description: t(locale, "settings.runs.desc") },
      { id: "config", label: t(locale, "settings.config"), description: t(locale, "settings.config.desc") },
      { id: "context", label: t(locale, "settings.context"), description: t(locale, "settings.context.desc") },
      { id: "theme", label: t(locale, "settings.theme"), description: t(locale, "settings.theme.desc") },
      { id: "language", label: t(locale, "settings.language"), description: t(locale, "settings.language.desc") },
      { id: "status", label: t(locale, "settings.status"), description: t(locale, "settings.status.desc") },
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
      if (item.id === "providers") {
        openProvidersPanel(ctx);
        return;
      }
      if (item.id === "runs") {
        openRunsHubPanel(ctx);
        return;
      }
      if (item.id === "theme") {
        openThemePanel(ctx);
        return;
      }
      if (item.id === "language") {
        openLanguagePanel(ctx);
        return;
      }
      openScroll(ctx, `/${item.id}`, ctx.presenter.renderPanel(
        item.id === "status" ? "overview" : item.id as "config" | "context",
      ));
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
    maxVisible: maxVisible(ctx.terminalRows),
    items: [
      {
        id: "status",
        label: locale === "zh" ? "当前状态" : "Current status",
        description: statusLabel,
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
      if (item.id === "compatible") {
        void openCompatiblePanel(ctx);
        return;
      }
      void openProviderAuthPanel(ctx, item.id);
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
          ? "新建名称（如 qianwenai / zhipu）并密封 API key"
          : "Create a name (e.g. qianwenai / zhipu) and seal an API key",
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
        openApiKeyForm(ctx, "compatible", profile);
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
        openApiKeyForm(ctx, "compatible", profile, {
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
      };
      ctx.panels.closeAll();
      ctx.saveCapabilities(capabilities);
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
  }
  return ids;
}

export function openSkillsHubPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  ctx.panels.push(new ListPanel({
    title: t(locale, "skills.title"),
    hints: t(locale, "skills.hints"),
    items: [
      { id: "list", label: t(locale, "skills.list"), description: t(locale, "skills.list.desc") },
      { id: "install", label: t(locale, "skills.install"), description: t(locale, "skills.install.desc") },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      if (item.id === "list") {
        ctx.openInspect("skills", "/skills");
        return;
      }
      openSkillInstallScopePanel(ctx);
    },
  }));
}

function openSkillInstallScopePanel(ctx: PanelFlowContext): void {
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
      openSkillInstallForm(ctx, item.id === "workspace" ? "workspace" : "user");
    },
  }));
}

function openSkillInstallForm(ctx: PanelFlowContext, scope: "user" | "workspace"): void {
  const locale = ctx.locale();
  ctx.panels.push(new FormPanel({
    title: t(locale, "skills.install.form.title"),
    description: t(locale, "skills.install.form.desc"),
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
      ctx.panels.closeAll();
      ctx.installSkill(source, scope);
    },
  }));
}

export function openTasksHubPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  const tasks = ctx.listTasks().sort((left, right) => {
    const leftActive = left.status === "running" ? 0 : left.status === "stopping" ? 1 : 2;
    const rightActive = right.status === "running" ? 0 : right.status === "stopping" ? 1 : 2;
    return leftActive - rightActive || right.startedAt.localeCompare(left.startedAt);
  });
  if (tasks.length === 0) {
    ctx.presenter.setNotice(t(locale, "tasks.empty"));
    ctx.render();
    return;
  }
  ctx.panels.push(new ListPanel({
    title: t(locale, "tasks.title"),
    hints: t(locale, "tasks.hints"),
    items: tasks.map((task) => ({
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

export function openRunsHubPanel(ctx: PanelFlowContext): void {
  const locale = ctx.locale();
  ctx.panels.push(new ListPanel({
    title: t(locale, "runs.title"),
    hints: t(locale, "runs.hints"),
    items: [
      { id: "runs", label: t(locale, "runs.runs"), description: t(locale, "runs.runs.desc") },
      { id: "steps", label: t(locale, "runs.steps"), description: t(locale, "runs.steps.desc") },
      { id: "actions", label: t(locale, "runs.actions"), description: t(locale, "runs.actions.desc") },
      { id: "agents", label: t(locale, "runs.agents"), description: t(locale, "runs.agents.desc") },
    ],
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      ctx.openHistoryList(item.id as "runs" | "steps" | "actions" | "agents");
    },
  }));
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
    title: t(locale, titleKey),
    hints: t(locale, "runs.list.hints"),
    items,
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
    maxVisible: Math.max(3, Math.floor(maxVisible(ctx.terminalRows) / 2)),
    onClose: ctx.panels.dismiss,
    onSelect: (item) => {
      if (item.id === NEW_SESSION_ID || item.isNew) {
        ctx.panels.closeAll();
        ctx.startNewSession();
        return;
      }
      const sessionId = (item.sessionId ?? item.id) as SessionId;
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
      if (item.id === "api-key") {
        openApiKeyForm(ctx, providerId, profile, primary);
        return;
      }
      if (item.id === "device") {
        openDeviceLoginForm(ctx, providerId, profile, primary?.model);
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

function openDeviceLoginForm(
  ctx: PanelFlowContext,
  providerId: string,
  profile: ProviderProfile,
  sealedModel?: string,
): void {
  const locale = ctx.locale();
  const defaultModel = profile.defaultModel ?? "k3";
  const currentModel = ctx.auth?.status().provider === providerId
    ? ctx.auth.status().model
    : undefined;
  ctx.panels.push(new FormPanel({
    title: locale === "zh"
      ? `设备登录 · ${profile.displayName}`
      : `Device login · ${profile.displayName}`,
    description: locale === "zh"
      ? "OAuth 设备码登录。模型、effort 和上下文窗口会写入 ~/.qi/config.toml。"
      : "OAuth device-code login. Model, effort, and context window are saved to ~/.qi/config.toml.",
    fields: kimiModelFields(
      profile,
      currentModel ?? sealedModel ?? defaultModel,
      ctx.auth?.status(),
      locale,
    ),
    onChange: kimiLoginFieldChange(profile),
    submitLabel: locale === "zh" ? "继续授权" : "Continue",
    onClose: ctx.panels.dismiss,
    onSubmit: (values) => {
      ctx.panels.closeAll();
      const model = (values.model ?? "").trim() || defaultModel;
      ctx.startLoginDevice(providerId, {
        model,
        ...(values.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: values.reasoningEffort }),
        contextWindowTokens: parseLoginContextWindow(values.contextWindowTokens),
      });
    },
  }));
}

function openApiKeyForm(
  ctx: PanelFlowContext,
  providerId: string,
  profile: ProviderProfile,
  sealed?: { model?: string; baseURL?: string; alias?: string },
): void {
  const locale = ctx.locale();
  const defaultModel = sealed?.model ?? profile.defaultModel ?? "";
  const defaultBase = sealed?.baseURL ?? profile.officialBaseURL;
  const isCompatible = providerId === "compatible";
  const modelFields = providerId === "kimi"
    ? kimiModelFields(profile, defaultModel, ctx.auth?.status(), locale)
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
        placeholder: "qianwenai",
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
        ? "OpenAI 兼容 Chat Completions。名称用于显示与账号别名（如 qianwenai、zhipu）；可保存多套并用 /login use <name> 切换。Key 密封；routing 写入 config.toml。"
        : "OpenAI-compatible Chat Completions. Name is the display/account alias (e.g. qianwenai, zhipu); save several and switch with /login use <name>. Keys stay sealed; routing is saved to config.toml.")
      : (locale === "zh"
        ? `API key 密封保存在 QI_HOME。Base URL / model / provider${providerId === "kimi" ? " / effort / 上下文窗口" : ""} 写入 ~/.qi/config.toml。`
        : `API keys are sealed under QI_HOME. Base URL / model / provider${providerId === "kimi" ? " / effort / context window" : ""} are saved to ~/.qi/config.toml.`),
    fields,
    ...(providerId === "kimi" ? { onChange: kimiLoginFieldChange(profile) } : {}),
    submitLabel: "Authenticate",
    onClose: ctx.panels.dismiss,
    onSubmit: (values) => {
      ctx.panels.closeAll();
      const model = (values.model ?? "").trim() || defaultModel || undefined;
      const baseURL = (values.baseURL ?? "").trim() || defaultBase;
      const alias = (values.name ?? "").trim() || undefined;
      ctx.startLoginApiKey(providerId, values.apiKey ?? "", {
        ...(alias === undefined ? {} : { alias }),
        ...(model === undefined ? {} : { model }),
        baseURL,
        ...(providerId !== "kimi"
          ? {}
          : {
              reasoningEffort: values.reasoningEffort,
              contextWindowTokens: parseLoginContextWindow(values.contextWindowTokens),
            }),
      });
    },
  }));
}

function kimiModelFields(
  profile: ProviderProfile,
  initialModel: string,
  status: ReturnType<AuthSession["status"]> | undefined,
  locale: Locale,
): FormField[] {
  const activeStatus = status?.provider === "kimi" ? status : undefined;
  const model = initialModel || profile.defaultModel || "k3";
  const modelProfile = profile.models?.find((candidate) => candidate.id === model);
  const contextWindowTokens = activeStatus?.model === model
    ? activeStatus.contextWindowTokens
    : providerModelContextTokens(profile, model);
  const effort = (activeStatus?.model === model ? activeStatus.reasoningEffort : undefined)
    ?? modelProfile?.thinking?.defaultEffort
    ?? "high";
  return [
    {
      id: "model",
      label: "Model",
      initialValue: model,
      required: true,
      options: [
        ...(profile.models ?? []).map((candidate) => ({
          value: candidate.id,
          label: candidate.displayName,
          description: `${candidate.id} · ${formatContextWindow(candidate.contextTokens)}`,
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
    {
      id: "reasoningEffort",
      label: locale === "zh" ? "Thinking effort" : "Thinking effort",
      initialValue: effort,
      required: true,
      options: [
        { value: "low", label: "Low", description: locale === "zh" ? "较快" : "Faster" },
        { value: "high", label: "High", description: locale === "zh" ? "K3 默认（推荐）" : "K3 default (recommended)" },
        { value: "max", label: "Max", description: locale === "zh" ? "最强思考" : "Maximum reasoning" },
        { value: "none", label: "None", description: locale === "zh" ? "关闭思考" : "Disable thinking" },
      ],
    },
    {
      id: "contextWindowTokens",
      label: locale === "zh" ? "上下文窗口（tokens）" : "Context window (tokens)",
      placeholder: String(contextWindowTokens),
      initialValue: String(contextWindowTokens),
      required: true,
    },
  ];
}

function kimiLoginFieldChange(profile: ProviderProfile): NonNullable<
  ConstructorParameters<typeof FormPanel>[0]["onChange"]
> {
  return (fieldId, value) => {
    if (fieldId !== "model" || !value) return;
    const model = profile.models?.find((candidate) => candidate.id === value);
    return {
      contextWindowTokens: String(providerModelContextTokens(profile, value)),
      reasoningEffort: model?.thinking?.defaultEffort ?? "high",
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
