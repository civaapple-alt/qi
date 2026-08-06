import {
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
import type {
  RunImagePart,
  RunInputPart,
  SessionEvent,
  SessionId,
} from "@civaapple/qi-protocol";
import type { EvalOutcome } from "@civaapple/qi-agent/eval";
import {
  formatGoalContinuationNotice,
  nextSessionMode,
  type RuntimeActivity,
  type SessionMode,
} from "@civaapple/qi-agent/loop";
import type { VerificationCandidate } from "@civaapple/qi-node/tools";
import { findTrustedExecutable } from "@civaapple/qi-node/tools";
import type { AuthSession, AuthSessionStatus } from "./auth.js";
import { parseLoginCommand } from "./auth.js";
import { canAutoOpenAttention, highestPriorityAttention } from "./attention.js";
import {
  commandHelp,
  parseMountsCommand,
  parseSkillInstallCommand,
  parseJobStopCommand,
  parseTuiCommand,
  autocompleteSlashCommands,
  tuiCommands,
  type TuiPanel,
} from "./commands.js";
import {
  defaultUserConfigPath,
  persistUserLanguage,
  persistUserTheme,
  persistUserTimelineDensity,
  loadUserConfig,
  findCompatibleEndpoint,
  removeCompatibleEndpoint,
  type QiCapabilityConfig,
  type QiDelegateConfig,
} from "./config.js";
import { ComposerComponent } from "./composer.js";
import { FollowUpQueue } from "./follow-ups.js";
import { FollowUpsComponent } from "./follow-ups-view.js";
import {
  defaultGoalContract,
  formatGoalStatus,
  goalHubSummary,
  parseGoalCommand,
} from "./goal-command.js";
import {
  formatMemoryClaims,
  memoryIdsUsedInLatestRun,
  memoryUsageInLatestRun,
  parseMemoryCommand,
} from "./memory-command.js";
import { persistLoginProviderDefaults } from "./login-persist.js";
import { formatProviderLabel } from "./provider.js";
import { t, type Locale } from "./i18n.js";
import { padToDisplayWidth, splitKeepRight } from "./layout.js";
import {
  FormPanel,
  ListPanel,
  PluginBrowserPanel,
  type PluginBrowserItem,
  capabilityIdsFromLaunchLabels,
  openHelpPanel,
  openHistoryListPanel,
  openMaxActionsPerStepPanel,
  openMaxStepsPanel,
  openModePanel,
  openSubagentSettingsPanel,
  openModelConfigurationPanel,
  openMountsPanel,
  openMcpPanel,
  openPermissionsPanel,
  openShellPanel,
  openProvidersPanel,
  openRunsHubPanel,
  openSessionsPanel,
  openSettingsPanel,
  openSkillsHubPanel,
  openJobsHubPanel,
  openSubagentTasksHubPanel,
  openVerifySetupPanel,
  PanelHost,
  QuestionPanel,
  ScrollPanel,
  type PanelFlowContext,
} from "./panels/index.js";
import { buildSessionEntries } from "./session-list.js";
import { eventAffectsTranscript } from "./paint.js";
import { TuiPresenter, USER_MESSAGE_PREFIX } from "./presenter.js";
import type { TuiRuntime } from "./runtime.js";
import { applyTheme, theme, type ThemeName } from "./theme/index.js";
import { readClipboardPaste } from "./clipboard.js";
import { imagePlaceholder, structuredComposerContent } from "./image-composer.js";
import {
  validateWorkspaceMentions,
  WorkspaceAutocompleteProvider,
} from "./workspace-autocomplete.js";

export type InteractiveExit =
  | { kind: "quit" }
  | { kind: "resume"; sessionId: SessionId }
  | { kind: "new-session" }
  | { kind: "archive"; sessionId: SessionId }
  | { kind: "restore"; sessionId: SessionId }
  | { kind: "reset-workspace" };

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
  readonly #composerImages = new Map<string, RunImagePart>();
  #nextImageNumber = 1;
  #closing = false;
  #exit: InteractiveExit = { kind: "quit" };
  #resolveClosed: ((exit: InteractiveExit) => void) | undefined;
  #activityTimer: ReturnType<typeof setTimeout> | undefined;
  #workingTimer: ReturnType<typeof setInterval> | undefined;
  #noticeTimer: ReturnType<typeof setTimeout> | undefined;
  #noticeTimerExpiresAt: number | undefined;
  #autocompleteGeneration = 0;
  /** Last Plan review key offered as a panel; Esc dismisses until the revision changes. */
  #planReviewKey: string | undefined;
  /** Last next-Run Question id offered as a panel; Esc dismisses until it changes. */
  #nextRunKey: string | undefined;
  #runQuestionKey: string | undefined;
  /** Pending PATH_GRANT_REQUIRED directories awaiting a human allow/deny panel. */
  #pendingPathGrants: string[] = [];
  #pathGrantKey: string | undefined;
  /** Pending SENSITIVE_PATH_GRANT_REQUIRED Workspace-relative paths. */
  #pendingSensitivePathGrants: string[] = [];
  #sensitivePathGrantKey: string | undefined;
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
    this.#presenter.setSkills(runtime.skillCatalog(), runtime.skillCandidates());
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
    this.#editor.onSubmit = (input) => { void this.#handleInput(input); };
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
          if (this.#runQuestionKey) {
            const questionSetId = this.#runQuestionKey as import("@civaapple/qi-protocol").QuestionId;
            this.#runQuestionKey = undefined;
            this.#panels.closeAll();
            try {
              this.#runtime.cancelRunQuestion(questionSetId, "Cancelled by user");
            } finally {
              this.#runtime.cancel("Cancelled by user while answering a Plan Question");
            }
            return { consume: true };
          }
          this.#panels.closeAll();
          this.#maybeDrainFollowUps();
          return { consume: true };
        }
        if (matchesKey(data, Key.escape)) {
          // Forward Esc to the panel (search clear / dismiss), then consume so it cannot
          // reach the Editor after remount or be mistaken for Run cancellation.
          this.#panels.deliverInput(data);
          if (!this.#panels.open) this.#maybeDrainFollowUps();
          return { consume: true };
        }
        return undefined;
      }
      if (matchesKey(data, "ctrl+g")) {
        this.#openPendingAttention();
        return { consume: true };
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
      // Windows terminals often own Ctrl+V (e.g. Windows Terminal paste), so Alt+V
      // is the reliable image-paste chord there — same as kimi-code.
      if (
        matchesKey(data, "ctrl+v") ||
        (process.platform === "win32" && matchesKey(data, "alt+v"))
      ) {
        this.#startClipboardPaste();
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
        this.#composerImages.clear();
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
    if (event.type === "action.failed" && event.data.errorCode === "SENSITIVE_PATH_GRANT_REQUIRED") {
      const path = extractSensitiveGrantPath(event.data.modelOutput);
      if (path) this.#queueSensitivePathGrant(path);
    } else if (event.type === "action.failed" && event.data.errorCode === "PATH_GRANT_REQUIRED") {
      const path = extractGrantPath(event.data.modelOutput);
      if (path && !isSensitiveGrantFailure(event.data.modelOutput)) this.#queuePathGrant(path);
    }
    const view = this.#runtime.view();
    if (!this.#presenter.applyCommitted(event, view)) {
      this.#presenter.update(this.#runtime.events(), view);
    }
    if (event.type === "run.question.asked") this.#maybeOfferRunQuestion();
    this.#maybeOfferSensitivePathGrant();
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

  async #handleInput(raw: string): Promise<void> {
    let input = raw.trim();
    if (!input) return;
    const command = parseTuiCommand(raw);
    let content = structuredComposerContent(raw, this.#composerImages);
    this.#composerImages.clear();
    this.#editor.addToHistory(raw);
    this.#editor.setText("");
    // A notice describes the interaction that just finished. Retire it as soon as
    // the operator begins the next one; that interaction may publish a fresh notice.
    this.#presenter.setNotice(undefined);
    if (this.#followUps.editing) {
      try {
        input = (await validateWorkspaceMentions(input, this.#presenter.launch.workspaceRoot)).trim();
        content = content === undefined
          ? undefined
          : await Promise.all(content.map(async (part) =>
              part.type === "text"
                ? { ...part, text: await validateWorkspaceMentions(part.text, this.#presenter.launch.workspaceRoot) }
                : part));
      } catch (error) {
        this.#editor.setText(raw);
        this.#presenter.setNotice(message(error));
        this.#render();
        return;
      }
      this.#followUps.commitEdit(input, content);
      // Keep selection so Enter can send-now / Esc can delete without re-selecting.
      this.#presenter.setNotice(undefined);
      this.#render();
      this.#maybeDrainFollowUps();
      return;
    }
    if (command) {
      const policy = tuiCommands.find((candidate) => candidate.name === command.name)?.draftPolicy;
      if (command.draft !== undefined && policy === "preserve") {
        this.#editor.setText(command.draft);
      } else if (command.draft !== undefined && policy === "reject") {
        this.#editor.setText(command.draft);
        this.#presenter.setNotice(`/${command.name} cannot run while a draft follows it.`);
        this.#render();
        return;
      }
      this.#handleCommand(command.name, command.argument);
      return;
    }
    try {
      input = (await validateWorkspaceMentions(input, this.#presenter.launch.workspaceRoot)).trim();
      content = content === undefined
        ? undefined
        : await Promise.all(content.map(async (part) =>
            part.type === "text"
              ? { ...part, text: await validateWorkspaceMentions(part.text, this.#presenter.launch.workspaceRoot) }
              : part));
    } catch (error) {
      this.#editor.setText(raw);
      this.#presenter.setNotice(message(error));
      this.#render();
      return;
    }
    if (this.#runtime.active) {
      this.#followUps.enqueue(input, content);
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
    this.#startUserRun(input, content);
  }

  #startClipboardPaste(): void {
    let operation: Promise<void>;
    operation = this.#pasteClipboard().finally(() => {
      this.#active.delete(operation);
      this.#render();
    });
    this.#active.add(operation);
  }

  async #pasteClipboard(): Promise<void> {
    const paste = await readClipboardPaste();
    if (paste.type === "text") {
      this.#editor.insertTextAtCursor?.(paste.text);
      return;
    }
    if (paste.type === "empty") return;
    try {
      const image = await this.#runtime.ingestClipboardImage(paste.bytes);
      const placeholder = imagePlaceholder(this.#nextImageNumber++, image);
      this.#composerImages.set(placeholder, image);
      this.#editor.insertTextAtCursor?.(placeholder);
      this.#presenter.setNotice(
        `Attached ${image.width}×${image.height} ${image.mediaType}${image.downsampled ? " (downsampled)" : ""}.`,
      );
    } catch (error) {
      this.#presenter.setNotice(
        `Image paste failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #restoreComposerImages(item: { text: string; content?: readonly RunInputPart[] } | undefined): void {
    this.#composerImages.clear();
    if (!item?.content) return;
    const images = item.content.filter((part): part is RunImagePart => part.type === "image");
    let imageIndex = 0;
    for (const match of item.text.matchAll(/\[image #(\d+) \(\d+×\d+\)\]/g)) {
      const image = images[imageIndex++];
      if (!image) break;
      this.#composerImages.set(match[0], { ...image });
      const number = Number(match[1]);
      if (Number.isInteger(number)) this.#nextImageNumber = Math.max(this.#nextImageNumber, number + 1);
    }
  }

  #handleFollowUpKeys(data: string): boolean {
    const locale = this.#presenter.locale();
    const editorEmpty = this.#editor.getText().length === 0;

    if (matchesKey(data, Key.escape)) {
      if (this.#followUps.editing) {
        this.#followUps.cancelEdit();
        this.#editor.setText("");
        this.#composerImages.clear();
        this.#render();
        return true;
      }
      // Esc only clears selection (never deletes) so a fast Esc cannot wipe a follow-up.
      if (this.#followUps.selectedIndex >= 0) {
        this.#followUps.clearSelection();
        this.#render();
        return true;
      }
      return false;
    }

    if ((matchesKey(data, Key.enter) || matchesKey(data, "return")) && editorEmpty && !this.#followUps.editing) {
      if (this.#followUps.selectedIndex >= 0) {
        this.#followUps.moveSelectedToFront();
        this.#presenter.setNotice(t(locale, "followups.sendNow"));
        this.#render();
        this.#maybeDrainFollowUps();
        return true;
      }
      // Nothing selected: still drain FIFO when idle (first queued item auto-starts).
      if (this.#followUps.length > 0 && !this.#runtime.active) {
        this.#maybeDrainFollowUps();
        return true;
      }
      return false;
    }

    if (!editorEmpty || this.#followUps.editing) return false;
    if (this.#followUps.length === 0 && !this.#runtime.active) return false;

    if (
      (matchesKey(data, "d") || matchesKey(data, "shift+d")) &&
      this.#followUps.selectedIndex >= 0
    ) {
      this.#followUps.removeSelected();
      this.#presenter.setNotice(t(locale, "followups.cancelled"));
      this.#render();
      return true;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, "up")) {
      if (this.#followUps.length === 0) return false;
      if (this.#followUps.selectedIndex < 0) this.#followUps.selectLast();
      if (this.#followUps.editing) {
        // Move to the previous queued item while editing.
        this.#followUps.cancelEdit();
        this.#editor.setText("");
        this.#composerImages.clear();
        this.#followUps.selectPrev();
      }
      // Not editing: ↑ edits the currently selected item (including a just-queued one).
      const text = this.#followUps.beginEdit(this.#followUps.selectedIndex);
      this.#restoreComposerImages(this.#followUps.selected);
      this.#editor.setText(text ?? "");
      this.#render();
      return true;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, "down")) {
      if (this.#followUps.length === 0) return false;
      if (this.#followUps.selectedIndex < 0) {
        this.#followUps.selectLast();
      } else if (this.#followUps.editing) {
        this.#followUps.cancelEdit();
        this.#editor.setText("");
        this.#composerImages.clear();
        this.#followUps.selectNext();
      } else {
        this.#followUps.selectNext();
      }
      const text = this.#followUps.beginEdit(this.#followUps.selectedIndex);
      this.#restoreComposerImages(this.#followUps.selected);
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
    this.#startUserRun(next.text, next.content);
  }

  #startUserRun(input: string, content?: readonly RunInputPart[]): void {
    this.#startTurn(() => this.#runtime.run(input, content));
  }

  #startPlanDraft(input: string): void {
    this.#startTurn(() => this.#runtime.runPlanDraft(input));
  }

  #startTriggeredRun(runId: import("@civaapple/qi-protocol").RunId, input: string): void {
    this.#startTurn(() => this.#runtime.runTriggered(runId, input));
  }

  #startTurn(operation: () => Promise<{ status: string }>): void {
    this.#terminal.setProgress(true);
    const task = operation()
      .then((result) => {
        const goalNotice = (() => {
          const decision = this.#runtime.lastGoalContinuation();
          return decision ? formatGoalContinuationNotice(decision) : undefined;
        })();
        if (result.status === "completed") {
          if (goalNotice) {
            this.#presenter.setNotice(goalNotice, "run");
            return;
          }
          const pendingMemories = this.#runtime.pendingMemoryCountForLatestRun();
          if (pendingMemories > 0) {
            this.#presenter.setNotice(
              `${pendingMemories} Memory candidate${pendingMemories === 1 ? "" : "s"} await review · /memory list pending`,
              "run",
            );
          } else {
            // Keep operator info notices (login, permissions, …) across the next Run.
            this.#presenter.clearRunNotice();
          }
          return;
        }
        this.#presenter.update(this.#runtime.events(), this.#runtime.view());
        if (goalNotice) {
          this.#presenter.setNotice(goalNotice, "run");
          return;
        }
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
        // Drain queued follow-ups before auto-opening path-grant panels, which would
        // otherwise leave the first follow-up stranded until the panel is dismissed.
        this.#maybeDrainFollowUps();
        if (!this.#runtime.active && this.#active.size === 0) {
          this.#maybeOfferPendingGates();
          this.#maybeOfferPathGrant();
        }
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
    this.#maybeOfferRunQuestion();
    this.#maybeOfferPlanReview();
    this.#maybeOfferNextRun();
    this.#maybeOfferSensitivePathGrant();
    this.#maybeOfferPathGrant();
  }

  #canAutoOpenGate(): boolean {
    return canAutoOpenAttention({
      panelOpen: this.#panels.open,
      composerEmpty: this.#editor.getText().length === 0,
      followUpEditing: this.#followUps.editing,
    });
  }

  #deferGate(label: string): void {
    this.#presenter.setNotice(`${label} · Ctrl+G`, "run");
    this.#renderChrome();
  }

  /** Open the highest-priority durable gate without changing the execution target. */
  #openPendingAttention(): void {
    if (this.#panels.open) return;
    const view = this.#runtime.view();
    const run = view?.currentRunId ? view.runs[view.currentRunId] : undefined;
    const questionSetId = run?.pendingQuestionSetId;
    const questionSet = questionSetId ? run?.questions[questionSetId] : undefined;
    const gate = highestPriorityAttention({
      runQuestion: Boolean(questionSetId && questionSet?.status === "pending"),
      planReview: view?.pendingReview?.status === "pending",
      nextRun: view?.pendingQuestion?.status === "pending" && view.pendingQuestion.kind === "next_run",
      sensitivePathGrant: this.#pendingSensitivePathGrants.length > 0,
      pathGrant: this.#pendingPathGrants.length > 0,
    });
    if (gate === "run-question" && questionSetId) {
      this.#openRunQuestionPanel(questionSetId);
      return;
    }
    if (gate === "plan-review") {
      this.#openPlanReviewPanel();
      return;
    }
    if (gate === "next-run") {
      this.#openNextRunPanel();
      return;
    }
    const sensitivePath = this.#pendingSensitivePathGrants[0];
    if (gate === "sensitive-path-grant" && sensitivePath) {
      this.#sensitivePathGrantKey = sensitivePath;
      this.#openSensitivePathGrantPanel(sensitivePath);
      return;
    }
    const path = this.#pendingPathGrants[0];
    if (gate === "path-grant" && path) {
      this.#pathGrantKey = path;
      this.#openPathGrantPanel(path);
      return;
    }
    this.#presenter.setNotice("No pending question, review, or permission request.");
    this.#renderChrome();
  }

  #queueSensitivePathGrant(path: string): void {
    const normalized = normalizeSensitiveGrantPath(path);
    if (this.#runtime.sensitivePathGrants().includes(normalized)) return;
    if (!this.#pendingSensitivePathGrants.includes(normalized)) {
      this.#pendingSensitivePathGrants.push(normalized);
    }
  }

  #maybeOfferSensitivePathGrant(): void {
    // Allow during an active Run so the next Action can see a mid-Run grant via getSensitivePathGrants.
    if (this.#active.size > 0 || this.#panels.open) return;
    const next = this.#pendingSensitivePathGrants[0];
    if (!next) {
      this.#sensitivePathGrantKey = undefined;
      return;
    }
    if (this.#sensitivePathGrantKey === next) return;
    if (!this.#canAutoOpenGate()) {
      this.#deferGate("Sensitive file permission needs your attention");
      return;
    }
    this.#sensitivePathGrantKey = next;
    this.#openSensitivePathGrantPanel(next);
  }

  #openSensitivePathGrantPanel(path: string): void {
    if (this.#panels.open) this.#panels.closeAll();
    this.#panels.push(new ListPanel({
      title: "Allow model to read sensitive file content?",
      hints: `↑↓ select · Enter confirm · Esc deny · ${oneLineHint(path)}`,
      items: [
        {
          id: "allow",
          label: "Allow",
          description: "Persist grant in project policy; file body may reach the model",
        },
        {
          id: "deny",
          label: "Deny",
          description: "Keep blocked; Agent continues to see SENSITIVE_PATH_GRANT_REQUIRED",
        },
      ],
      onClose: () => {
        this.#pendingSensitivePathGrants = this.#pendingSensitivePathGrants.filter(
          (candidate) => candidate !== path,
        );
        this.#sensitivePathGrantKey = undefined;
        this.#presenter.setNotice(`Denied sensitive path ${path}`);
        this.#panels.dismiss();
        this.#maybeOfferSensitivePathGrant();
        this.#render();
      },
      onSelect: (item) => {
        this.#panels.closeAll();
        void this.#settleSensitivePathGrant(path, item.id === "allow");
      },
    }));
    this.#render();
  }

  async #settleSensitivePathGrant(path: string, allow: boolean): Promise<void> {
    this.#pendingSensitivePathGrants = this.#pendingSensitivePathGrants.filter(
      (candidate) => candidate !== path,
    );
    this.#sensitivePathGrantKey = undefined;
    if (!allow) {
      this.#presenter.setNotice(`Denied sensitive path ${path}`);
      this.#maybeOfferSensitivePathGrant();
      this.#maybeDrainFollowUps();
      this.#render();
      return;
    }
    try {
      const granted = await this.#runtime.grantSensitivePath(path);
      this.#presenter.setNotice(`Granted sensitive path ${granted}`);
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
    } catch (error) {
      this.#presenter.setNotice(message(error));
    }
    this.#maybeOfferSensitivePathGrant();
    this.#maybeDrainFollowUps();
    this.#render();
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
    if (!this.#canAutoOpenGate()) {
      this.#deferGate("Directory permission needs your attention");
      return;
    }
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
      this.#maybeDrainFollowUps();
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
    this.#maybeDrainFollowUps();
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
    if (!this.#canAutoOpenGate()) {
      this.#deferGate("Plan Review needs your attention");
      return;
    }
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
    if (!this.#canAutoOpenGate()) {
      this.#deferGate("Next Run needs your attention");
      return;
    }
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
    const view = this.#runtime.view();
    const review = view?.pendingReview;
    const revision = review ? view?.plans[review.planId]?.revisions[review.revision] : undefined;
    const formal = revision?.format === "formal_markdown";
    const items = [
      {
        id: "start",
        label: "开始实现",
        description: formal
          ? "接受完整计划并启动一个 Agent Executor Run"
          : "接受计划并启动第一项 Agent Run（一项一 Run）",
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
      hints: "完整计划已在时间线上方展示 · ↑↓ select · Enter confirm · Esc review/discuss",
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
          this.#presenter.setNotice("Plan accepted · starting the Executor Run.");
          this.#startTriggeredRun(accepted.runId, accepted.input);
          return;
        }
        if (verb === "revise") {
          this.#runtime.revisePlan(feedback);
          this.#presenter.update(this.#runtime.events(), this.#runtime.view());
          this.#planReviewKey = undefined;
          this.#panels.closeAll();
          const prompt = feedback?.trim()
            || "请根据审阅反馈读取并增量编辑正式计划；使用 plan_document edit，完成后重新请求审阅。";
          this.#presenter.setNotice("Revising Plan · updating plan_document…");
          this.#startPlanDraft(prompt);
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
      this.#startPlanDraft(prompt);
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

  #openPluginsBrowser(query = ""): void {
    this.#startManagementTask(() => this.#showPluginsBrowser(query), "Plugins");
  }

  async #showPluginsBrowser(query = ""): Promise<void> {
    const catalog = this.#runtime.plugins();
    const [marketplaces, installed, enabledKeys] = await Promise.all([
      catalog.listMarketplaces(),
      catalog.listInstalled(),
      catalog.listEnabled(),
    ]);
    const enabledMarketplaces = marketplaces.filter((marketplace) => marketplace.enabled);
    const enabledMarketplaceNames = new Set(enabledMarketplaces.map((marketplace) => marketplace.name));
    const entriesByMarketplace = await Promise.all(enabledMarketplaces.map(async (marketplace) => ({
      marketplace: marketplace.name,
      entries: await catalog.searchMarketplace(marketplace.name, ""),
    })));
    const installedById = new Map(installed.map((record) => [`${record.marketplace}:${record.name}`, record]));
    const enabled = new Set(enabledKeys);
    const items = new Map<string, PluginBrowserItem>();
    for (const { marketplace, entries } of entriesByMarketplace) {
      for (const entry of entries) {
        const id = `${marketplace}:${entry.name}`;
        const record = installedById.get(id);
        items.set(id, {
          id,
          pluginName: entry.name,
          name: entry.displayName?.trim() || entry.name,
          marketplace,
          description: entry.description,
          installed: record !== undefined,
          enabled: record !== undefined && enabled.has(record.key),
          ...(record?.version === undefined ? {} : { version: record.version }),
          ...(record?.sourceKind === undefined ? {} : { sourceKind: record.sourceKind }),
        });
      }
    }
    // Keep installed plugins visible after their *enabled* marketplace catalog has changed.
    // Disabled marketplaces stay out of All / Installed (and marketplace tabs); caches remain on disk.
    for (const record of installed) {
      if (!enabledMarketplaceNames.has(record.marketplace)) continue;
      const id = `${record.marketplace}:${record.name}`;
      if (!items.has(id)) {
        items.set(id, {
          id,
          pluginName: record.name,
          name: record.name,
          marketplace: record.marketplace,
          description: "Installed plugin no longer declared by its marketplace catalog.",
          installed: true,
          enabled: enabled.has(record.key),
          ...(record.version === undefined ? {} : { version: record.version }),
          sourceKind: record.sourceKind,
        });
      }
    }
    this.#syncAutocomplete();
    const marketplaceNames = enabledMarketplaces.map((entry) => entry.name);
    const initialMarketplace = marketplaceNames.includes(query) ? `marketplace:${query}` as const : undefined;
    this.#panels.push(new PluginBrowserPanel({
      items: [...items.values()],
      marketplaces: marketplaceNames,
      ...(initialMarketplace === undefined ? {} : { initialTab: initialMarketplace }),
      ...(query && initialMarketplace === undefined ? { initialQuery: query } : {}),
      maxVisible: Math.max(5, (this.#terminal.rows ?? 40) - 13),
      onOpen: (item) => this.#openPluginBrowserDetails(item),
      onToggle: (item) => this.#togglePluginFromBrowser(item),
      onManageMarketplaces: () => this.#openMarketplaceManagement(),
      onClose: this.#panels.dismiss,
    }));
  }

  #togglePluginFromBrowser(item: PluginBrowserItem): void {
    if (!item.installed) {
      this.#presenter.setNotice(`Install ${item.name} first: qi plugin install ${item.pluginName}@${item.marketplace}`);
      this.#render();
      return;
    }
    this.#startManagementTask(async () => {
      const catalog = this.#runtime.plugins();
      const key = `${item.pluginName}@${item.marketplace}`;
      if (item.enabled) await catalog.disable(key); else await catalog.enable(key);
      this.#presenter.setNotice(`${item.enabled ? "Disabled" : "Enabled"} plugin ${key}. Changes apply to the next Run.`);
      this.#panels.closeAll();
      await this.#showPluginsBrowser(item.marketplace);
    }, "Plugin");
  }

  #openPluginBrowserDetails(item: PluginBrowserItem): void {
    const actions = item.installed
      ? [
        {
          id: "toggle",
          label: item.enabled ? "Disable plugin" : "Enable plugin",
          description: item.enabled ? "Stops commands, agents, and selected Skills for future Runs." : "Enables the plugin; choose individual Skills separately.",
        },
        { id: "skills", label: "Choose Skills", description: "Open the per-Skill selection panel." },
        { id: "details", label: "View details", description: "Declared components, invocation policy, and current Skill state." },
      ]
      : [{ id: "install", label: "Install plugin", description: "Copies the pinned marketplace plugin into Qi's user cache; it remains disabled." }];
    this.#panels.push(new ListPanel({
      title: `${item.name} · ${item.marketplace}`,
      hints: "↑↓ select · Enter confirm · Esc back",
      items: actions,
      onClose: this.#panels.dismiss,
      onSelect: (action) => {
        if (action.id === "install") this.#installPluginFromBrowser(item);
        if (action.id === "toggle") this.#togglePluginFromBrowser(item);
        if (action.id === "skills") {
          this.#panels.closeAll();
          this.#openSkillsHubPanel();
        }
        if (action.id === "details") this.#openPluginBrowserDetailView(item);
      },
    }));
  }

  #installPluginFromBrowser(item: PluginBrowserItem): void {
    this.#startManagementTask(async () => {
      const installed = await this.#runtime.plugins().installMarketplacePlugin(item.marketplace, item.pluginName);
      this.#presenter.setNotice(`Installed plugin ${installed.record.key}. Enable it when you are ready; Skills start unchecked.`);
      this.#panels.closeAll();
      await this.#showPluginsBrowser(item.marketplace);
    }, "Plugin");
  }

  #openPluginBrowserDetailView(item: PluginBrowserItem): void {
    if (!item.installed) {
      this.#openScrollPanel(`${item.name} · ${item.marketplace}`, [
        "Available from marketplace",
        "",
        item.description,
        "",
        `Install from the action menu, or run: qi plugin install ${item.pluginName}@${item.marketplace}`,
        "Then enable the plugin, select the Skills you need under /skills, and start a new Run.",
      ]);
      return;
    }
    this.#startManagementTask(async () => {
      const catalog = this.#runtime.plugins();
      const key = `${item.pluginName}@${item.marketplace}`;
      const [inspection, statuses] = await Promise.all([
        catalog.inspectInstalled(key),
        catalog.listInstalledSkills(),
      ]);
      const skills = statuses.filter((status) => status.ref.pluginKey === key);
      const lines = [
        `${item.enabled ? "Enabled" : "Installed"} · ${key}${item.version ? ` · v${item.version}` : ""}`,
        item.description,
        "",
        `Support · ${inspection.support}`,
        `Components · ${inspection.components.map((component) => `${component.kind} (${component.ids.length})`).join(" · ") || "none"}`,
        "",
        "Skills",
        ...(skills.length === 0
          ? ["  No declared Skills."]
          : skills.map((status) => {
            const names = status.ref.declaredName && status.ref.declaredName !== status.ref.name
              ? `${status.ref.name} · ${status.ref.declaredName}`
              : status.ref.name;
            return `  ${status.enabled ? "[*]" : status.selected ? "[~]" : "[ ]"} ${names} · ${status.ref.invocationMode}${status.blockedReason ? ` · ${status.blockedReason}` : ""}`;
          })),
        "",
        item.enabled
          ? "Space in the browser disables this plugin. Use /skills to choose individual Skills."
          : "Space in the browser enables this plugin; individual Skills remain unchecked until selected.",
      ];
      this.#openScrollPanel(`${item.name} · ${item.marketplace}`, lines);
    }, "Plugin");
  }

  #openMarketplaceManagement(): void {
    this.#startManagementTask(async () => {
      const marketplaces = await this.#runtime.plugins().listMarketplaces();
      this.#panels.push(new ListPanel({
        title: "Manage marketplaces",
        hints: "↑↓ select · Enter manage · Esc back",
        items: [
          {
            id: "add",
            label: "+ Add marketplace",
            description: "Register a new local clone or GitHub marketplace source.",
          },
          ...marketplaces.map((marketplace) => ({
            id: `market:${marketplace.name}`,
            label: `${marketplace.enabled ? "[*]" : "[ ]"} ${marketplace.name}`,
            description: `${marketplaceSourceSummary(marketplace)} · sync / enable / browse`,
          })),
        ],
        onClose: this.#panels.dismiss,
        onSelect: (item) => {
          if (item.id === "add") { this.#openAddMarketplaceForm(); return; }
          const name = item.id.slice("market:".length);
          const current = marketplaces.find((marketplace) => marketplace.name === name);
          if (current) this.#openMarketplaceActions(current);
        },
      }));
    }, "Marketplace");
  }

  #openMarketplaceActions(marketplace: {
    readonly name: string;
    readonly enabled: boolean;
    readonly source: { readonly kind: string; readonly repo?: string; readonly ref?: string; readonly path?: string };
    readonly resolvedRevision?: string;
    readonly lastUpdated?: string;
  }): void {
    const sourceLabel = marketplace.source.kind === "github"
      ? `github:${marketplace.source.repo ?? "?"}${marketplace.source.ref ? `@${marketplace.source.ref}` : ""}`
      : `local:${marketplace.source.path ?? "?"}`;
    const revision = marketplace.resolvedRevision
      ? marketplace.resolvedRevision.slice(0, 7)
      : undefined;
    this.#panels.push(new ListPanel({
      title: `Manage · ${marketplace.name}`,
      hints: "↑↓ select · Enter run · Esc back",
      items: [
        {
          id: "sync",
          label: marketplace.enabled ? "↻ Sync catalog" : "↻ Sync catalog (enable first)",
          description: marketplace.source.kind === "github"
            ? `Pull latest marketplace.json · ${sourceLabel}${revision ? ` · now ${revision}` : ""}`
            : `Refresh local checkout metadata · ${sourceLabel}`,
        },
        {
          id: "toggle",
          label: marketplace.enabled ? "Disable source" : "Enable source",
          description: marketplace.enabled
            ? "Stop sync/install and disable plugins from this source; caches stay on disk."
            : "Allow browsing, sync, and new installs. Plugins stay disabled until enabled.",
        },
        {
          id: "browse",
          label: "Browse plugins",
          description: marketplace.enabled
            ? "Open this marketplace’s plugin catalog tab."
            : "Enable the source first to browse its catalog.",
        },
      ],
      onClose: this.#panels.dismiss,
      onSelect: (action) => {
        if (action.id === "sync") {
          this.#syncMarketplace(marketplace.name);
          return;
        }
        if (action.id === "toggle") {
          this.#setMarketplaceEnabled(marketplace.name, !marketplace.enabled);
          return;
        }
        if (action.id === "browse") {
          if (!marketplace.enabled) {
            this.#presenter.setNotice(`Enable marketplace ${marketplace.name} before browsing its catalog.`);
            this.#render();
            return;
          }
          this.#panels.closeAll();
          void this.#showPluginsBrowser(marketplace.name);
        }
      },
    }));
  }

  #syncMarketplace(name: string): void {
    this.#startManagementTask(async () => {
      this.#presenter.setNotice(`Syncing marketplace ${name}…`);
      this.#render();
      const updated = await this.#runtime.plugins().syncMarketplace(name);
      const revision = updated.resolvedRevision ? ` · ${updated.resolvedRevision.slice(0, 7)}` : "";
      this.#presenter.setNotice(
        `Synced marketplace ${updated.name}${revision}. Catalog is current; re-install a plugin to pick up content changes.`,
      );
      this.#panels.closeAll();
      await this.#showPluginsBrowser(updated.enabled ? updated.name : undefined);
    }, "Marketplace");
  }

  #openAddMarketplaceForm(): void {
    this.#panels.push(new FormPanel({
      title: "Add marketplace source",
      description: "Register a local clone or GitHub marketplace. Nothing is installed or enabled yet; use Manage → Sync after add if needed.",
      fields: [
        { id: "name", label: "Marketplace name", placeholder: "mattpocock", required: true },
        {
          id: "sourceKind",
          label: "Source",
          options: [
            { value: "local", label: "Local clone", description: "Use an existing local marketplace checkout." },
            { value: "github", label: "GitHub", description: "Clone owner/repository into Qi's private marketplace cache." },
          ],
        },
        { id: "location", label: "Path or repository", placeholder: "D:\\gh-ws\\skill-ws\\mattpocock-skills", required: true },
      ],
      submitLabel: "Add marketplace",
      onClose: this.#panels.dismiss,
      onSubmit: (values) => {
        const name = values.name?.trim() ?? "";
        const location = values.location?.trim() ?? "";
        const kind = values.sourceKind === "github" ? "github" : "local";
        this.#panels.closeAll();
        this.#addMarketplaceFromBrowser(name, kind, location);
      },
    }));
  }

  #addMarketplaceFromBrowser(name: string, kind: "local" | "github", location: string): void {
    this.#startManagementTask(async () => {
      if (!name) throw new TypeError("Marketplace name is required.");
      if (!location) throw new TypeError(kind === "local" ? "Local marketplace path is required." : "GitHub owner/repository is required.");
      const source = kind === "local"
        ? { kind, path: resolve(location) } as const
        : { kind, repo: location.replace(/^github:/i, "") } as const;
      const marketplace = await this.#runtime.plugins().addMarketplace(name, source);
      this.#presenter.setNotice(`Added marketplace ${marketplace.name}. Select a plugin and choose Install.`);
      await this.#showPluginsBrowser(marketplace.name);
    }, "Marketplace");
  }

  #setMarketplaceEnabled(name: string, enabled: boolean): void {
    this.#startManagementTask(async () => {
      const marketplace = await this.#runtime.plugins().setMarketplaceEnabled(name, enabled);
      this.#presenter.setNotice(marketplace.enabled
        ? `Enabled marketplace ${marketplace.name}. Plugins remain disabled until you enable them explicitly.`
        : `Disabled marketplace ${marketplace.name} and all of its enabled plugins. Installed caches are retained.`);
      this.#panels.closeAll();
      await this.#showPluginsBrowser();
    }, "Marketplace");
  }

  #openInspectPanel(panel: TuiPanel, title?: string): void {
    this.#openScrollPanel(title ?? `/${panel}`, this.#presenter.renderPanel(panel));
  }

  #syncAutocomplete(): void {
    const generation = ++this.#autocompleteGeneration;
    const commands = [...autocompleteSlashCommands(this.#presenter.locale())];
    const preserve = new Set(
      tuiCommands.filter((command) => command.draftPolicy === "preserve").map((command) => command.name),
    );
    const install = (
      fdPath?: string,
      pluginSkills: readonly {
        readonly id: string;
        readonly name: string;
        readonly marketplace: string;
        readonly plugin: string;
        readonly declaredName?: string;
      }[] = [],
      pluginCommandIds: readonly string[] = [],
      agentIds: readonly string[] = [],
    ) => this.#editor.setAutocompleteProvider(
      new WorkspaceAutocompleteProvider(
        commands,
        this.#presenter.launch.workspaceRoot,
        fdPath,
        preserve,
        this.#runtime.skillCatalog().map((skill) => skill.name),
        pluginCommandIds,
        agentIds,
        pluginSkills,
      ),
    );
    install();
    void Promise.all([
      findTrustedExecutable("fd", this.#presenter.launch.workspaceRoot),
      this.#runtime.plugins().listInstalledSkills()
        .then((entries) => entries
          .filter((entry) => entry.enabled && entry.ref.userInvocable)
          .map((entry) => ({
            id: entry.ref.id,
            name: entry.ref.name,
            marketplace: entry.ref.marketplace,
            plugin: entry.ref.plugin,
            ...(entry.ref.declaredName === undefined ? {} : { declaredName: entry.ref.declaredName }),
          }))).catch(() => []),
      this.#runtime.plugins().listCommands().then((entries) => entries.map((entry) => entry.id)).catch(() => []),
      this.#runtime.plugins().listAgents().then((entries) => entries.map((entry) => entry.id)).catch(() => []),
    ]).then(([fdPath, pluginSkills, pluginCommandIds, agentIds]) => {
      if (generation === this.#autocompleteGeneration && !this.#closing) {
        install(fdPath, pluginSkills, pluginCommandIds, agentIds);
      }
    });
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
        disabledCapabilities: ["write", "verify", "network", "execute", "background", "delegate"]
          .filter((capability) => !applied.labels.includes(capability)),
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

  #saveShell(shell: import("./config.js").QiShellConfig): void {
    if (this.#runtime.active) {
      this.#presenter.setNotice("Cannot change shell profiles while a Run is active.");
      this.#render();
      return;
    }
    this.#startManagementTask(async () => {
      const configPath = this.#presenter.launch.configPath ?? defaultUserConfigPath();
      const snapshot = await this.#runtime.applyShellConfig(shell, { configPath });
      this.#presenter.launch = {
        ...this.#presenter.launch,
        shell: snapshot,
      };
      this.#presenter.setNotice(
        t(this.#presenter.locale(), "shell.saved", {
          profiles: snapshot.allowed.join(", "),
        }),
      );
    }, "Shell");
  }

  #saveMaxSteps(maxSteps: number): void {
    if (this.#runtime.active) {
      this.#presenter.setNotice(t(this.#presenter.locale(), "max_steps.active"));
      this.#render();
      return;
    }
    this.#startManagementTask(async () => {
      const configPath = this.#presenter.launch.configPath ?? defaultUserConfigPath();
      const applied = await this.#runtime.applyMaxSteps(maxSteps, { configPath });
      this.#presenter.launch = {
        ...this.#presenter.launch,
        maxSteps: applied.maxSteps,
      };
      const locale = this.#presenter.locale();
      let notice = t(locale, "max_steps.saved", {
        steps: String(applied.maxSteps),
        path: applied.configPath,
      });
      if (applied.projectOverride !== undefined) {
        notice += ` · ${t(locale, "max_steps.project_override", {
          steps: String(applied.projectOverride),
        })}`;
      }
      this.#presenter.setNotice(notice);
    }, "Step budget");
  }

  #saveMaxActionsPerStep(maxActionsPerStep: number): void {
    if (this.#runtime.active) {
      this.#presenter.setNotice(t(this.#presenter.locale(), "max_actions_per_step.active"));
      this.#render();
      return;
    }
    this.#startManagementTask(async () => {
      const configPath = this.#presenter.launch.configPath ?? defaultUserConfigPath();
      const applied = await this.#runtime.applyMaxActionsPerStep(maxActionsPerStep, { configPath });
      this.#presenter.launch = {
        ...this.#presenter.launch,
        maxActionsPerStep: applied.maxActionsPerStep,
      };
      const locale = this.#presenter.locale();
      this.#presenter.setNotice(t(locale, "max_actions_per_step.saved", {
        count: String(applied.maxActionsPerStep),
        path: applied.configPath,
      }));
    }, "Action batch");
  }

  #saveDelegateConfig(patch: QiDelegateConfig): void {
    this.#startManagementTask(async () => {
      const configPath = this.#presenter.launch.configPath ?? defaultUserConfigPath();
      const applied = await this.#runtime.applyDelegateConfig(patch, { configPath });
      const locale = this.#presenter.locale();
      const wallMinutes = Math.max(1, Math.round(applied.config.wallTimeMs / 60_000));
      this.#presenter.setNotice(t(locale, "subagent.saved", {
        wall: locale === "zh" ? `${wallMinutes} 分钟` : `${wallMinutes}m`,
        steps: String(applied.config.maxStepsPercent),
        context: String(applied.config.contextTokensPercent),
        path: applied.configPath,
      }));
    }, "Subagent budget");
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
    this.#presenter.setNotice(`Installing Skill from ${trimmed}…`);
    this.#render();
    this.#startSkillTask(async () => {
      const installed = await this.#runtime.installSkill(trimmed, scope);
      this.#presenter.setSkills(this.#runtime.skillCatalog(), this.#runtime.skillCandidates());
      this.#syncAutocomplete();
      this.#presenter.setNotice(
        `Installed ${installed.name} ${installed.version} in ${installed.scope} scope.`,
      );
      openSkillsHubPanel(this.#panelFlow());
    });
  }

  #removeSkill(name: string, scope: "user" | "workspace"): void {
    if (this.#runtime.active) {
      this.#presenter.setNotice("Cannot remove a Skill while a Run is active.");
      this.#render();
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      this.#presenter.setNotice(t(this.#presenter.locale(), "skills.remove.empty"));
      this.#render();
      return;
    }
    this.#presenter.setNotice(`Removing Skill ${trimmed} from ${scope} scope…`);
    this.#render();
    this.#startSkillTask(async () => {
      const removed = await this.#runtime.removeSkill(trimmed, scope);
      this.#presenter.setSkills(this.#runtime.skillCatalog(), this.#runtime.skillCandidates());
      this.#syncAutocomplete();
      this.#presenter.setNotice(
        t(this.#presenter.locale(), "skills.remove.success", {
          name: removed.name,
          scope: removed.scope,
        }),
      );
      openSkillsHubPanel(this.#panelFlow());
    });
  }

  #installGithubSkill(url: string, name: string, scope: "user" | "workspace"): void {
    if (this.#runtime.active) {
      this.#presenter.setNotice("Cannot install a Skill while a Run is active.");
      this.#render();
      return;
    }
    this.#presenter.setNotice(`Installing Skill ${name} from ${url}…`);
    this.#render();
    this.#startSkillTask(async () => {
      const installed = await this.#runtime.installGithubSkill(url, name, scope);
      this.#presenter.setSkills(this.#runtime.skillCatalog(), this.#runtime.skillCandidates());
      this.#syncAutocomplete();
      this.#presenter.setNotice(
        `Installed ${installed.name} ${installed.version} in ${installed.scope} scope (GitHub commit pinned).`,
      );
      openSkillsHubPanel(this.#panelFlow());
    });
  }

  #installSkillFromArgument(argument: string): void {
    try {
      const request = parseSkillInstallCommand(argument);
      if ("skill" in request) this.#installGithubSkill(request.source, request.skill, request.scope);
      else this.#installSkill(request.source, request.scope);
    } catch (error) {
      this.#presenter.setNotice(message(error));
      this.#render();
    }
  }

  #openSkillsHubPanel(): void {
    this.#startSkillTask(async () => {
      const skills = await this.#runtime.refreshSkills();
      this.#presenter.setSkills(skills, this.#runtime.skillCandidates());
      this.#syncAutocomplete();
      openSkillsHubPanel(this.#panelFlow());
    });
  }

  #activateAgentSkill(name: string): void {
    const trimmed = name.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
      this.#presenter.setNotice("Usage: /skill enable <global .agents Skill name>");
      this.#render();
      return;
    }
    this.#startManagementTask(async () => {
      const activated = await this.#runtime.activateAgentSkill(trimmed);
      this.#presenter.setSkills(this.#runtime.skillCatalog(), this.#runtime.skillCandidates());
      this.#syncAutocomplete();
      this.#presenter.setNotice(`Activated global Agent Skill ${activated.name}.`);
      openSkillsHubPanel(this.#panelFlow());
    }, "Skill");
  }

  #deactivateAgentSkill(name: string): void {
    const trimmed = name.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
      this.#presenter.setNotice("Usage: /skill disable <global .agents Skill name>");
      this.#render();
      return;
    }
    this.#startManagementTask(async () => {
      const changed = await this.#runtime.deactivateAgentSkill(trimmed);
      this.#presenter.setSkills(this.#runtime.skillCatalog(), this.#runtime.skillCandidates());
      this.#syncAutocomplete();
      this.#presenter.setNotice(
        changed ? `Deactivated global Agent Skill ${trimmed}.` : `Global Agent Skill ${trimmed} was not active.`,
      );
      this.#openInspectPanel("skills", "/skills");
    }, "Skill");
  }

  #saveAgentSkillActivation(names: readonly string[]): void {
    const desired = new Set(names);
    const current = new Set(
      this.#runtime.skillCatalog()
        .filter((skill) => skill.scope === "user" && skill.origin === "agent")
        .map((skill) => skill.name),
    );
    this.#startManagementTask(async () => {
      for (const name of current) {
        if (!desired.has(name)) await this.#runtime.deactivateAgentSkill(name);
      }
      for (const name of desired) {
        if (!current.has(name)) await this.#runtime.activateAgentSkill(name);
      }
      const skills = await this.#runtime.refreshSkills();
      this.#presenter.setSkills(skills, this.#runtime.skillCandidates());
      this.#syncAutocomplete();
      this.#presenter.setNotice("Skill activation updated.");
      openSkillsHubPanel(this.#panelFlow());
    }, "Skill");
  }

  #togglePluginSkillSelection(id: string, selected: boolean, onSuccess?: () => void): void {
    this.#startManagementTask(async () => {
      const statuses = await this.#runtime.plugins().listInstalledSkills();
      const status = statuses.find((entry) => entry.ref.id === id);
      if (!status) throw new Error(`Unknown plugin Skill: ${id}`);
      if (status.selected !== selected) {
        if (selected) await this.#runtime.plugins().enableSkill(id);
        else await this.#runtime.plugins().disableSkill(id);
      }
      this.#presenter.setNotice(`${selected ? "Enabled" : "Disabled"} plugin Skill ${id}. Changes apply to the next Run.`);
      this.#syncAutocomplete();
      onSuccess?.();
    }, "Plugin Skill");
  }

  #stopJobFromArgument(argument: string, reopenJobPicker = false): void {
    try {
      const token = parseJobStopCommand(argument);
      const jobs = this.#runtime.tasks();
      const numeric = /^\d+$/.test(token) ? jobs[Number(token) - 1]?.taskId : undefined;
      const taskId = numeric ?? token;
      this.#startManagementTask(async () => {
        await this.#runtime.stopTask(taskId);
        this.#presenter.update(this.#runtime.events(), this.#runtime.view());
        this.#presenter.setNotice(t(this.#presenter.locale(), "jobs.stop.success", { taskId }));
        if (reopenJobPicker) openJobsHubPanel(this.#panelFlow());
        else this.#openInspectPanel("jobs", "/jobs");
      }, "Job");
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
      density: () => this.#presenter.density(),
      changeDensity: (density, persist) => {
        this.#presenter.setDensity(density);
        this.#render();
        if (!persist) return;
        const configPath = this.#presenter.launch.configPath ?? defaultUserConfigPath();
        this.#startManagementTask(async () => {
          await persistUserTimelineDensity(density, configPath);
          this.#presenter.setNotice(
            this.#presenter.locale() === "zh"
              ? `时间线密度已保存：${density}`
              : `Timeline density saved: ${density}`,
          );
        }, "Timeline density");
      },
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
      mcpStatuses: () => this.#runtime.mcpStatuses(),
      mcpReview: () => this.#runtime.mcpReview(),
      refreshMcp: (server) => this.#runtime.refreshMcp(server),
      bindMcp: (input) => this.#runtime.bindMcp(input),
      unbindMcp: (server, kind, name) => this.#runtime.unbindMcp(server, kind, name),
      beginMcpLogin: (server) => this.#runtime.beginMcpLogin(server),
      finishMcpLogin: (server, callbackUrl) => this.#runtime.finishMcpLogin(server, callbackUrl),
      logoutMcp: (server) => this.#runtime.logoutMcp(server),
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
      configureModel: (routing, persistence) => {
        this.#configureModel(routing, persistence);
      },
      openInspect: (panel, title) => {
        if (panel === "skills") {
          this.#startSkillTask(async () => {
            const skills = await this.#runtime.refreshSkills();
            this.#presenter.setSkills(skills, this.#runtime.skillCandidates());
            this.#syncAutocomplete();
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
      discoveredSkills: () => this.#presenter.skills(),
      skillCandidates: () => this.#presenter.skillCandidates(),
      pluginSkillStatuses: (query) => this.#runtime.plugins().listInstalledSkills(query),
      listEnabledMarketplaces: async () => {
        const marketplaces = await this.#runtime.plugins().listMarketplaces();
        return marketplaces.filter((entry) => entry.enabled).map((entry) => entry.name);
      },
      togglePluginSkillSelection: (id, selected, onSuccess) => this.#togglePluginSkillSelection(id, selected, onSuccess),
      saveAgentSkillActivation: (names) => this.#saveAgentSkillActivation(names),
      openHistoryList: (kind) => {
        openHistoryListPanel(this.#panelFlow(), kind);
      },
      addMount: (path) => this.#addMountFromPath(path),
      removeMount: (mountId) => this.#removeMountById(mountId),
      effectiveCapabilities: () => capabilityIdsFromLaunchLabels(this.#runtime.capabilityLabels()),
      saveCapabilities: (capabilities) => this.#saveCapabilities(capabilities),
      saveShell: (shell) => this.#saveShell(shell),
      currentMaxSteps: () => this.#runtime.maxSteps(),
      saveMaxSteps: (maxSteps) => this.#saveMaxSteps(maxSteps),
      currentMaxActionsPerStep: () => this.#runtime.maxActionsPerStep(),
      saveMaxActionsPerStep: (maxActionsPerStep) => this.#saveMaxActionsPerStep(maxActionsPerStep),
      currentDelegateConfig: () => this.#runtime.delegateConfig(),
      saveDelegateConfig: (patch) => this.#saveDelegateConfig(patch),
      applyVerificationSetup: (selected) => this.#applyVerificationSetup(selected),
      installSkill: (source, scope) => this.#installSkill(source, scope),
      installGithubSkill: (url, name, scope) => this.#installGithubSkill(url, name, scope),
      removeSkill: (name, scope) => this.#removeSkill(name, scope),
      listTasks: () => this.#runtime.tasks(),
      stopTask: (taskId) => this.#stopJobFromArgument(`stop ${taskId}`, true),
      listSessions: () => buildSessionEntries(this.#runtime.listSessionCatalog(), {
        workspaceRoot: this.#presenter.launch.workspaceRoot,
        readEvents: (sessionId) => this.#runtime.readSessionEvents(sessionId),
      }),
      currentSessionId: () => this.#runtime.sessionId,
      workspaceRoot: () => this.#presenter.launch.workspaceRoot,
      resumeSession: (sessionId) => {
        void this.close({ kind: "resume", sessionId });
      },
      archiveSession: (sessionId) => {
        const blockers = this.#runtime.sessionArchiveBlockers(sessionId);
        if (blockers.length > 0) {
          this.#presenter.setNotice(`Archive blocked · ${blockers.join(" · ")}`);
          this.#render();
          return;
        }
        void this.close({ kind: "archive", sessionId });
      },
      restoreSession: (sessionId) => {
        void this.close({ kind: "restore", sessionId });
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

  #openMemoryPanel(scope?: "session" | "project" | "user" | "pending"): void {
    const usage = memoryUsageInLatestRun(this.#runtime.events());
    const claims = this.#runtime.listMemories().filter((claim) => {
      if (!scope) return true;
      if (scope === "pending") return claim.status === "candidate";
      if (scope === "project") {
        return typeof claim.scope !== "string" &&
          (claim.scope.kind === "session" || claim.scope.kind === "project");
      }
      return typeof claim.scope !== "string" && claim.scope.kind === scope;
    });
    this.#openScrollPanel(
      "/memory",
      formatMemoryClaims(claims, {
        title: scope ? `${scope[0]?.toUpperCase()}${scope.slice(1)} Memory` : "Memory",
        usedMemoryIds: usage.included,
        omittedMemoryIds: usage.omitted,
      }),
    );
    this.#render();
  }

  #openUsedMemoryPanel(): void {
    const used = memoryIdsUsedInLatestRun(this.#runtime.events());
    this.#openScrollPanel(
      "Used this Run",
      formatMemoryClaims(
        this.#runtime.listMemories().filter((claim) => used.has(claim.memoryId)),
        { title: "Used this Run", usedMemoryIds: used },
      ),
    );
    this.#render();
  }

  #openMemoryHub(): void {
    const claims = this.#runtime.listMemories();
    const used = memoryIdsUsedInLatestRun(this.#runtime.events());
    const count = (predicate: (claim: (typeof claims)[number]) => boolean) => claims.filter(predicate).length;
    this.#panels.push(new ListPanel({
      title: "Memory",
      hints: "↑↓ select · Enter open · Esc close",
      items: [
        {
          id: "used",
          label: "Used this Run",
          description: `${used.size} actually included ContextBlock${used.size === 1 ? "" : "s"}`,
        },
        {
          id: "pending",
          label: "Pending",
          description: `${count((claim) => claim.status === "candidate")} candidates await review`,
        },
        {
          id: "project",
          label: "Project",
          description: `${count((claim) =>
            typeof claim.scope !== "string" &&
            (claim.scope.kind === "session" || claim.scope.kind === "project"))} project-local claims`,
        },
        {
          id: "user",
          label: "User",
          description: `${count((claim) =>
            typeof claim.scope !== "string" && claim.scope.kind === "user")} explicit cross-project claims`,
        },
        {
          id: "add",
          label: "Add Memory",
          description: "confirm final scope, activation, and plaintext storage",
        },
        {
          id: "all",
          label: "All lifecycle entries",
          description: `${claims.length} claims across available indexes`,
        },
      ],
      onClose: this.#panels.dismiss,
      onSelect: (item) => {
        if (item.id === "add") {
          this.#openRememberMemoryForm();
          return;
        }
        if (item.id === "used") {
          this.#openUsedMemoryPanel();
          return;
        }
        this.#openMemoryPanel(
          item.id === "pending" || item.id === "project" || item.id === "user"
            ? item.id
            : undefined,
        );
      },
    }));
    this.#render();
  }

  #openRememberMemoryForm(): void {
    this.#panels.push(new FormPanel({
      title: "Add Memory",
      description:
        "Session/Project stays in this project. User is stored as machine-private plaintext " +
        "under $QI_HOME and is available across projects only after this submission.",
      fields: [
        {
          id: "scope",
          label: "Final scope",
          options: [
            { value: "project", label: "Project", description: "all Sessions in this project" },
            { value: "session", label: "Session", description: "this Session only" },
            { value: "user", label: "User", description: "explicit cross-project continuity" },
          ],
          required: true,
        },
        {
          id: "activation",
          label: "Activation",
          options: [
            { value: "relevant", label: "Relevant", description: "retrieve when the query matches" },
            { value: "always", label: "Always", description: "User scope only; at most four" },
          ],
          required: true,
        },
        {
          id: "statement",
          label: "Memory",
          placeholder: "What should Qi remember?",
          required: true,
        },
      ],
      submitLabel: "Confirm Memory",
      onClose: this.#panels.dismiss,
      onSubmit: (values) => {
        const scope = values.scope as "session" | "project" | "user";
        const activation = values.activation as "relevant" | "always";
        if (activation === "always" && scope !== "user") {
          this.#presenter.setNotice("Always activation is only available for User Memory.");
          this.#render();
          return;
        }
        this.#panels.closeAll();
        this.#runMemoryOperation(() =>
          this.#runtime.rememberMemory(values.statement ?? "", scope, activation),
        );
      },
    }));
    this.#render();
  }

  #runMemoryOperation(operation: () => { memoryId: string; statement: string; status: string }): void {
    this.#startManagementTask(async () => {
      const claim = operation();
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
      this.#presenter.setNotice(
        `Memory ${claim.memoryId} · ${claim.status} · ${claim.statement}`,
      );
    }, "Memory");
  }

  #handleGoalCommand(argument: string): void {
    const parsed = parseGoalCommand(argument);
    if (parsed.mode === "hub") {
      this.#openGoalHub();
      return;
    }
    this.#createAndStartGoal(parsed.objective);
  }

  #openGoalHub(): void {
    const summary = goalHubSummary(this.#runtime.view());
    const items: Array<{ id: string; label: string; description?: string }> = [
      {
        id: "status",
        label: summary.title,
        description: summary.detail,
      },
    ];
    if (summary.state === "none" || summary.state === "complete" || summary.state === "cancelled") {
      items.push({
        id: "create",
        label: "Create Goal…",
        description: "Enter an objective, or use /goal <objective>",
      });
    }
    if (summary.state === "active" || summary.state === "paused" || summary.state === "blocked") {
      const resuming = summary.state === "paused" || summary.state === "blocked";
      items.push({
        id: "continue",
        label: resuming ? "Resume & Continue" : "Continue",
        description: "Start the next Goal-bound Run from the objective (no prompt)",
      });
      items.push({
        id: "continue_guidance",
        label: resuming ? "Resume & Continue with guidance…" : "Continue with guidance…",
        description: "Optional corrections become the next Run input",
      });
    }
    if (summary.state === "active") {
      items.push({
        id: "pause",
        label: "Pause",
        description: "Pause 追寻; Continue is required to resume",
      });
    }
    if (summary.state === "paused" || summary.state === "blocked") {
      items.push({
        id: "resume",
        label: "Resume",
        description: "Mark Goal active without starting a Run",
      });
    }
    if (summary.state === "active" || summary.state === "paused" || summary.state === "blocked") {
      items.push({
        id: "accept",
        label: "Accept with evidence…",
        description: "Human pass into Evidence Ledger; may complete the Goal",
      });
      items.push({
        id: "reassess",
        label: "Re-evaluate…",
        description: "Human pass/fail/unknown with rationale → Evidence Ledger",
      });
      items.push({
        id: "cancel",
        label: "Cancel Goal",
        description: "Terminal cancel; does not complete with evidence",
      });
    }
    this.#panels.push(new ListPanel({
      title: "Goal / 追寻",
      hints: "↑↓ select · Enter · Esc close",
      items,
      onClose: this.#panels.dismiss,
      onSelect: (item) => {
        if (item.id === "status") {
          this.#openScrollPanel("/goal", formatGoalStatus(this.#runtime.view()));
          return;
        }
        if (item.id === "create") {
          this.#openCreateGoalForm();
          return;
        }
        if (item.id === "continue") {
          this.#panels.closeAll();
          this.#continueGoal();
          return;
        }
        if (item.id === "continue_guidance") {
          this.#openContinueGoalForm(summary.state === "paused" || summary.state === "blocked");
          return;
        }
        if (item.id === "accept") {
          this.#openAcceptGoalForm();
          return;
        }
        if (item.id === "reassess") {
          this.#openReassessGoalForm();
          return;
        }
        if (item.id === "pause" || item.id === "resume" || item.id === "cancel") {
          this.#panels.closeAll();
          this.#changeGoalStateFromHub(item.id);
          return;
        }
      },
    }));
    this.#render();
  }

  #openContinueGoalForm(resuming: boolean): void {
    this.#panels.push(new FormPanel({
      title: resuming ? "Resume & Continue Goal" : "Continue Goal",
      description:
        "Optional guidance becomes the next Goal-bound Run input (corrections, constraints, next slice). " +
        "Leave empty to continue from the Goal objective. Use /steer while a Run is active for in-Run course correction.",
      fields: [
        {
          id: "guidance",
          label: "Guidance",
          placeholder: "What should the next slice focus on? (optional)",
        },
      ],
      submitLabel: resuming ? "Resume & Continue" : "Continue",
      onClose: this.#panels.dismiss,
      onSubmit: (values) => {
        const guidance = (values.guidance ?? "").trim();
        this.#panels.closeAll();
        this.#continueGoal(guidance || undefined);
      },
    }));
    this.#render();
  }

  #openAcceptGoalForm(): void {
    this.#panels.push(new FormPanel({
      title: "Accept Goal evidence",
      description:
        "Records human evidence for each required assertion. Completes the Goal only when the ledger and evaluations satisfy the contract.",
      fields: [
        {
          id: "note",
          label: "Acceptance note",
          placeholder: "Why this Goal is accepted (optional)",
        },
      ],
      submitLabel: "Accept evidence",
      onClose: this.#panels.dismiss,
      onSubmit: (values) => {
        this.#panels.closeAll();
        this.#acceptGoalEvidence(values.note);
      },
    }));
    this.#render();
  }

  #acceptGoalEvidence(note?: string): void {
    this.#startManagementTask(async () => {
      const result = await this.#runtime.acceptGoalEvidence(note);
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
      this.#presenter.setNotice(
        result.completed
          ? `Goal complete · human evidence · ${result.goal.goalId}`
          : `Human evidence recorded · Goal ${result.goal.state} · ledger may still have gaps · ${result.goal.goalId}`,
      );
    }, "Goal");
  }

  #openReassessGoalForm(): void {
    this.#panels.push(new FormPanel({
      title: "Re-evaluate Goal",
      description:
        "Writes human Evidence Ledger entries and evaluations. Pass may complete; fail/unknown keep the Goal open for Continue",
      fields: [
        {
          id: "outcome",
          label: "Outcome",
          required: true,
          options: [
            { value: "pass", label: "pass", description: "Assertions met; may complete Goal" },
            { value: "fail", label: "fail", description: "Not met; Continue or add guidance" },
            { value: "unknown", label: "unknown", description: "Cannot judge yet" },
          ],
        },
        {
          id: "rationale",
          label: "Rationale",
          placeholder: "Required for fail/unknown; optional for pass",
        },
      ],
      submitLabel: "Record evaluation",
      onClose: this.#panels.dismiss,
      onSubmit: (values) => {
        const outcome = (values.outcome ?? "").trim() as EvalOutcome;
        if (outcome !== "pass" && outcome !== "fail" && outcome !== "unknown") {
          this.#presenter.setNotice("Outcome must be pass, fail, or unknown.");
          this.#render();
          return;
        }
        const rationale = (values.rationale ?? "").trim();
        if ((outcome === "fail" || outcome === "unknown") && !rationale) {
          this.#presenter.setNotice("Rationale is required for fail or unknown.");
          this.#render();
          return;
        }
        this.#panels.closeAll();
        this.#reassessGoalEvidence(outcome, rationale);
      },
    }));
    this.#render();
  }

  #reassessGoalEvidence(outcome: EvalOutcome, rationale: string): void {
    this.#startManagementTask(async () => {
      const result = await this.#runtime.reassessGoalEvidence({ outcome, rationale });
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
      if (result.completed) {
        this.#presenter.setNotice(`Goal complete · human ${outcome} · ${result.goal.goalId}`);
        return;
      }
      if (outcome === "pass") {
        this.#presenter.setNotice(
          `Human pass recorded · Goal ${result.goal.state} · check Evidence Ledger gaps · ${result.goal.goalId}`,
        );
        return;
      }
      this.#presenter.setNotice(
        `Human ${outcome} recorded · Goal ${result.goal.state} · Continue or Continue with guidance… · ${result.goal.goalId}`,
      );
    }, "Goal");
  }

  #openCreateGoalForm(): void {
    this.#panels.push(new FormPanel({
      title: "Create Goal",
      description: "Session-local 追寻 · evidence still required for completion",
      fields: [
        {
          id: "objective",
          label: "Objective",
          placeholder: "What should Qi pursue?",
          required: true,
        },
      ],
      submitLabel: "Create & Continue",
      onClose: this.#panels.dismiss,
      onSubmit: (values) => {
        const objective = (values.objective ?? "").trim();
        if (!objective) {
          this.#presenter.setNotice("Objective is required.");
          this.#render();
          return;
        }
        this.#panels.closeAll();
        this.#createAndStartGoal(objective);
      },
    }));
    this.#render();
  }

  #createAndStartGoal(objective: string): void {
    if (this.#runtime.active) {
      this.#presenter.setNotice("A Run is active; wait or /cancel before /goal");
      this.#render();
      return;
    }
    try {
      const goal = this.#runtime.createGoal(defaultGoalContract(objective, this.#runtime.maxSteps()));
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
      this.#presenter.setNotice(`Goal created · ${goal.goalId} · starting 追寻…`);
      this.#startTurn(() => this.#runtime.continueGoal());
    } catch (error) {
      this.#presenter.setNotice(error instanceof Error ? error.message : String(error));
      this.#render();
    }
  }

  #continueGoal(input?: string): void {
    if (this.#runtime.active) {
      this.#presenter.setNotice("A Run is active; wait or /cancel before Continue");
      this.#render();
      return;
    }
    this.#startTurn(() => this.#runtime.continueGoal(input));
  }

  #changeGoalStateFromHub(action: "pause" | "resume" | "cancel"): void {
    try {
      const state = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
      const reason = action === "pause"
        ? "Paused by user"
        : action === "resume"
          ? "Resumed by user"
          : "Cancelled by user";
      const goal = this.#runtime.changeGoalState(state, reason);
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
      this.#presenter.setNotice(`Goal ${goal.state} · ${goal.goalId}`);
      this.#render();
    } catch (error) {
      this.#presenter.setNotice(error instanceof Error ? error.message : String(error));
      this.#render();
    }
  }

  #handleMemoryCommand(argument: string): void {
    const trimmed = argument.trim();
    if (!trimmed) {
      this.#openMemoryHub();
      return;
    }
    if (trimmed === "remember" || trimmed === "add") {
      this.#openRememberMemoryForm();
      return;
    }
    try {
      const request = parseMemoryCommand(argument);
      switch (request.mode) {
        case "list":
          this.#openMemoryPanel(request.scope);
          return;
        case "remember":
          this.#runMemoryOperation(() =>
            this.#runtime.rememberMemory(request.statement, request.scope, request.activation),
          );
          return;
        case "accept":
          this.#runMemoryOperation(() => this.#runtime.acceptMemory(request.memoryId));
          return;
        case "correct":
          this.#runMemoryOperation(() =>
            this.#runtime.correctMemory(request.memoryId, request.statement),
          );
          return;
        case "forget":
          this.#runMemoryOperation(() =>
            this.#runtime.forgetMemory(request.memoryId, request.reason),
          );
          return;
        case "promote":
          this.#runMemoryOperation(() =>
            this.#runtime.promoteMemory(request.memoryId, request.activation),
          );
          return;
        case "pin":
          this.#runMemoryOperation(() =>
            this.#runtime.setMemoryActivation(request.memoryId, "always"),
          );
          return;
        case "unpin":
          this.#runMemoryOperation(() =>
            this.#runtime.setMemoryActivation(request.memoryId, "relevant"),
          );
          return;
      }
    } catch (error) {
      this.#presenter.setNotice(message(error));
      this.#render();
    }
  }

  #maybeOfferRunQuestion(): void {
    const view = this.#runtime.view();
    const run = view?.currentRunId ? view.runs[view.currentRunId] : undefined;
    const questionSetId = run?.pendingQuestionSetId;
    const questionSet = questionSetId ? run?.questions[questionSetId] : undefined;
    if (!questionSetId || !questionSet || questionSet.status !== "pending") {
      this.#runQuestionKey = undefined;
      return;
    }
    if (this.#runQuestionKey === questionSetId || this.#panels.open) return;
    if (!this.#canAutoOpenGate()) {
      this.#deferGate("Run Question needs your attention");
      return;
    }
    this.#openRunQuestionPanel(questionSetId);
  }

  #openRunQuestionPanel(
    questionSetId: import("@civaapple/qi-protocol").QuestionId,
  ): void {
    const view = this.#runtime.view();
    const run = view?.currentRunId ? view.runs[view.currentRunId] : undefined;
    const questionSet = run?.questions[questionSetId];
    if (!questionSet || questionSet.status !== "pending") return;
    this.#runQuestionKey = questionSetId;
    this.#panels.push(new QuestionPanel({
      questions: questionSet.questions,
      onSubmit: (answers) => {
        this.#panels.closeAll();
        this.#runQuestionKey = undefined;
        try {
          this.#runtime.answerRunQuestion(questionSetId, answers);
          this.#presenter.setNotice("Plan Question answered · resuming this Run");
        } catch (error) {
          this.#presenter.setNotice(message(error));
        }
        this.#render();
      },
    }));
    this.#render();
  }

  async #persistLoginDefaults(
    status: AuthSessionStatus,
    extras?: {
      readonly outputReserveTokens?: number;
      readonly clearReasoningEffort?: boolean;
    },
  ): Promise<string> {
    const configPath = this.#presenter.launch.configPath ?? defaultUserConfigPath();
    return persistLoginProviderDefaults(status, configPath, extras);
  }

  #switchSealedAccount(
    provider: string,
    alias: string,
    routing?: {
      model?: string;
      baseURL?: string;
      reasoningEffort?: string;
      contextWindowTokens?: number;
      imageInput?: boolean;
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

  #configureModel(
    routing: {
      model: string;
      reasoningEffort?: string;
      contextWindowTokens?: number;
      outputReserveTokens?: number;
      imageInput?: boolean;
    },
    persistence: "account" | "session",
  ): void {
    const auth = this.#auth;
    if (!auth) {
      this.#presenter.setNotice("Auth session is unavailable in this TUI mode.");
      this.#render();
      return;
    }
    if (this.#runtime.active) {
      this.#presenter.setNotice("Cannot change model while a Run is active.");
      this.#render();
      return;
    }
    const current = auth.status();
    this.#startManagementTask(async () => {
      const { outputReserveTokens, ...authRouting } = routing;
      const clearReasoningEffort = authRouting.reasoningEffort === "";
      const status = await auth.useAccount(
        current.provider,
        current.accountAlias,
        {
          ...authRouting,
          ...(current.baseURL === undefined ? {} : { baseURL: current.baseURL }),
        },
        persistence,
      );
      this.#syncAuthLaunch(status);
      const output = outputReserveTokens === undefined
        ? {
          contextWindowTokens: this.#presenter.launch.contextWindowTokens,
          contextBudgetTokens: this.#presenter.launch.contextBudgetTokens,
          outputReserveTokens: this.#runtime.outputReserveTokens(),
        }
        : this.#runtime.configureOutputReserve(outputReserveTokens);
      this.#presenter.launch = {
        ...this.#presenter.launch,
        contextWindowTokens: output.contextWindowTokens,
        contextBudgetTokens: output.contextBudgetTokens,
        outputReserveTokens: output.outputReserveTokens,
      };
      this.#runtime.recordModelConfiguration({
        provider: status.provider,
        accountAlias: status.accountAlias,
        model: status.model,
        ...(status.reasoningEffort === undefined ? {} : { reasoningEffort: status.reasoningEffort }),
        contextWindowTokens: status.contextWindowTokens,
        imageInput: status.imageInput,
      }, persistence);
      if (persistence === "account") {
        await this.#persistLoginDefaults(status, {
          outputReserveTokens: output.outputReserveTokens,
          ...(clearReasoningEffort ? { clearReasoningEffort: true } : {}),
        });
      }
      this.#presenter.setNotice(
        `Model → ${status.model}` +
        (status.reasoningEffort
          ? ` · effort ${status.reasoningEffort}`
          : clearReasoningEffort
            ? " · effort unset (API default)"
            : "") +
        ` · output ${output.outputReserveTokens}` +
        ` · ${persistence === "account" ? "saved as user default" : "current Session only"}`,
      );
    }, "model");
  }

  #handleCommand(name: string, argument: string): void {
    if (this.#panels.open && name !== "quit" && name !== "exit" && name !== "cancel") {
      this.#panels.closeAll();
    }
    if (name === "settings") {
      openSettingsPanel(this.#panelFlow());
      return;
    }
    if (name.startsWith("skill:")) {
      const skillName = name.slice("skill:".length);
      if (!skillName || !argument.trim()) {
        this.#presenter.setNotice(`/${name} requires a task, for example /${name} review this page`);
        this.#render();
        return;
      }
      this.#startTurn(() => this.#runtime.runWithSkill(skillName, argument));
      return;
    }
    if (name.startsWith("plugin:")) {
      const pluginId = name.slice("plugin:".length);
      if (!pluginId || !argument.trim()) {
        this.#presenter.setNotice(`/${name} requires a task, for example /${name} review this PR`);
        this.#render();
        return;
      }
      this.#startTurn(() => this.#runtime.runWithPlugin(pluginId, argument));
      return;
    }
    if (name.startsWith("agent:")) {
      const agentId = name.slice("agent:".length);
      if (!agentId || !argument.trim()) {
        this.#presenter.setNotice(`/${name} requires a task, for example /${name} review auth changes`);
        this.#render();
        return;
      }
      this.#startTurn(() => this.#runtime.runWithAgent(agentId, argument));
      return;
    }
    if (name === "memory") {
      this.#handleMemoryCommand(argument);
      return;
    }
    if (name === "goal") {
      this.#handleGoalCommand(argument);
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
      this.#openSkillsHubPanel();
      return;
    }
    if (name === "plugins") {
      this.#openPluginsBrowser(argument.trim());
      return;
    }
    if (name === "agents") {
      this.#startManagementTask(async () => {
        const query = argument.trim();
        const catalog = this.#runtime.plugins();
        const [installed, enabledKeys, agents] = await Promise.all([
          catalog.listInstalled(query),
          catalog.listEnabled(),
          catalog.listAgents(query),
        ]);
        this.#syncAutocomplete();
        if (installed.length === 0 && agents.length === 0) {
          this.#presenter.setNotice(
            query
              ? `No installed plugins or enabled agents match "${query}".`
              : "No installed plugins. Install/enable a plugin that ships agents/, then /agent:<id> <task>.",
          );
          return;
        }
        const enabled = new Set(enabledKeys);
        const lines = [
          "Plugins — ● enabled · ○ installed · name@marketplace",
          ...installed.map((entry) =>
            `  ${enabled.has(entry.key) ? "● enabled" : "○ installed"}  ${entry.key}${entry.version === undefined ? "" : ` · v${entry.version}`}`),
        ];
        if (agents.length > 0) {
          lines.push("", "Enabled /agent definitions — invoke with /agent:<id> <task>");
          lines.push(...agents.map((entry) =>
            `  /agent:${entry.id}  [${entry.marketplace}] ${entry.description.replace(/\s+/g, " ").trim()}`));
        }
        lines.push("", "Manage: qi plugin list|install|enable|disable · qi agent list");
        this.#openScrollPanel(
         "/agents",
          lines,
       );
      }, "agents");
      return;
    }
    if (name === "mcp") {
      if (argument.trim()) {
        this.#presenter.setNotice("请使用 /mcp 打开 MCP 管理面板；/mcp 不接受参数。");
        this.#render();
        return;
      }
      openMcpPanel(this.#panelFlow());
      return;
    }
    if (name === "skill") {
      const request = argument.trim();
      if (!request) {
        openSkillsHubPanel(this.#panelFlow());
        return;
      }
      if (/^enable\b/i.test(request)) {
        this.#activateAgentSkill(request.replace(/^enable\s+/i, ""));
        return;
      }
      if (/^disable\b/i.test(request)) {
        this.#deactivateAgentSkill(request.replace(/^disable\s+/i, ""));
        return;
      }
      if (/^install\b/i.test(request)) {
        this.#installSkillFromArgument(request);
        return;
      }
      if (/^(remove|uninstall)\b/i.test(request)) {
        try {
          const match = /^(?:remove|uninstall)(?:\s+(--workspace))?\s+([a-z0-9]+(?:-[a-z0-9]+)*)$/i.exec(request);
          if (!match?.[2]) throw new TypeError("Usage: /skill remove [--workspace] <name>");
          this.#removeSkill(match[2], match[1] ? "workspace" : "user");
        } catch (error) {
          this.#presenter.setNotice(message(error));
          this.#render();
        }
        return;
      }
      this.#presenter.setNotice(
        "Usage: /skill enable|disable <name>, /skill install <source>, /skill remove [--workspace] <name>, or /skill:<name> <task>",
      );
      this.#render();
      return;
    }
    if (name === "tasks") {
      if (/^stop\b/i.test(argument.trim())) {
        this.#presenter.setNotice(t(this.#presenter.locale(), "tasks.moved_to_jobs"));
        this.#render();
        return;
      }
      // Refresh from durable store so mid-flight delegation.created is visible even if a paint was missed.
      this.#presenter.update(this.#runtime.events(), this.#runtime.view());
      openSubagentTasksHubPanel(this.#panelFlow());
      return;
    }
    if (name === "jobs") {
      if (/^stop\b/i.test(argument.trim())) {
        this.#stopJobFromArgument(argument);
        return;
      }
      if (!argument.trim()) {
        openJobsHubPanel(this.#panelFlow());
        return;
      }
      this.#presenter.setNotice(t(this.#presenter.locale(), "jobs.stop.usage"));
      this.#render();
      return;
    }
    if (name === "job") {
      this.#stopJobFromArgument(argument.startsWith("stop") ? argument : `stop ${argument}`);
      return;
    }
    if (name === "task") {
      this.#presenter.setNotice(t(this.#presenter.locale(), "tasks.moved_to_jobs"));
      this.#render();
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
    if (name === "model") {
      if (argument.trim()) {
        this.#presenter.setNotice(t(this.#presenter.locale(), "model.use_panel"));
        this.#render();
        return;
      }
      void openModelConfigurationPanel(this.#panelFlow());
      return;
    }
    if (name === "max-steps") {
      if (argument.trim()) {
        this.#presenter.setNotice(t(this.#presenter.locale(), "max_steps.use_panel"));
        this.#render();
        return;
      }
      openMaxStepsPanel(this.#panelFlow());
      return;
    }
    if (name === "max-actions-per-step") {
      if (argument.trim()) {
        this.#presenter.setNotice(t(this.#presenter.locale(), "max_actions_per_step.use_panel"));
        this.#render();
        return;
      }
      openMaxActionsPerStepPanel(this.#panelFlow());
      return;
    }
    if (name === "subagent" || name === "delegate") {
      if (argument.trim()) {
        this.#presenter.setNotice(t(this.#presenter.locale(), "subagent.use_panel"));
        this.#render();
        return;
      }
      openSubagentSettingsPanel(this.#panelFlow());
      return;
    }
    if (name === "reset-workspace") {
      if (this.#runtime.active) {
        this.#presenter.setNotice("Cannot reset the Workspace while a Run is active.");
        this.#render();
        return;
      }
      const blockers = this.#runtime.workspaceResetBlockers();
      if (blockers.length > 0) {
        this.#presenter.setNotice(`Workspace reset blocked · ${blockers.join(" · ")}`);
        this.#render();
        return;
      }
      this.#panels.push(new ListPanel({
        title: "Reset Workspace",
        hints: "↑↓ select · Enter confirm · Esc cancel",
        items: [
          {
            id: "confirm",
            label: "Archive all active Sessions",
            description: `${this.#runtime.listSessions().length} active Session(s) → archives/; configuration is preserved`,
          },
          { id: "cancel", label: "Cancel", description: "Keep every Session active" },
        ],
        onClose: this.#panels.dismiss,
        onSelect: (item) => {
          if (item.id === "confirm") {
            this.#panels.closeAll();
            void this.close({ kind: "reset-workspace" });
          } else {
            this.#panels.dismiss();
            this.#render();
          }
        },
      }));
      this.#render();
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
              return entry
                ? {
                    model: entry.model,
                    baseURL: entry.baseURL,
                    ...(entry.imageInput === undefined ? {} : { imageInput: entry.imageInput }),
                  }
                : undefined;
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
                ...(loaded.config.imageInput === undefined
                  ? {}
                  : { imageInput: loaded.config.imageInput }),
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
      this.#presenter.setNotice(t(this.#presenter.locale(), "runs.use_hub"));
      openRunsHubPanel(this.#panelFlow());
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
      case "shell": {
        openShellPanel(this.#panelFlow());
        return;
      }
      case "verify": {
        this.#openVerifySetupPanel();
        return;
      }
      case "quit":
      case "exit":
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
    const sourceLines = this.#presenter.render(usable);
    const rendered: string[] = [];
    for (let index = 0; index < sourceLines.length;) {
      const line = sourceLines[index]!;
      if (line.startsWith("notice  ")) {
        index += 1;
        continue;
      }
      if (line.startsWith(USER_MESSAGE_PREFIX)) {
        const paint = (content: string) =>
          theme.bg("userMessageBg", theme.fg("roleUser", padToDisplayWidth(content, usable)));
        const body: string[] = [];
        while (
          index < sourceLines.length &&
          sourceLines[index]!.startsWith(USER_MESSAGE_PREFIX)
        ) {
          const text = sourceLines[index]!.slice(USER_MESSAGE_PREFIX.length);
          body.push(...wrapTextWithAnsi(` ${text} `, usable).map((wrapped) => paint(wrapped)));
          index += 1;
        }
        // Pad the whole message block once; logical lines should not each look like a separate turn.
        const pad = paint("");
        rendered.push(pad, ...body, pad);
        continue;
      }
      rendered.push(...wrapTextWithAnsi(styleLine(line), usable));
      index += 1;
    }
    this.#cachedLines = rendered;
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
  if (/^(Effective configuration|Context|Runs |Steps |Actions |Subagents |Tasks |Jobs |Skills |ProcessTasks |Diff |Plan |Todo |Status|Keyboard shortcuts|Slash commands|常用 Slash 命令|键盘快捷键|高级 \/ 别名命令|── Handoff|Run  |Action  |Plan Review|Next Run)/.test(line)) {
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

function normalizeSensitiveGrantPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
}

function parseFailurePayload(modelOutput: unknown): {
  details?: { path?: unknown; kind?: unknown };
  message?: unknown;
} | undefined {
  if (!Array.isArray(modelOutput)) return undefined;
  for (const part of modelOutput) {
    if (!part || typeof part !== "object") continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    try {
      return JSON.parse(text) as { details?: { path?: unknown; kind?: unknown }; message?: unknown };
    } catch {
      // Ignore non-JSON tool failure payloads.
    }
  }
  return undefined;
}

function isSensitiveGrantFailure(modelOutput: unknown): boolean {
  return parseFailurePayload(modelOutput)?.details?.kind === "sensitive";
}

function extractSensitiveGrantPath(modelOutput: unknown): string | undefined {
  const parsed = parseFailurePayload(modelOutput);
  if (typeof parsed?.details?.path !== "string" || !parsed.details.path.trim()) return undefined;
  if (parsed.details.kind !== undefined && parsed.details.kind !== "sensitive") return undefined;
  return normalizeSensitiveGrantPath(parsed.details.path.trim());
}

function extractGrantPath(modelOutput: unknown): string | undefined {
  const parsed = parseFailurePayload(modelOutput);
  if (parsed) {
    if (typeof parsed.details?.path === "string" && parsed.details.path.trim()) {
      return parsed.details.path.trim();
    }
    const match = typeof parsed.message === "string"
      ? parsed.message.match(/(?:grant panel|readable):\s*(.+)$/i)
      : undefined;
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function oneLineHint(value: string, maximum = 48): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

function marketplaceSourceSummary(marketplace: {
  readonly enabled: boolean;
  readonly source: { readonly kind: string; readonly repo?: string; readonly ref?: string; readonly path?: string };
  readonly resolvedRevision?: string;
  readonly lastUpdated?: string;
}): string {
  const state = marketplace.enabled ? "Enabled" : "Disabled";
  const source = marketplace.source.kind === "github"
    ? `github:${marketplace.source.repo ?? "?"}${marketplace.source.ref ? `@${marketplace.source.ref}` : ""}`
    : `local`;
  const revision = marketplace.resolvedRevision ? ` · ${marketplace.resolvedRevision.slice(0, 7)}` : "";
  return `${state} · ${source}${revision}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
