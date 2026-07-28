import assert from "node:assert/strict";
import test from "node:test";
import * as tui from "@civaapple/qi-tui";

test("@civaapple/qi-tui exposes reusable projections and excludes CLI/runtime ownership", () => {
  assert.equal(typeof tui.TuiPresenter, "function");
  assert.equal(typeof tui.ListPanel, "function");
  assert.equal(typeof tui.ComposerComponent, "function");
  assert.equal(typeof tui.renderMarkdown, "function");
  assert.equal(typeof tui.LineInputBatcher, "function");

  assert.equal("TuiRuntime" in tui, false);
  assert.equal("InteractiveTui" in tui, false);
  assert.equal("resolveProviderConfig" in tui, false);
  assert.equal("loadUserConfig" in tui, false);
});

test("@civaapple/qi-tui public runtime exports are reviewed explicitly", () => {
  assert.deepEqual(Object.keys(tui).sort(), [
    "ComposerComponent",
    "FollowUpQueue",
    "FollowUpsComponent",
    "FormPanel",
    "LineInputBatcher",
    "ListPanel",
    "MultiSelectPanel",
    "NEW_SESSION_ID",
    "PanelHost",
    "SESSION_PREVIEW_MAX_CHARS",
    "ScrollPanel",
    "SessionsPanel",
    "Theme",
    "TuiPresenter",
    "USER_MESSAGE_PREFIX",
    "applyTheme",
    "autocompleteSlashCommands",
    "buildSessionEntries",
    "collapsePreviewText",
    "commandHelp",
    "currentMark",
    "darkColors",
    "defaultLocale",
    "eventAffectsTranscript",
    "formatProviderLabel",
    "formatRelativeTime",
    "lightColors",
    "normalizeLocale",
    "padToDisplayWidth",
    "paintPromptWithCaret",
    "paletteFor",
    "panelFooter",
    "panelHeader",
    "panelRule",
    "parseMountsCommand",
    "parseSkillInstallCommand",
    "parseTaskStopCommand",
    "parseTuiCommand",
    "pointer",
    "primarySlashCommands",
    "renderComposerPlaceholder",
    "renderEvent",
    "renderMarkdown",
    "renderQiMark",
    "renderStatus",
    "renderToolCard",
    "resolveThemeName",
    "sessionEntriesToPanelItems",
    "sessionPreviewText",
    "shortSessionId",
    "shortenPath",
    "shouldExpandByDefault",
    "splitKeepRight",
    "statusGlyph",
    "t",
    "theme",
    "toSlashCommand",
    "truncateToWidth",
    "tuiCommands",
    "visibleWidth",
  ]);
});

test("@civaapple/qi-tui presenter renders without constructing an application runtime", () => {
  const presenter = new tui.TuiPresenter({
    workspaceRoot: process.cwd(),
    dataRoot: ".qi",
    provider: "compatible",
    accountAlias: "example-gateway",
    model: "scripted",
    capabilities: [],
    contextWindowTokens: 128_000,
    contextBudgetTokens: 112_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });

  assert.match(presenter.render(80).join("\n"), /QI/u);
  assert.equal(tui.formatProviderLabel("compatible", "example-gateway"), "example-gateway");
  assert.equal(tui.statusGlyph("denied"), "⊘");
  assert.match(tui.renderMarkdown("## Reusable", 80).join("\n"), /Reusable/u);

  presenter.patchAuthLaunch({
    provider: "kimi",
    model: "k3-256k",
    wireApi: "chat.completions",
    authStatus: "ready",
    contextWindowTokens: 262_144,
    contextBudgetTokens: 246_144,
    outputReserveTokens: 16_000,
  });
  assert.equal(presenter.launch.model, "k3-256k");
  assert.equal(presenter.launch.contextWindowTokens, 262_144);
  assert.equal(presenter.launch.contextBudgetTokens, 246_144);
});
