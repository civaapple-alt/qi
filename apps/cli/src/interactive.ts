import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  ProcessTerminal,
  Spacer,
  TUI,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import { dirname, resolve } from "node:path";
import type { SessionEvent, SessionId } from "@civaapple/qi-protocol";
import { nextSessionMode, type RuntimeActivity, type SessionMode } from "@civaapple/qi-agent/loop";
import type { VerificationCandidate } from "@civaapple/qi-node/tools";
import type { AuthSession, AuthSessionStatus } from "./auth.js";
import { parseLoginCommand } from "./auth.js";
import {
  commandHelp,
  parseMountsCommand,
  parseSkillInstallCommand,
  parseTaskStopCommand,
  parseTuiCommand,
  autocompleteSlashCommands,
  tuiCommands,
  type TuiPanel,
} from "./commands.js";
import { defaultUserConfigPath, persistUserLanguage, persistUserTheme, loadUserConfig, findCompatibleEndpoint, removeCompatibleEndpoint, type QiCapabilityConfig } from "./config.js";
import { ComposerComponent } from "./composer.js";
import { FollowUpQueue } from "./follow-ups.js";
import { FollowUpsComponent } from "./follow-ups-view.js";
import { persistLoginProviderDefaults } from "./login-persist.js";
import { formatProviderLabel } from "./provider.js";
import { t, type Locale } from "./i18n.js";
import { padToDisplayWidth, splitKeepRight } from "./layout.js";
import {
  FormPanel,
  ListPanel,
  capabilityIdsFromLaunchLabels,
  openHelpPanel,
  openHistoryListPanel,
  openModePanel,
  openMountsPanel,
  openPermissionsPanel,
  openProvidersPanel,
  openRunsHubPanel,
  openSessionsPanel,
  openSettingsPanel,
  openSkillsHubPanel,
  openTasksHubPanel,
  openVerifySetupPanel,
  PanelHost,
  ScrollPanel,
  type PanelFlowContext,
} from "./panels/index.js";
import { buildSessionEntries } from "./session-list.js";
import { eventAffectsTranscript } from "./paint.js";
import { TuiPresenter, USER_MESSAGE_PREFIX } from "./presenter.js";
import type { TuiRuntime } from "./runtime.js";
import { applyTheme, theme, type ThemeName } from "./theme/index.js";

export type InteractiveExit =
  | { kind: "quit" }
  | { kind: "resume"; sessionId: SessionId }
  | { kind: "new-session" };

export class InteractiveTui {
  readonly #runtime: TuiRuntime;
  readonly #presenter: TuiPresenter;
  readonly #auth: AuthSession | undefined;
  readonly #terminal: Terminal;
  readonly #tui: TUI;
  readonly #dashboard: DashboardComponent;
  readonly #working: WorkingComponent;
  readonly #followUpsPanel: FollowUpsComponent;
  readonly #footer: FooterComponent;
  readonly #editor: Editor;
  readonly #composer: ComposerComponent;
  readonly #editorContainer: Container;
  readonly #panels: PanelHost;
  readonly #followUps = new FollowUpQueue();
  readonly #active = new Set<Promise<void>>();
  #closing = false;
  #exit: InteractiveExit = { kind: "quit" };
  #resolveClosed: ((exit: InteractiveExit) => void) | undefined;
  #activityTimer: ReturnType<typeof setTimeout> | undefined;
  #workingTimer: ReturnType<typeof setInterval> | undefined;
  #noticeTimer: ReturnType<typeof setTimeout> | undefined;
  #noticeTimerExpiresAt: number | undefined;
  /** Last Plan review key offered as a panel; Esc dismisses until the revision changes. */
  #planReviewKey: string | undefined;
  /** Last next-Run Question id offered as a panel; Esc dismisses until it changes. */
  #nextRunKey: string | undefined;
  /** Pending PATH_GRANT_REQUIRED directories awaiting a human allow/deny panel. */
  #pendingPathGrants: string[] = [];
  #pathGrantKey: string | undefined;
  /** Manual or config theme preference; auto-detect must not override non-auto choices. */
  #themePreference: ThemeName = "auto";
  #terminalScheme: "dark" | "light" | undefined;

  constructor(
    runtime: TuiRuntime,
    presenter: TuiPresenter,
    options: { terminal?: Terminal; auth?: AuthSession } = {},
  ) {
    const terminal = options.terminal ?? new ProcessTerminal();
    this.#themePreference = presenter.launch.theme ?? "auto";
    if (this.#themePreference === "dark" || this.#themePreference === "light") {
      applyTheme(this.#themePreference);
    } else {
      applyTheme("auto");
    }
    this.#runtime = runtime;
    this.#presenter = presenter;
    this.#auth = options.auth;
    this.#terminal = terminal;
    // Hide the terminal caret: Editor already paints a reverse-video caret, and a visible
    // hardware cursor blinks as a second vertical bar (especially on Windows Terminal).
    // CURSOR_MARKER still positions the (hidden) caret for CJK IME candidate windows.
    this.#tui = new TUI(this.#terminal, false);
    this.#presenter.update(runtime.events(), runtime.view());
    this.#presenter.setSkills(runtime.skillCatalog());
    this.#presenter.setChildViewLookup((childSessionId) => runtime.childView(childSessionId as SessionId));
    this.#dashboard = new DashboardComponent(presenter);
    this.#footer = new FooterComponent(runtime, presenter);
    this.#editor = new Editor(this.#tui, theme.editorTheme(), { paddingX: 1, autocompleteMaxVisible: 10 });
    this.#composer = new ComposerComponent(this.#editor, () => this.#composerPlaceholder());
    this.#editorContainer = new Container();
    this.#editorContainer.addChild(this.#composer);
    this.#panels = new PanelHost(this.#tui, this.#editorContainer, this.#composer, () => this.#render());
    this.#working = new WorkingComponent(
      runtime,
      presenter,
      this.#editor,
      () => this.#panels.open,
    );
    this.#followUpsPanel = new FollowUpsComponent(this.#followUps, () => this.#presenter.locale());
    this.#syncAutocomplete();
    this.#editor.onSubmit = (input) => this.#handleInput(input);
    // Composer keystrokes must not rebuild the chat transcript (grows with Runs/Steps).
    this.#editor.onChange = () => this.#renderChrome();
    this.#tui.addChild(this.#dashboard);
    this.#tui.addChild(new Spacer(1));
    this.#tui.addChild(this.#working);
    this.#tui.addChild(this.#followUpsPanel);
    this.#tui.addChild(this.#editorContainer);
    this.#tui.addChild(this.#footer);
    this.#tui.setFocus(this.#composer);
    void this.#detectTheme();
    this.#tui.addInputListener((data) => {
      if (this.#panels.open) {
        // Inspect/choice panels must never cancel an active Run (incl. in-flight Subagents).
        if (matchesKey(data, "ctrl+c")) {
          this.#panels.closeAll();
          return { consume: true };
        }
        if (matchesKey(data, Key.escape)) {
          // Forward Esc to the panel (search clear / dismiss), then consume so it cannot
          // reach the Editor after remount or be mistaken for Run cancellation.
          this.#panels.deliverInput(data);
          return { consume: true };
        }
        return undefined;
      }
      if (matchesKey(data, "ctrl+o")) {
        this.#presenter.setNotice(this.#presenter.toggleExpand());
        this.#render();
        return { consume: true };
      }
      if (matchesKey(data, "shift+tab")) {
        this.#cycleMode();
        return { consume: true };
      }
      if (this.#handleFollowUpKeys(data)) return { consume: true };
      if (this.#editor.getText().length === 0 && !this.#runtime.active && this.#active.size === 0) {
        if (matchesKey(data, "1") || matchesKey(data, "2") || matchesKey(data, "3")) {
          const digit = matchesKey(data, "1") ? "1" : matchesKey(data, "2") ? "2" : "3";
          if (this.#handlePendingCardDigit(digit)) return { consume: true };
        }
      }
      if (!matchesKey(data, "ctrl+c")) return undefined;
      if (this.#runtime.active) {
        this.#runtime.cancel("User cancelled the Run");
        this.#presenter.setNotice("Cancellation requested; waiting for a safe settlement boundary.", "run");
        this.#render();
        return { consume: true };
      }
      if (this.#editor.getText().length > 0) {
        this.#editor.setText("");
        this.#presenter.setNotice(undefined);
        this.#render();
        return { consume: true };
      }
      void this.close();
      return { consume: true };
    });
  }

  async #detectTheme(): Promise<void> {
    try {
      const scheme = await this.#tui.queryTerminalColorScheme({ timeoutMs: 250 });
      if (scheme === "light" || scheme === "dark") this.#terminalScheme = scheme;
      // Never clobber an explicit dark/light choice (including late answers after the user picked).
      if (this.#themePreference !== "auto") return;
      if (scheme === "light" || scheme === "dark") applyTheme("auto", scheme);
      this.#render();
    } catch {
      // Keep dark default when the terminal does not report a scheme.
    }
  }

  #changeTheme(name: ThemeName): void {
    this.#themePreference = name;
    if (name === "auto") {
      applyTheme("auto", this.#terminalScheme);
      void this.#refreshTerminalScheme();
    } else {
      applyTheme(name);
    }
    this.#presenter.launch = { ...this.#presenter.launch, theme: name };
    this.#render();
    const configPath = this.#presenter.launch.configPath ?? defaultUserConfigPath();
    this.#startManagementTask(async () => {
      await persistUserTheme(name, configPath);
      this.#presenter.setNotice(t(this.#presenter.locale(), "theme.changed", { theme: name }));
    }, "Theme");
  }

  async #refreshTerminalScheme(): Promise<void> {
    try {
      const scheme = await this.#tui.queryTerminalColorScheme({ timeoutMs: 250 });
      if (scheme !== "light" && scheme !== "dark") return;
      this.#terminalScheme = scheme;
      if (this.#themePreference === "auto") {
        applyTheme("auto", scheme);
        this.#render();
      }
    } catch {
      // Keep current palette when the terminal does not answer.
    }
  }

  onEvent(event: SessionEvent): void {
    // Parent projection only; child Sessions stay isolated (tokens read via childView lookup on render).
    if (event.type === "action.failed" && event.data.errorCode === "PATH_GRANT_REQUIRED") {
      const path = extractGrantPath(event.data.modelOutput);
      if (path) this.#queuePathGrant(path);
    }
    this.#presenter.update(this.#runtime.events(), this.#runtime.view());
    this.#maybeOfferPathGrant();
    // Authority / safety / context.compiled update Working strip only — keep the transcript cached.
    if (eventAffectsTranscript(event)) this.#render();
    else this.#renderChrome();
  }

  onActivity(activity: RuntimeActivity): void {
    this.#presenter.applyActivity(activity);
    if (this.#activityTimer) return;
    // Streaming deltas live in the Running strip; do not rebuild tool cards every 50ms.
    this.#activityTimer = setTimeout(() => {
      this.#activityTimer = undefined;
      this.#renderChrome();
    }, 50);
  }

  #syncWorkingTick(): void {
    if (this.#runtime.active) {
      if (this.#workingTimer) return;
      // Spinner / tokens strip only — do not invalidate the transcript every 160ms.
      this.#workingTimer = setInterval(() => this.#renderChrome(), 160);
      return;
    }
    if (this.#workingTimer) {
      clearInterval(this.#workingTimer);
      this.#workingTimer = undefined;
    }
  }

  async run(): Promise<InteractiveExit> {
    this.#terminal.setTitle(`Qi · ${this.#presenter.launch.workspaceRoot}`);
    this.#syncNoticeTimer();
    this.#tui.start();
    this.#maybeOfferPendingGates();
    return await new Promise<InteractiveExit>((resolve) => { this.#resolveClosed = resolve; });
  }

  async close(exit: InteractiveExit = { kind: "quit" }): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#exit = exit;
    this.#runtime.cancel("TUI closed");
    if (this.#activityTimer) clearTimeout(this.#activityTimer);
    if (this.#workingTimer) clearInterval(this.#workingTimer);
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    await Promise.allSettled(this.#active);
    this.#tui.stop();
    this.#resolveClosed?.(this.#exit);
  }

  #handleInput(raw: string): void {
    const input = raw.trim();
    if (!input) return;
    this.#editor.addToHistory(raw);
    this.#editor.setText("");
    // A notice describes the interaction that just finished. Retire it as soon as
    // the operator begins the next one; that interaction may publish a fresh notice.
    this.#presenter.setNotice(undefined);
    if (this.#followUps.editing) {
      this.#followUps.commitEdit(input);
      this.#followUps.clearSelection();
      this.#presenter.setNotice(undefined);
      this.#render();
      this.#maybeDrainFollowUps();
      return;
    }
    const command = parseTuiCommand(input);
    if (command) {
      this.#handleCommand(command.name, command.argument);
      return;
    }
    if (this.#runtime.active) {
      this.#followUps.enqueue(input);
      this.#presenter.setNotice(t(this.#presenter.locale(), "followups.queued"));
      this.#render();
      return;
    }
    if (this.#active.size > 0) {
      this.#presenter.setNotice("A TUI management operation is active; wait for it to finish.");
      this.#render();
      return;
    }
    const view = this.#runtime.view();
    const pendingReview = view?.pendingReview?.status === "pending";
    if (pendingReview && looksLikeStartPlan(input)) {
      this.#handlePlanControl("accept");
      return;
    }
    const pendingNext = view?.pendingQuestion?.status === "pending" && view.pendingQuestion.kind === "next_run";
    if (pendingNext) {
      const nextChoice = looksLikeNextRunChoice(input);
      if (nextChoice) {
        this.#answerNextRunChoice(nextChoice);
        return;
      }
      // Esc dismissed the panel: ordinary chat is fine; reopen with /next.
    }
    // Plan Q&A / supplements stay in Plan mode; plan_document stays gated until revise or start.
    this.#startUserRun(input);
  }

  #handleFollowUpKeys(data: string): boolean {
    const locale = this.#presenter.locale();
    const editorEmpty = this.#editor.getText().length === 0;

    if (matchesKey(data, Key.escape)) {
      if (this.#followUps.editing) {
        this.#followUps.cancelEdit();
        this.#editor.setText("");
        this.#followUps.clearSelection();
        this.#render();
        return true;
      }
      if (this.#followUps.selectedIndex >= 0) {
        this.#followUps.removeSelected();
        this.#presenter.setNotice(t(locale, "followups.cancelled"));
        this.#render();
        return true;
      }
      return false;
    }

    if ((matchesKey(data, Key.enter) || matchesKey(data, "return")) && editorEmpty && !this.#followUps.editing) {
      if (this.#followUps.selectedIndex >= 0) {
        this.#followUps.moveSelectedToFront();
        this.#followUps.clearSelection();
        this.#presenter.setNotice(t(locale, "followups.sendNow"));
        this.#render();
        this.#maybeDrainFollowUps();
        return true;
      }
      return false;
    }

    if (!editorEmpty || this.#followUps.editing) return false;
    if (this.#followUps.length === 0 && !this.#runtime.active) return false;

    if (matchesKey(data, Key.up) || matchesKey(data, "up")) {
      if (this.#followUps.length === 0) return false;
      if (this.#followUps.selectedIndex < 0) {
        const text = this.#followUps.beginEdit();
        this.#editor.setText(text ?? "");
      } else {
        this.#followUps.selectPrev();
        const text = this.#followUps.beginEdit(this.#followUps.selectedIndex);
        this.#editor.setText(text ?? "");
      }
      this.#render();
      return true;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, "down")) {
      if (this.#followUps.length === 0 || this.#followUps.selectedIndex < 0) return false;
      this.#followUps.selectNext();
      const text = this.#followUps.beginEdit(this.#followUps.selectedIndex);
      this.#editor.setText(text ?? "");
      this.#render();
      return true;
    }

    return false;
  }

  /** After a Run settles, start the next queued follow-up when no human gate is pending. */
  #maybeDrainFollowUps(): void {
    if (this.#runtime.active || this.#active.size > 0 || this.#panels.open) return;
    if (this.#followUps.editing || this.#followUps.length === 0) return;
    const view = this.#runtime.view();
    if (view?.pendingReview?.status === "pending") return;
    if (view?.pendingQuestion?.status === "pending") return;
    const next = this.#followUps.dequeue();
    if (!next) return;
    this.#followUps.clearSelection();
    this.#startUserRun(next.text);
  }

  #startUserRun(input: string): void {
    this.#startTurn(() => this.#runtime.run(input));
  }

  #startTriggeredRun(runId: import("@civaapple/qi-protocol").RunId, input: string): void {
    this.#startTurn(() => this.#runtime.runTriggered(runId, input));
  }

  #startTurn(operation: () => Promise<{ status: string }>): void {
    this.#terminal.setProgress(true);
    const task = operation()
      .then((result) => {
        if (result.status === "completed") {
          // Keep operator info notices (login, permissions, …) across the next Run.
          this.#presenter.clearRunNotice();
          return;
        }
        this.#presenter.update(this.#runtime.events(), this.#runtime.view());
        const guidance = this.#presenter.selectedRunFailureGuidance();
        if (guidance) {
          this.#presenter.setNotice(guidance, "run");
          return;
        }
        const detail = this.#presenter.selectedRunFailureDetail();
        this.#presenter.setNotice(
          detail ? `Run ${result.status}: ${detail}` : `Run ${result.status}.`,
          "run",
        );
      })
      .catch((error: unknown) => {
        this.#presenter.setNotice(`Run error: ${message(error)}`, "run");
      })
      .finally(() => {
        this.#active.delete(task);
        this.#terminal.setProgress(false);
        this.#presenter.update(this.#runtime.events(), this.#runtime.view());
        this.#render();
        this.#maybeOfferPendingGates();
        this.#maybeOfferPathGrant();
        this.#maybeDrainFollowUps();
      });
    this.#active.add(task);
    this.#render();
  }

  #handlePendingCardDigit(digit: "1" | "2" | "3"): boolean {
    const view = this.#runtime.view();
    // Digits are only for Plan Review (open/focus the panel). Next Run has no digit shortcuts.
    if (view?.pendingReview?.status === "pending") {
      this.#openPlanReviewPanel(digit === "1" ? "start" : digit === "2" ? "revise" : "reject");
      return true;
    }
    return false;
  }

  #maybeOfferPendingGates(): void {
    this.#maybeOfferPlanReview();
    this.#maybeOfferNextRun();
    this.#maybeOfferPathGrant();
  }

  #queuePathGrant(path: string): void {
    const absolute = resolve(grantDirectory(path));
    if (this.#runtime.mounts().some((mount) => resolve(mount.path) === absolute)) return;
    if (!this.#pendingPathGrants.includes(absolute)) this.#pendingPathGrants.push(absolute);
  }

  #maybeOfferPathGrant(): void {
    // Allow during an active Run so the next Action can see a mid-Run grant via getMounts.
    if (this.#active.size > 0 || this.#panels.open) return;
    const next = this.#pendingPathGrants[0];
    if (!next) {
      this.#pathGrantKey = undefined;
      return;
    }
    if (this.#pathGrantKey === next) return;
    this.#pathGrantKey = next;
    this.#openPathGrantPanel(next);
  }

  #openPathGrantPanel(path: string): void {
    if (this.#panels.open) this.#panels.closeAll();
    this.#panels.push(new ListPanel({
      title: "Authorize directory",
      hints: `↑↓ select · Enter confirm · Esc deny · ${oneLineHint(path)}`,
      items: [
        {
          id: "allow",
          label: "允许只读挂载",
          description: "写入 project config.toml，路径用 mount:<id>/…",
        },
        {
          id: "deny",
          label: "拒绝",
          description: "不挂载；Agent 继续看到 PATH_GRANT_REQUIRED",
        },
      ],
      onClose: () => {
        this.#pendingPathGrants = this.#pendingPathGrants.filter((candidate) => candidate !== path);
        this.#pathGrantKey = undefined;
        this.#presenter.setNotice(`Denied mount for ${path}`);
        this.#panels.dismiss();
        this.#maybeOfferPathGrant();
        this.#render();
      },
      onSelect: (item) => {
        this.#panels.closeAll();
        void this.#settlePathGrant(path, item.id === "allow");
      },
    }));
    this.#render();
  }

  async #settlePathGrant(path: string, allow: boolean): Promise<void> {
    this.#pendingPathGrants = this.#pendingPathGrants.filter((candidate) => candidate !== path);
    this.#pathGrantKey = undefined;
    if (!allow) {
      this.#presenter.setNotice(`Denied mount for ${path}`);
      this.#maybeOfferPathGrant();
      this.#render();
      return;
    }
    try {
      const mount = await this.#runtime.addMount(path, "grant");
      this.#presenter.setNotice(`Mounted read-only ${mount.id} → ${mount.path}`);
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
    } catch (error) {
      this.#presenter.setNotice(message(error));
    }
    this.#maybeOfferPathGrant();
    this.#render();
  }

  #maybeOfferPlanReview(): void {
    const pending = this.#runtime.view()?.pendingReview;
    if (!pending || pending.status !== "pending") {
      this.#planReviewKey = undefined;
      return;
    }
    if (this.#runtime.active || this.#active.size > 0 || this.#panels.open) return;
    const key = `${pending.planId}:${pending.revision}`;
    if (this.#planReviewKey === key) return;
    this.#planReviewKey = key;
    this.#openPlanReviewPanel();
  }

  #maybeOfferNextRun(): void {
    const pending = this.#runtime.view()?.pendingQuestion;
    if (!pending || pending.status !== "pending" || pending.kind !== "next_run") {
      this.#nextRunKey = undefined;
      return;
    }
    if (this.#runtime.active || this.#active.size > 0 || this.#panels.open) return;
    if (this.#nextRunKey === pending.questionId) return;
    this.#nextRunKey = pending.questionId;
    this.#openNextRunPanel();
  }

  #openNextRunPanel(): void {
    const pending = this.#runtime.view()?.pendingQuestion;
    if (!pending || pending.status !== "pending" || pending.kind !== "next_run") return;
    if (this.#panels.open) this.#panels.closeAll();
    const prompt = pending.prompt?.trim() || "Start the next Plan item?";
    this.#panels.push(new ListPanel({
      title: "Next Run",
      hints: `↑↓ select · Enter confirm · Esc chat · ${oneLineHint(prompt)}`,
      items: [
        {
          id: "continue",
          label: "继续下一项",
          description: "启动下一个未完成的 Plan item（一项一 Run）",
        },
        {
          id: "stop",
          label: "先停在这里",
          description: "关闭本次确认；之后用 /next 可重新打开再继续",
        },
        {
          id: "plan",
          label: "回到 Plan",
          description: "改计划 → 新审阅 → 开始实现（从第一个未完成项接着跑）",
        },
      ],
      onClose: this.#panels.dismiss,
      onSelect: (item) => {
        this.#panels.closeAll();
        this.#answerNextRunChoice(
          item.id === "continue" ? "continue" : item.id === "stop" ? "stop" : "return_to_plan",
        );
      },
    }));
    this.#render();
  }

  /** Open the Next Run panel; after stop, re-ask the Question when incomplete items remain. */
  #ensureNextRunPanel(): boolean {
    const pending = this.#runtime.view()?.pendingQuestion;
    if (pending?.status === "pending" && pending.kind === "next_run") {
      this.#openNextRunPanel();
      return true;
    }
    try {
      if (!this.#runtime.reaskNextRun()) return false;
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
      this.#nextRunKey = undefined;
      this.#openNextRunPanel();
      return true;
    } catch (error) {
      this.#presenter.setNotice(message(error));
      this.#render();
      return false;
    }
  }

  #answerNextRunChoice(choice: "continue" | "stop" | "return_to_plan"): void {
    if (this.#runtime.active || this.#active.size > 0) {
      this.#presenter.setNotice("Cannot answer the next-Run Question while work is active.");
      this.#render();
      return;
    }
    try {
      const answered = this.#runtime.answerNextRun(choice);
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
      this.#nextRunKey = undefined;
      if (answered.runId && answered.input) {
        this.#presenter.setNotice("Starting the next Plan item Run.");
        this.#startTriggeredRun(answered.runId, answered.input);
        return;
      }
      this.#presenter.setNotice(
        choice === "return_to_plan"
          ? "Returned to Plan · 改完后走审阅 → 开始实现；未改计划则 /mode agent 后 /next。"
          : "Stopped · 之后用 /next 可重新打开 Next Run 再继续。",
      );
    } catch (error) {
      this.#presenter.setNotice(message(error));
    }
    this.#render();
    this.#maybeDrainFollowUps();
  }

  #openPlanReviewPanel(focusId?: "start" | "revise" | "reject"): void {
    if (this.#runtime.view()?.pendingReview?.status !== "pending") return;
    if (this.#panels.open) this.#panels.closeAll();
    const items = [
      {
        id: "start",
        label: "开始实现",
        description: "接受计划并启动第一项 Agent Run（一项一 Run）",
        current: focusId === "start",
      },
      {
        id: "revise",
        label: "修改计划",
        description: "填写修改要求后更新 plan_document，仍停留在 Plan",
        current: focusId === "revise",
      },
      {
        id: "reject",
        label: "拒绝计划",
        description: "可填拒绝原因；有要求时按修改流程重写计划，否则关闭审阅",
        current: focusId === "reject",
      },
    ];
    // Prefer focused row when opened via digit shortcut.
    const ordered = focusId
      ? [...items.filter((item) => item.id === focusId), ...items.filter((item) => item.id !== focusId)]
      : items;
    this.#panels.push(new ListPanel({
      title: "Plan Review",
      hints: "↑↓ select · Enter confirm · Esc discuss in chat",
      items: ordered,
      onClose: this.#panels.dismiss,
      onSelect: (item) => {
        if (item.id === "start") {
          this.#panels.closeAll();
          this.#handlePlanControl("accept");
          return;
        }
        this.#openPlanFeedbackForm(item.id === "revise" ? "revise" : "reject");
      },
    }));
    this.#render();
  }

  #openPlanFeedbackForm(kind: "revise" | "reject"): void {
    this.#panels.push(new FormPanel({
      title: kind === "revise" ? "修改计划" : "拒绝计划",
      description: kind === "revise"
        ? "说明要改什么；提交后会解除审阅并在 Plan 模式更新 plan_document。"
        : "可填写原因或改写要求。有内容则按修改流程更新计划；留空则仅关闭审阅。",
      fields: [
        {
          id: "feedback",
          label: kind === "revise" ? "修改要求" : "原因或改写要求",
          placeholder: kind === "revise" ? "例如：把第三项拆成两步…" : "可选",
          required: kind === "revise",
        },
      ],
      submitLabel: kind === "revise" ? "更新计划" : "确认",
      onClose: this.#panels.dismiss,
      onSubmit: (values) => {
        const feedback = values.feedback?.trim() || undefined;
        this.#panels.closeAll();
        if (kind === "reject" && !feedback) {
          this.#handlePlanControl("reject");
          return;
        }
        // Feedback path always revises so the model may write a new plan_document.
        this.#handlePlanControl(feedback ? `revise ${feedback}` : "revise");
      },
    }));
    this.#render();
  }

  #handlePlanControl(argument: string): void {
    const trimmed = argument.trim().replace(/^\+\s*/, "");
    if (!trimmed) {
      this.#showPlanOrOptions();
      return;
    }
    const separator = trimmed.search(/\s/);
    const verb = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
    const feedback = separator < 0 ? undefined : trimmed.slice(separator).trim() || undefined;
    if (verb === "accept" || verb === "start" || verb === "revise" || verb === "reject") {
      if (this.#runtime.active || this.#active.size > 0) {
        this.#presenter.setNotice("Cannot settle Plan review while work is active.");
        this.#render();
        return;
      }
      try {
        if (verb === "accept" || verb === "start") {
          this.#panels.closeAll();
          const accepted = this.#runtime.acceptPlan();
          this.#presenter.update(this.#runtime.events(), this.#runtime.view());
          this.#planReviewKey = undefined;
          this.#presenter.setNotice("Plan accepted · starting the first item Run.");
          this.#startTriggeredRun(accepted.runId, accepted.input);
          return;
        }
        if (verb === "revise") {
          this.#runtime.revisePlan(feedback);
          this.#presenter.update(this.#runtime.events(), this.#runtime.view());
          this.#planReviewKey = undefined;
          this.#panels.closeAll();
          const prompt = feedback?.trim()
            || "请根据审阅反馈更新 plan_document：保持稳定的 planItemId，写完后再次请求 Plan 审阅。";
          this.#presenter.setNotice("Revising Plan · updating plan_document…");
          this.#startUserRun(prompt);
          return;
        }
        this.#runtime.rejectPlan(feedback);
        this.#presenter.update(this.#runtime.events(), this.#runtime.view());
        this.#planReviewKey = undefined;
        this.#panels.closeAll();
        this.#presenter.setNotice("Plan review rejected.");
      } catch (error) {
        this.#presenter.setNotice(message(error));
      }
      this.#render();
      this.#maybeDrainFollowUps();
      return;
    }
    this.#startPlanFromPrompt(trimmed);
  }

  #showPlanOrOptions(): void {
    if (this.#runtime.view()?.pendingReview?.status === "pending") {
      this.#planReviewKey = undefined;
      this.#openPlanReviewPanel();
      return;
    }
    this.#openInspectPanel("plan", "/plan");
  }

  #startPlanFromPrompt(prompt: string): void {
    if (this.#runtime.active || this.#active.size > 0) {
      this.#presenter.setNotice("Cannot start a Plan while work is active.");
      this.#render();
      return;
    }
    const view = this.#runtime.view();
    if (view?.pendingReview?.status === "pending") {
      this.#presenter.setNotice(
        "A Plan review is pending · use /plan accept|revise|reject, or discuss in chat.",
      );
      this.#planReviewKey = undefined;
      this.#openPlanReviewPanel();
      return;
    }
    if (view?.pendingQuestion?.status === "pending") {
      this.#presenter.setNotice("Settle the pending Next Run Question before starting a new Plan.");
      this.#render();
      return;
    }
    try {
      if (this.#runtime.mode() !== "plan") {
        this.#runtime.changeMode("plan", "User set /plan <prompt>");
        this.#presenter.update(this.#runtime.events(), this.#runtime.view());
      }
      this.#presenter.setNotice("Planning…");
      this.#startUserRun(prompt);
    } catch (error) {
      this.#presenter.setNotice(message(error));
      this.#render();
    }
  }

  #handleAskCommand(argument: string): void {
    const prompt = argument.trim().replace(/^\+\s*/, "");
    if (this.#runtime.active || this.#active.size > 0) {
      this.#presenter.setNotice("Cannot change mode while work is active.");
      this.#render();
      return;
    }
    const view = this.#runtime.view();
    if (view?.pendingReview?.status === "pending" || view?.pendingQuestion?.status === "pending") {
      this.#presenter.setNotice("Settle the pending Plan review or next-Run Question before changing mode.");
      this.#render();
      return;
    }
    try {
      if (prompt) {
        if (this.#runtime.mode() !== "ask") {
          this.#runtime.changeMode("ask", "User set /ask <prompt>");
          this.#presenter.update(this.#runtime.events(), this.#runtime.view());
        }
        this.#presenter.setNotice(undefined);
        this.#startUserRun(prompt);
        return;
      }
      // Toggle: leave Ask → Agent; enter Ask from any other mode.
      const next: SessionMode = this.#runtime.mode() === "ask" ? "agent" : "ask";
      this.#runtime.changeMode(next, next === "ask" ? "User set /ask" : "User toggled /ask off");
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
      this.#presenter.setNotice(undefined);
    } catch (error) {
      this.#presenter.setNotice(message(error));
    }
    this.#render();
  }

  #cycleMode(): void {
    if (this.#runtime.active || this.#active.size > 0) {
      this.#presenter.setNotice("Cannot change mode while work is active.");
      this.#render();
      return;
    }
    const view = this.#runtime.view();
    if (view?.pendingReview?.status === "pending" || view?.pendingQuestion?.status === "pending") {
      this.#presenter.setNotice("Settle the pending Plan review or next-Run Question before changing mode.");
      this.#render();
      return;
    }
    try {
      const next = nextSessionMode(this.#runtime.mode());
      this.#runtime.changeMode(next, "Shift+Tab mode cycle");
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
      // Mode is already visible in the statusline; avoid a top-of-transcript notice.
      this.#presenter.setNotice(undefined);
    } catch (error) {
      this.#presenter.setNotice(message(error));
    }
    this.#render();
  }

  #openScrollPanel(title: string, lines: readonly string[]): void {
    this.#panels.push(new ScrollPanel({
      title,
      lines,
      maxVisible: Math.max(8, (this.#terminal.rows ?? 40) - 12),
      hints: this.#panels.depth > 0
        ? "Esc back · ↑↓ scroll"
        : "Esc / Enter / q close · ↑↓ scroll",
      onClose: this.#panels.dismiss,
    }));
  }

  #openInspectPanel(panel: TuiPanel, title?: string): void {
    this.#openScrollPanel(title ?? `/${panel}`, this.#presenter.renderPanel(panel));
  }

  #syncAutocomplete(): void {
    this.#editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [...autocompleteSlashCommands(this.#presenter.locale())],
        this.#presenter.launch.workspaceRoot,
      ),
    );
  }

  #changeLocale(locale: Locale): void {
    this.#presenter.setLocale(locale);
    this.#syncAutocomplete();
    const configPath = this.#presenter.launch.configPath ?? defaultUserConfigPath();
    this.#startManagementTask(async () => {
      await persistUserLanguage(locale, configPath);
      this.#presenter.setNotice(t(locale, "language.changed", { locale }));
    }, "Language");
  }

  #saveCapabilities(capabilities: QiCapabilityConfig): void {
    if (this.#runtime.active) {
      this.#presenter.setNotice("Cannot change capabilities while a Run is active.");
      this.#render();
      return;
    }
    this.#startManagementTask(async () => {
      const applied = await this.#runtime.applyCapabilities(capabilities);
      const { verification: _previousVerification, ...launchRest } = this.#presenter.launch;
      this.#presenter.launch = {
        ...launchRest,
        capabilities: [...applied.labels],
        shell: this.#runtime.shellProfiles,
        ...(this.#runtime.verificationManifest === undefined
          ? {}
          : { verification: this.#runtime.verificationManifest }),
      };
      const enabled = applied.labels.join(", ");
      this.#presenter.setNotice(
        t(this.#presenter.locale(), "permissions.saved", {
          capabilities: enabled || t(this.#presenter.locale(), "permissions.saved.none"),
        }),
      );
    }, "Permissions");
  }

  #installSkill(source: string, scope: "user" | "workspace"): void {
    if (this.#runtime.active) {
      this.#presenter.setNotice("Cannot install a Skill while a Run is active.");
      this.#render();
      return;
    }
    const trimmed = source.trim();
    if (!trimmed) {
      this.#presenter.setNotice(t(this.#presenter.locale(), "skills.install.form.empty"));
      this.#render();
      return;
    }
    this.#startSkillTask(async () => {
      const installed = await this.#runtime.installSkill(trimmed, scope);
      this.#presenter.setSkills(this.#runtime.skillCatalog());
      this.#presenter.setNotice(
        `Installed ${installed.name} ${installed.version} in ${installed.scope} scope.`,
      );
      this.#openInspectPanel("skills", "/skills");
    });
  }

  #installSkillFromArgument(argument: string): void {
    try {
      const request = parseSkillInstallCommand(argument);
      this.#installSkill(request.source, request.scope);
    } catch (error) {
      this.#presenter.setNotice(message(error));
      this.#render();
    }
  }

  #stopTaskFromArgument(argument: string, reopenTaskPicker = false): void {
    try {
      const token = parseTaskStopCommand(argument);
      const tasks = this.#runtime.tasks();
      const numeric = /^\d+$/.test(token) ? tasks[Number(token) - 1]?.taskId : undefined;
      const taskId = numeric ?? token;
      this.#startManagementTask(async () => {
        await this.#runtime.stopTask(taskId);
        this.#presenter.update(this.#runtime.events(), this.#runtime.view());
        this.#presenter.setNotice(t(this.#presenter.locale(), "tasks.stop.success", { taskId }));
        if (reopenTaskPicker) openTasksHubPanel(this.#panelFlow());
        else this.#openInspectPanel("tasks", "/tasks");
      }, "ProcessTask");
    } catch (error) {
      this.#presenter.setNotice(message(error));
      this.#render();
    }
  }

  #addMountFromPath(pathArgument: string): void {
    this.#startManagementTask(async () => {
      const mount = await this.#runtime.addMount(resolve(pathArgument.trim()), "command");
      this.#presenter.setNotice(`Mounted read-only ${mount.id} → ${mount.path}`);
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
    }, "Mount");
  }

  #openVerifySetupPanel(): void {
    this.#startManagementTask(async () => {
      const { candidates, currentNames } = await this.#runtime.scanVerificationSetup();
      openVerifySetupPanel(this.#panelFlow(), candidates, currentNames);
    }, "Verify");
  }

  #applyVerificationSetup(selected: readonly VerificationCandidate[]): void {
    if (this.#runtime.active) {
      this.#presenter.setNotice("Cannot change verification profiles while a Run is active.");
      this.#render();
      return;
    }
    this.#startManagementTask(async () => {
      try {
        const manifest = await this.#runtime.applyVerificationSetup(selected);
        const { verification: _previousVerification, ...launchRest } = this.#presenter.launch;
        this.#presenter.launch = { ...launchRest, verification: manifest };
        this.#presenter.setNotice(
          t(this.#presenter.locale(), "verify.setup.applied", { count: String(manifest.profiles.length) }),
        );
      } catch (error) {
        this.#presenter.setNotice(
          t(this.#presenter.locale(), "verify.setup.failed", { reason: message(error) }),
        );
      }
    }, "Verify");
  }

  #removeMountById(mountId: string): void {
    this.#startManagementTask(async () => {
      await this.#runtime.removeMount(mountId);
      this.#presenter.setNotice(`Unmounted ${mountId}`);
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
    }, "Unmount");
  }

  #panelFlow(): PanelFlowContext {
    return {
      panels: this.#panels,
      presenter: this.#presenter,
      auth: this.#auth,
      terminalRows: this.#terminal.rows ?? 40,
      locale: () => this.#presenter.locale(),
      changeLocale: (locale) => this.#changeLocale(locale),
      theme: () => this.#themePreference,
      changeTheme: (name) => this.#changeTheme(name),
      mode: () => this.#runtime.mode(),
      changeMode: (mode) => {
        try {
          this.#runtime.changeMode(mode, `User set /mode ${mode}`);
          this.#presenter.update(this.#runtime.events(), this.#runtime.view());
          this.#presenter.setNotice(undefined);
        } catch (error) {
          this.#presenter.setNotice(message(error));
        }
        this.#render();
      },
      startLoginDevice: (provider, options) => {
        const modelSuffix = options?.model?.trim() ? ` model ${options.model.trim()}` : "";
        const effortSuffix = options?.reasoningEffort?.trim()
          ? ` effort ${options.reasoningEffort.trim()}`
          : "";
        const contextSuffix = options?.contextWindowTokens === undefined
          ? ""
          : ` context ${options.contextWindowTokens}`;
        this.#handleCommand("login", `${provider} device${modelSuffix}${effortSuffix}${contextSuffix}`);
      },
      startLoginApiKey: (provider, apiKey, options) => {
        const nameSuffix = options?.alias?.trim() ? ` name ${options.alias.trim()}` : "";
        const modelSuffix = options?.model?.trim() ? ` model ${options.model.trim()}` : "";
        const baseSuffix = options?.baseURL?.trim() ? ` base_url ${options.baseURL.trim()}` : "";
        const effortSuffix = options?.reasoningEffort?.trim()
          ? ` effort ${options.reasoningEffort.trim()}`
          : "";
        const contextSuffix = options?.contextWindowTokens === undefined
          ? ""
          : ` context ${options.contextWindowTokens}`;
        this.#handleCommand(
          "login",
          `${provider} key ${apiKey}${nameSuffix}${modelSuffix}${baseSuffix}${effortSuffix}${contextSuffix}`,
        );
      },
      startLogout: (provider, alias) => {
        this.#handleCommand("login", alias ? `logout ${provider} ${alias}` : `logout ${provider}`);
      },
      startUseCompatible: (name) => {
        this.#handleCommand("login", `use ${name}`);
      },
      startUseAccount: (provider, alias, routing) => {
        this.#switchSealedAccount(provider, alias ?? "default", routing);
      },
      openInspect: (panel, title) => {
        if (panel === "skills") {
          this.#startSkillTask(async () => {
            const skills = await this.#runtime.refreshSkills();
            this.#presenter.setSkills(skills);
            this.#openInspectPanel("skills", title);
          });
          return;
        }
        if (panel === "runs" || panel === "steps" || panel === "actions" || panel === "agents") {
          openHistoryListPanel(this.#panelFlow(), panel);
          return;
        }
        this.#openInspectPanel(panel, title);
      },
      openHistoryList: (kind) => {
        openHistoryListPanel(this.#panelFlow(), kind);
      },
      addMount: (path) => this.#addMountFromPath(path),
      removeMount: (mountId) => this.#removeMountById(mountId),
      effectiveCapabilities: () => capabilityIdsFromLaunchLabels(this.#runtime.capabilityLabels()),
      saveCapabilities: (capabilities) => this.#saveCapabilities(capabilities),
      applyVerificationSetup: (selected) => this.#applyVerificationSetup(selected),
      installSkill: (source, scope) => this.#installSkill(source, scope),
      listTasks: () => this.#runtime.tasks(),
      stopTask: (taskId) => this.#stopTaskFromArgument(`stop ${taskId}`, true),
      listSessions: () => buildSessionEntries(this.#runtime.listSessions(), {
        workspaceRoot: this.#presenter.launch.workspaceRoot,
        readEvents: (sessionId) => this.#runtime.readSessionEvents(sessionId),
      }),
      currentSessionId: () => this.#runtime.sessionId,
      workspaceRoot: () => this.#presenter.launch.workspaceRoot,
      resumeSession: (sessionId) => {
        void this.close({ kind: "resume", sessionId });
      },
      startNewSession: () => {
        void this.close({ kind: "new-session" });
      },
      render: () => this.#render(),
    };
  }

  #syncAuthLaunch(status: AuthSessionStatus): void {
    const context = status.contextWindowTokensOverride
      ? this.#runtime.configureContextWindow(status.contextWindowTokens)
      : this.#runtime.syncModelContextWindow(status.contextWindowTokens);
    this.#presenter.patchAuthLaunch({ ...status, ...context });
  }

  async #persistLoginDefaults(status: AuthSessionStatus): Promise<string> {
    const configPath = this.#presenter.launch.configPath ?? defaultUserConfigPath();
    return persistLoginProviderDefaults(status, configPath);
  }

  #switchSealedAccount(
    provider: string,
    alias: string,
    routing?: {
      model?: string;
      baseURL?: string;
      reasoningEffort?: string;
      contextWindowTokens?: number;
    },
  ): void {
    if (!this.#auth) {
      this.#presenter.setNotice("Auth session is unavailable in this TUI mode.");
      this.#render();
      return;
    }
    if (this.#runtime.active) {
      this.#presenter.setNotice("Cannot /login while a Run is active.");
      this.#render();
      return;
    }
    const auth = this.#auth;
    this.#startManagementTask(async () => {
      const status = await auth.useAccount(provider, alias, routing);
      this.#syncAuthLaunch(status);
      await this.#persistLoginDefaults(status);
      this.#presenter.setNotice(
        `Switched to ${formatProviderLabel(status.provider, status.accountAlias)}/${status.model}` +
          (status.baseURL ? ` · ${status.baseURL}` : ""),
      );
    }, "login");
  }

  #handleCommand(name: string, argument: string): void {
    if (this.#panels.open && name !== "quit" && name !== "cancel") {
      this.#panels.closeAll();
    }
    if (name === "settings") {
      openSettingsPanel(this.#panelFlow());
      return;
    }
    if (name === "providers") {
      openProvidersPanel(this.#panelFlow());
      return;
    }
    if (name === "help") {
      const locale = this.#presenter.locale();
      if (!argument) {
        openHelpPanel(this.#panelFlow(), commandHelp(undefined, locale));
      } else {
        this.#openScrollPanel("/help", commandHelp(argument, locale));
      }
      return;
    }
    if (name === "skills") {
      if (/^install\b/i.test(argument.trim())) {
        this.#installSkillFromArgument(argument);
        return;
      }
      if (!argument.trim()) {
        openSkillsHubPanel(this.#panelFlow());
        return;
      }
      openSkillsHubPanel(this.#panelFlow());
      return;
    }
    if (name === "skill") {
      if (!argument.trim()) {
        openSkillsHubPanel(this.#panelFlow());
        return;
      }
      this.#installSkillFromArgument(argument.startsWith("install") ? argument : `install ${argument}`);
      return;
    }
    if (name === "tasks") {
      if (/^stop\b/i.test(argument.trim())) {
        this.#stopTaskFromArgument(argument);
        return;
      }
      if (!argument.trim()) {
        openTasksHubPanel(this.#panelFlow());
        return;
      }
      this.#presenter.setNotice(t(this.#presenter.locale(), "tasks.stop.usage"));
      this.#render();
      return;
    }
    if (name === "task") {
      this.#stopTaskFromArgument(argument.startsWith("stop") ? argument : `stop ${argument}`);
      return;
    }
    if (name === "runs") {
      openRunsHubPanel(this.#panelFlow());
      return;
    }
    if (name === "sessions") {
      openSessionsPanel(this.#panelFlow());
      return;
    }
    if (name === "login") {
      if (!argument.trim()) {
        openProvidersPanel(this.#panelFlow());
        return;
      }
      if (!this.#auth) {
        this.#presenter.setNotice("Auth session is unavailable in this TUI mode.");
        this.#render();
        return;
      }
      if (this.#runtime.active) {
        this.#presenter.setNotice("Cannot /login while a Run is active.");
        this.#render();
        return;
      }
      const auth = this.#auth;
      this.#startManagementTask(async () => {
        const request = parseLoginCommand(argument);
        if (request.mode === "status") {
          const status = auth.status();
          this.#presenter.setNotice(
            `auth ${status.authStatus} · ${formatProviderLabel(status.provider, status.accountAlias)}/${status.model} · ${status.wireApi}`,
          );
          return;
        }
        if (request.mode === "list") {
          const accounts = await auth.listAccounts();
          this.#presenter.setNotice(
            accounts.length === 0
              ? "No sealed provider accounts."
              : accounts.map((account) => `${account.accountId} (${account.authKind})`).join(" · "),
          );
          return;
        }
        if (request.mode === "logout") {
          const provider = request.provider || auth.config.provider;
          const alias = request.alias ?? auth.config.accountAlias;
          const removed = await auth.logout(provider, alias);
          if (removed && provider === "compatible") {
            const configPath = this.#presenter.launch.configPath ?? defaultUserConfigPath();
            await removeCompatibleEndpoint(alias, configPath);
          }
          this.#syncAuthLaunch(auth.status());
          this.#presenter.setNotice(removed ? "Logged out." : "No sealed credential matched.");
          return;
        }
        if (request.mode === "use") {
          const configPath = this.#presenter.launch.configPath ?? defaultUserConfigPath();
          const loaded = await loadUserConfig(configPath);
          const provider = request.provider || "compatible";
          const alias = request.alias ?? "default";
          const routing = provider === "compatible"
            ? (() => {
              const entry = findCompatibleEndpoint(loaded.config, alias);
              return entry ? { model: entry.model, baseURL: entry.baseURL } : undefined;
            })()
            : (loaded.config.provider === provider
              ? {
                ...(loaded.config.model === undefined ? {} : { model: loaded.config.model }),
                ...(loaded.config.baseURL === undefined ? {} : { baseURL: loaded.config.baseURL }),
                ...(loaded.config.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: loaded.config.reasoningEffort }),
                ...(loaded.config.contextWindowTokens === undefined
                  ? {}
                  : { contextWindowTokens: loaded.config.contextWindowTokens }),
              }
              : undefined);
          const status = await auth.useAccount(provider, alias, routing);
          this.#syncAuthLaunch(status);
          await this.#persistLoginDefaults(status);
          this.#presenter.setNotice(
            `Switched to ${formatProviderLabel(status.provider, status.accountAlias)}/${status.model}` +
              (status.baseURL ? ` · ${status.baseURL}` : ""),
          );
          return;
        }
        if (request.mode === "api-key") {
          const status = await auth.loginApiKey(request.provider, request.apiKey!, {
            ...(request.alias === undefined ? {} : { alias: request.alias }),
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.baseURL === undefined ? {} : { baseURL: request.baseURL }),
            ...(request.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: request.reasoningEffort }),
            ...(request.contextWindowTokens === undefined
              ? {}
              : { contextWindowTokens: request.contextWindowTokens }),
          });
          this.#syncAuthLaunch(status);
          const configPath = await this.#persistLoginDefaults(status);
          this.#presenter.setNotice(
            `Authenticated ${formatProviderLabel(status.provider, status.accountAlias)}/${status.model} via API key · saved ${configPath}`,
          );
          return;
        }
        if (request.provider !== "kimi") {
          throw new TypeError(`Device login supports kimi; use /login ${request.provider} key <api-key>`);
        }
        this.#presenter.setNotice("Starting Kimi device login…");
        this.#render();
        const status = await auth.loginKimiDevice({
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.alias === undefined ? {} : { alias: request.alias }),
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: request.reasoningEffort }),
          ...(request.contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens: request.contextWindowTokens }),
          onAuthorization: (info) => {
            this.#presenter.setNotice(
              `Open ${info.verificationUriComplete || info.verificationUri} · code ${info.userCode}`,
            );
            this.#render();
          },
        });
        this.#syncAuthLaunch(status);
        const configPath = await this.#persistLoginDefaults(status);
        this.#presenter.setNotice(
          `Authenticated ${formatProviderLabel(status.provider, status.accountAlias)}/${status.model} via device login · saved ${configPath}`,
        );
      }, "login");
      return;
    }
    if (name === "plan") {
      this.#handlePlanControl(argument);
      return;
    }
    if (name === "ask") {
      this.#handleAskCommand(argument);
      return;
    }
    if (name === "steps" || name === "actions" || name === "agents") {
      openHistoryListPanel(this.#panelFlow(), name);
      return;
    }
    const panel = tuiCommands.find((command) => command.name === name)?.panel;
    if (panel) {
      if (panel === "overview" || name === "status") {
        this.#openInspectPanel("overview", "/status");
      } else if (panel === "runs" || panel === "steps" || panel === "actions" || panel === "agents") {
        openHistoryListPanel(this.#panelFlow(), panel);
      } else {
        this.#openInspectPanel(panel, `/${name}`);
      }
      return;
    }
    switch (name) {
      case "mode": {
        const requested = argument.trim().toLowerCase();
        if (!requested) {
          openModePanel(this.#panelFlow());
          return;
        }
        if (requested !== "ask" && requested !== "plan" && requested !== "agent") {
          this.#presenter.setNotice("Usage: /mode ask|plan|agent");
          break;
        }
        this.#panelFlow().changeMode(requested as SessionMode);
        return;
      }
      case "next": {
        const choice = argument.trim().toLowerCase();
        if (!choice) {
          if (this.#ensureNextRunPanel()) return;
          this.#presenter.setNotice("No pending Next Run · 没有未完成的 Plan item，或尚未 accept 计划。");
          break;
        }
        const mapped =
          choice === "continue"
            ? "continue"
            : choice === "stop"
              ? "stop"
              : choice === "plan" || choice === "return_to_plan"
                ? "return_to_plan"
                : undefined;
        if (!mapped) {
          this.#presenter.setNotice("Usage: /next · /next continue|stop|plan");
          break;
        }
        // After stop, /next continue re-asks then settles continue.
        const pending = this.#runtime.view()?.pendingQuestion;
        if (!(pending?.status === "pending" && pending.kind === "next_run")) {
          if (mapped !== "continue") {
            this.#presenter.setNotice("No pending Next Run · 用 /next 重新打开后再选，或 /next continue。");
            break;
          }
          try {
            if (!this.#runtime.reaskNextRun()) {
              this.#presenter.setNotice("No incomplete Plan item to continue.");
              break;
            }
            this.#presenter.update(this.#runtime.events(), this.#runtime.view());
            this.#nextRunKey = undefined;
          } catch (error) {
            this.#presenter.setNotice(message(error));
            break;
          }
        }
        this.#answerNextRunChoice(mapped);
        return;
      }
      case "steer":
        if (!argument) this.#presenter.setNotice("Usage: /steer <text>");
        else {
          try {
            this.#runtime.steer(argument);
            this.#presenter.setNotice("Steering queued for the next safe Step boundary.");
          } catch (error) {
            this.#presenter.setNotice(message(error));
          }
        }
        break;
      case "cancel":
        if (!this.#runtime.active) this.#presenter.setNotice("No active Run to cancel.");
        else {
          this.#runtime.cancel("User cancelled the Run");
          this.#presenter.setNotice("Cancellation requested; waiting for settlement.", "run");
        }
        break;
      case "add-dir": {
        if (!argument.trim()) {
          this.#presenter.setNotice(t(this.#presenter.locale(), "mounts.add.usage"));
          break;
        }
        this.#addMountFromPath(argument);
        return;
      }
      case "unmount": {
        const mountId = argument.trim();
        if (!mountId) {
          this.#presenter.setNotice(t(this.#presenter.locale(), "mounts.unmount.usage"));
          break;
        }
        this.#removeMountById(mountId);
        return;
      }
      case "mounts": {
        try {
          const request = parseMountsCommand(argument);
          if (request.mode === "add") {
            this.#addMountFromPath(request.argument);
            return;
          }
          if (request.mode === "unmount") {
            this.#removeMountById(request.argument);
            return;
          }
          openMountsPanel(this.#panelFlow(), this.#runtime.mounts());
        } catch (error) {
          this.#presenter.setNotice(message(error));
        }
        return;
      }
      case "permissions": {
        openPermissionsPanel(this.#panelFlow());
        return;
      }
      case "verify": {
        this.#openVerifySetupPanel();
        return;
      }
      case "quit":
        void this.close();
        return;
      default:
        this.#presenter.setNotice(t(this.#presenter.locale(), "help.unknown", { name }));
        this.#render();
        return;
    }
    this.#render();
  }

  #startSkillTask(operation: () => Promise<void>): void {
    this.#startManagementTask(operation, "Skill");
  }

  #startManagementTask(operation: () => Promise<void>, label: string): void {
    if (this.#active.size > 0) {
      this.#presenter.setNotice("Another TUI operation is active.");
      this.#render();
      return;
    }
    this.#terminal.setProgress(true);
    const task = operation()
      .catch((error: unknown) => this.#presenter.setNotice(`${label} error: ${message(error)}`))
      .finally(() => {
        this.#active.delete(task);
        this.#terminal.setProgress(false);
        this.#render();
      });
    this.#active.add(task);
    this.#render();
  }

  /** Full paint: transcript + chrome (Session events, expand, panels, …). */
  #render(): void {
    this.#syncWorkingTick();
    this.#syncNoticeTimer();
    this.#dashboard.invalidate();
    this.#working.invalidate();
    this.#composer.invalidate();
    this.#footer.invalidate();
    this.#tui.requestRender();
  }

  /** Composer / Working / footer only — keeps large transcripts off the keystroke and spinner path. */
  #renderChrome(): void {
    this.#syncWorkingTick();
    this.#syncNoticeTimer();
    this.#working.invalidate();
    this.#composer.invalidate();
    this.#footer.invalidate();
    this.#tui.requestRender();
  }

  #syncNoticeTimer(): void {
    const expiresAt = this.#presenter.noticeExpiresAt();
    if (expiresAt === this.#noticeTimerExpiresAt) return;
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = undefined;
    this.#noticeTimerExpiresAt = expiresAt;
    if (expiresAt === undefined) return;
    const delay = Math.max(0, expiresAt - Date.now());
    this.#noticeTimer = setTimeout(() => {
      this.#noticeTimer = undefined;
      this.#noticeTimerExpiresAt = undefined;
      this.#presenter.notice();
      this.#renderChrome();
    }, delay);
  }

  /** Cursor-style empty composer: → Add … hint, static caret on A, ctrl+c on the right. */
  #composerPlaceholder(): { left: string; right: string } | undefined {
    if (this.#panels.open) return undefined;
    if (this.#followUps.editing) return undefined;
    const locale = this.#presenter.locale();
    if (this.#runtime.active) {
      return {
        left: t(locale, "followups.add"),
        right: "ctrl+c to stop",
      };
    }
    const view = this.#runtime.view();
    if (
      view?.pendingReview?.status === "pending" ||
      view?.pendingQuestion?.status === "pending"
    ) {
      // Working strip already carries the gate hint + ctrl+c; still show prompt + caret.
      return { left: t(locale, "composer.prompt"), right: "" };
    }
    return {
      left: t(locale, "composer.prompt"),
      right: "ctrl+c to quit",
    };
  }
}

class DashboardComponent implements Component {
  readonly #presenter: TuiPresenter;
  #dirty = true;
  #cachedWidth = -1;
  #cachedLines: string[] = [];

  constructor(presenter: TuiPresenter) {
    this.#presenter = presenter;
  }

  invalidate(): void {
    this.#dirty = true;
  }

  render(width: number): string[] {
    const usable = Math.max(20, width);
    if (!this.#dirty && usable === this.#cachedWidth) return this.#cachedLines;
    // Notices live in the Working strip above the composer so long chats do not hide them.
    this.#cachedLines = this.#presenter.render(usable).flatMap((line) => {
      if (line.startsWith("notice  ")) return [];
      if (line.startsWith(USER_MESSAGE_PREFIX)) {
        const text = line.slice(USER_MESSAGE_PREFIX.length);
        const paint = (content: string) =>
          theme.bg("userMessageBg", theme.fg("roleUser", padToDisplayWidth(content, usable)));
        const body = wrapTextWithAnsi(` ${text} `, usable).map((wrapped) => paint(wrapped));
        // Extra bg rows so short user turns are not a one-line strip.
        const pad = paint("");
        return [pad, ...body, pad];
      }
      return wrapTextWithAnsi(styleLine(line), usable);
    });
    this.#cachedWidth = usable;
    this.#dirty = false;
    return this.#cachedLines;
  }
}

class WorkingComponent implements Component {
  readonly #runtime: TuiRuntime;
  readonly #presenter: TuiPresenter;
  readonly #editor: Editor;
  readonly #panelOpen: () => boolean;

  constructor(
    runtime: TuiRuntime,
    presenter: TuiPresenter,
    editor: Editor,
    panelOpen: () => boolean,
  ) {
    this.#runtime = runtime;
    this.#presenter = presenter;
    this.#editor = editor;
    this.#panelOpen = panelOpen;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const usable = Math.max(20, width);
    const notice = this.#presenter.notice();
    const noticeLines = notice
      ? wrapTextWithAnsi(theme.fg("warning", `notice  ${notice}`), usable)
      : [];
    const view = this.#runtime.view();
    // Welcome already prints the discovery Tip; keep it above the composer once Runs exist.
    const tip = this.#presenter.discoveryTip();
    const tipLines = tip && (view?.runOrder.length ?? 0) > 0
      ? wrapTextWithAnsi(theme.fg("textDim", tip), usable)
      : [];

    if (this.#runtime.active) {
      const working = this.#presenter.renderWorking(true, Date.now(), usable);
      const headline = working[0] ?? "⠋ Running";
      // While a panel covers the composer, Esc/ctrl+c only dismiss UI — never imply Run cancel.
      // Empty-composer ctrl+c lives inside the Composer placeholder (Cursor-style); keep it on
      // the Running strip only while the operator is already typing a follow-up.
      const editorEmpty = this.#editor.getText().length === 0;
      const stop = this.#panelOpen()
        ? "esc closes panel"
        : editorEmpty
          ? undefined
          : "ctrl+c to stop";
      const line = stop === undefined
        ? theme.fg("primary", headline)
        : splitKeepRight(theme.fg("primary", headline), theme.fg("textDim", stop), usable);
      return [
        ...noticeLines,
        ...wrapTextWithAnsi(line, usable),
        ...working.slice(1).flatMap((tail) =>
          wrapTextWithAnsi(theme.fg("textDim", tail), usable)
        ),
      ];
    }
    // Review / choice panels replace the composer — still keep notice visible.
    if (this.#panelOpen()) return [...noticeLines, ...tipLines];
    if (view?.pendingReview?.status === "pending") {
      const hint = "Plan review pending · /plan or 1/2/3 · type to discuss";
      const stop = this.#editor.getText().length > 0 ? "ctrl+c to clear" : "ctrl+c to quit";
      return [
        ...noticeLines,
        ...tipLines,
        ...wrapTextWithAnsi(
          theme.fg("warning", splitKeepRight(hint, stop, usable)),
          usable,
        ),
      ];
    }
    if (view?.pendingQuestion?.status === "pending") {
      const hint = "Next Run pending · ↑↓/Enter in panel · Esc chat · /next to reopen";
      const stop = this.#editor.getText().length > 0 ? "ctrl+c to clear" : "ctrl+c to quit";
      return [
        ...noticeLines,
        ...tipLines,
        ...wrapTextWithAnsi(
          theme.fg("warning", splitKeepRight(hint, stop, usable)),
          usable,
        ),
      ];
    }
    // Idle empty: ctrl+c lives in the Composer placeholder. Non-empty: clear hint here.
    if (this.#editor.getText().length === 0) return [...noticeLines, ...tipLines];
    return [
      ...noticeLines,
      ...tipLines,
      ...wrapTextWithAnsi(
        theme.fg("textDim", splitKeepRight("", "ctrl+c to clear", usable)),
        usable,
      ),
    ];
  }
}

class FooterComponent implements Component {
  readonly #runtime: TuiRuntime;
  readonly #presenter: TuiPresenter;

  constructor(runtime: TuiRuntime, presenter: TuiPresenter) {
    this.#runtime = runtime;
    this.#presenter = presenter;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const usable = Math.max(20, width);
    const mode = labelMode(this.#runtime.mode());
    return this.#presenter.formatStatusline(this.#runtime.active, usable).map((line, index) => {
      if (index === 0 && line.includes(mode)) {
        const splitAt = line.lastIndexOf(mode);
        const left = line.slice(0, splitAt);
        const right = line.slice(splitAt);
        return wrapTextWithAnsi(`${theme.fg("textDim", left)}${theme.boldFg("primary", right)}`, usable);
      }
      return wrapTextWithAnsi(theme.fg("textDim", line), usable);
    }).flat();
  }
}

function styleLine(line: string): string {
  if (line.includes("\u001b[")) return line;
  if (line.startsWith("栖") || line.startsWith("Qi")) return theme.boldFg("primary", line);
  if (line.startsWith("Tip:") || line.trimStart().startsWith("Tip:") || line.trimStart().startsWith("提示:")) {
    return theme.fg("textDim", line);
  }
  if (/^(Effective configuration|Context|Runs |Steps |Actions |Subagents |Skills |ProcessTasks |Diff |Plan |Todo |Status|Keyboard shortcuts|Slash commands|常用 Slash 命令|键盘快捷键|高级 \/ 别名命令|── Handoff|Run  |Action  |Plan Review|Next Run)/.test(line)) {
    return theme.bold(line);
  }
  if (/^\s*✔ /.test(line)) return theme.fg("success", line);
  if (/^\s*◐ /.test(line)) return theme.fg("primary", line);
  if (line.startsWith("notice  ")) return theme.fg("warning", line);
  if (/^\s*\+/.test(line) || /│\s*\+/.test(line) || /▎\s*\+/.test(line)) return theme.fg("diffAdded", line);
  if (/^\s*-/.test(line) || /│\s*-/.test(line) || /▎\s*-/.test(line)) return theme.fg("diffRemoved", line);
  if (/^\s*▎ /.test(line) || /^\s*│ /.test(line)) return theme.fg("diffMeta", line);
  if (/^\s*@@/.test(line)) return theme.fg("diffMeta", line);
  if (/^\$ /.test(line.trim()) || /^[✓●]\s+\$/.test(line.trim())) return theme.fg("accent", line);
  if (/^[✓]/.test(line.trim())) return theme.fg("success", line);
  if (/^[●]/.test(line.trim())) return theme.fg("primary", line);
  if (/^[⊘?]/.test(line.trim())) return theme.fg("warning", line);
  if (/^[!]/.test(line.trim())) return theme.fg("error", line);
  if (/^[×○]/.test(line.trim())) return theme.fg("textDim", line);
  if (line.startsWith("· ")) return theme.boldFg("warning", line);
  if (line.includes("Interrupted")) return theme.fg("textDim", line);
  return line;
}

function labelMode(mode: SessionMode): string {
  switch (mode) {
    case "ask":
      return "Ask";
    case "plan":
      return "Plan";
    case "agent":
      return "Agent";
  }
}

/** Explicit execute intent — ordinary chat while a Plan review is pending stays Q&A / supplements. */
function looksLikeStartPlan(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  return /^(开始实现|开始推进(?:计划)?|开始执行(?:计划)?|推进计划|执行计划|accept(?:\s+plan)?|start(?:\s+plan)?|execute(?:\s+plan)?)$/iu.test(text);
}

/** Explicit next-Run answers — free-form chat after Esc does not settle the Question. */
function looksLikeNextRunChoice(input: string): "continue" | "stop" | "return_to_plan" | undefined {
  const text = input.trim();
  if (!text) return undefined;
  if (/^(继续(?:下一项)?|继续推进|下一步|continue|next)$/iu.test(text)) return "continue";
  if (/^(先?停(?:在这里)?|停止|stop)$/iu.test(text)) return "stop";
  if (/^(回到\s*plan|返回计划|改计划|return(?:\s+to\s+plan)?|plan)$/iu.test(text)) return "return_to_plan";
  return undefined;
}

function grantDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const leaf = trimmed.split(/[\\/]/).pop() ?? "";
  // Heuristic: treat paths with a short file extension as files and mount the parent.
  if (leaf.includes(".") && /\.[A-Za-z0-9]{1,12}$/.test(leaf)) return dirname(trimmed);
  return trimmed;
}

function extractGrantPath(modelOutput: unknown): string | undefined {
  if (!Array.isArray(modelOutput)) return undefined;
  for (const part of modelOutput) {
    if (!part || typeof part !== "object") continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    try {
      const parsed = JSON.parse(text) as { details?: { path?: unknown }; message?: unknown };
      if (typeof parsed.details?.path === "string" && parsed.details.path.trim()) {
        return parsed.details.path.trim();
      }
      const match = typeof parsed.message === "string"
        ? parsed.message.match(/(?:grant panel|readable):\s*(.+)$/i)
        : undefined;
      if (match?.[1]) return match[1].trim();
    } catch {
      // Ignore non-JSON tool failure payloads.
    }
  }
  return undefined;
}

function oneLineHint(value: string, maximum = 48): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
