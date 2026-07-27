import assert from "node:assert/strict";
import test from "node:test";

const expectedRuntimeExports = {
  "@civaapple/qi-agent": ["QiAgent", "InMemoryArtifactStore"],
  "@civaapple/qi-capability": [
    "ASK_MODE_TOOLS", "EncryptedFileCredentialStore", "InMemoryCapabilityBroker",
    "InMemoryCredentialBroker", "PLAN_MODE_EXTRA_TOOLS", "SESSION_MODES",
    "formatModeLabel", "isToolAllowedInMode", "mergeRedactionSummaries", "modeAllowsIntent",
    "nextSessionMode", "redactSensitiveText", "redactSensitiveValue", "toolsForMode",
  ],
  "@civaapple/qi-codeact": [
    "CodeActRunner", "ContainerProgramSandbox", "ControlledToolClient",
    "FixtureProgramSandbox", "buildContainerInvocation",
  ],
  "@civaapple/qi-context": ["ContextBudgetError", "approximateTokenEstimator", "compileContext"],
  "@civaapple/qi-coordinator": [
    "Coordinator", "MultiAgentBaselineGate", "contextBlocksFromRefs", "runDelegatedTurn",
  ],
  "@civaapple/qi-eval": [
    "DeterministicEvaluator", "EvaluatorCalibrationRegistry", "GoalEngine", "SemanticEvaluator",
    "evaluatorIdentity", "failureFingerprint",
  ],
  "@civaapple/qi-graph": ["GraphGovernor", "validateGraph"],
  "@civaapple/qi-introspection": [
    "QI_SELF_SECTIONS", "QiSelfDecisionSchema", "QiSelfGapSchema",
    "QiSelfInvariantSchema", "QiSelfModelSchema", "QiSelfPackageSchema",
    "QiSessionInspectionError",
    "PublicPackageMaturitySchema", "RuntimeMaturitySchema", "SelfModelPackageKindSchema",
    "createQiIntrospectionTool", "createQiSelfContext", "createQiSessionInspectionTool",
    "inspectQiSession", "qiSelfModel", "parseQiSelfModel", "queryQiSelfModel",
  ],
  "@civaapple/qi-kernel": [
    "ConcurrencyError", "InMemoryEventStore", "KERNEL_ASK_MODE_TOOLS",
    "KERNEL_PLAN_MODE_EXTRA_TOOLS", "StateTransitionError", "applySessionEvent",
    "replaySession",
  ],
  "@civaapple/qi-llm": [
    "BUILTIN_PROVIDER_PROFILES", "ModelContentPartSchema", "ModelEventSchema",
    "ModelMessageSchema", "ModelRefSchema", "ModelRequestSchema",
    "OpenAIChatCompletionsModelPort", "OpenAIResponsesModelPort", "PortableToolSchema",
    "ScriptedModelPort", "assertProfileSupportsRequest", "classifyProfileEndpoint",
    "createModelPortForProfile", "getProviderProfile", "listProviderProfiles",
    "modelCapabilitiesFromProfile", "normalizeFunctionParameters", "parseModelEvent",
    "parseModelRequest", "requireProviderProfile",
  ],
  "@civaapple/qi-loop": [
    "ASK_MODE_TOOLS", "EventWriter", "HumanControlService", "PLAN_MODE_EXTRA_TOOLS",
    "SESSION_MODES", "SessionSupervisor", "SteeringMailbox", "TurnLoop",
    "firstIncompleteItem", "formatModeLabel", "formatPlanItemInput", "isToolAllowedInMode",
    "latestTerminalPlanBoundRun", "nextSessionMode", "toolsForMode",
  ],
  "@civaapple/qi-mcp": ["McpBridge"],
  "@civaapple/qi-memory": ["ContinuityController", "MemoryController", "SqliteMemoryIndex"],
  "@civaapple/qi-protocol": [
    "ActionIdSchema", "EvaluationIdSchema", "EventIdSchema", "EvidenceIdSchema",
    "GoalIdSchema", "LeaseIdSchema", "MemoryIdSchema", "PlanIdSchema",
    "PlanItemIdSchema", "QuestionIdSchema", "ReceiptIdSchema", "RunIdSchema",
    "SessionEventSchema", "SessionIdSchema", "SessionModeSchema", "StepIdSchema",
    "TaskIdSchema", "assertSchema", "createId", "parseSessionEvent",
  ],
  "@civaapple/qi-scheduler": ["SessionEventTriggerSink", "SqliteWatcherScheduler"],
  "@civaapple/qi-session-store": ["SqliteEventStore"],
  "@civaapple/qi-skills": [
    "SkillCatalog", "SkillLoader", "SkillStaleError", "SkillUpdateIndeterminateError",
    "loadAgentDefinition", "parseFrontmatter", "requireString",
  ],
  "@civaapple/qi-stream": ["EventStreamService", "SessionEventHub", "encodeSseEvent", "sseStream"],
  "@civaapple/qi-tools": [
    "AuthorityDeniedError", "EffectReplayBlockedError", "FileArtifactStore",
    "SHELL_PROFILE_IDS", "StaleToolError", "ToolFailure", "ToolInputError",
    "ToolOutputError", "ToolRegistry", "artifactTool", "builtinTools", "createFetchTool",
    "createScriptTool", "createVerifyTool", "defaultVerificationManifestPath", "defineTool",
    "editTool", "fetchTool", "findTool", "findTrustedExecutable", "formatAccessiblePath",
    "gitTool", "isRegularFile", "listTool", "loadVerificationProfiles", "mountsFromContext",
    "moveTool", "networkResource", "prepareVerificationProfiles", "probeShellProfiles",
    "readTool", "removeTool", "resolveAccessiblePath", "resolveShellConfig",
    "resolveShellExecutable", "resolveWorkspaceEntry", "resolveWorkspacePath", "searchTool",
    "shellProfileResource", "shellTool", "treeTool", "verificationResource",
    "windowsCommandInvocation", "writeTool",
  ],
  "@civaapple/qi-tui": [
    "ComposerComponent", "FollowUpQueue", "FollowUpsComponent", "FormPanel",
    "LineInputBatcher", "ListPanel", "MultiSelectPanel", "NEW_SESSION_ID", "PanelHost",
    "SESSION_PREVIEW_MAX_CHARS", "ScrollPanel", "SessionsPanel", "Theme", "TuiPresenter",
    "USER_MESSAGE_PREFIX", "applyTheme", "autocompleteSlashCommands", "buildSessionEntries",
    "collapsePreviewText", "commandHelp", "currentMark", "darkColors", "defaultLocale",
    "eventAffectsTranscript", "formatProviderLabel", "formatRelativeTime", "lightColors",
    "normalizeLocale", "padToDisplayWidth", "paintPromptWithCaret", "paletteFor", "panelFooter",
    "panelHeader", "panelRule", "parseMountsCommand", "parseSkillInstallCommand",
    "parseTaskStopCommand", "parseTuiCommand", "pointer", "primarySlashCommands",
    "renderComposerPlaceholder", "renderEvent", "renderQiMark", "renderMarkdown",
    "renderStatus", "renderToolCard", "resolveThemeName", "sessionEntriesToPanelItems",
    "sessionPreviewText", "shortSessionId", "shortenPath", "shouldExpandByDefault",
    "splitKeepRight", "statusGlyph", "t", "theme", "toSlashCommand", "truncateToWidth",
    "tuiCommands", "visibleWidth",
  ],
  "@civaapple/qi-workspace": [
    "ContainerWorkspaceAdapter", "GitWorktreeAdapter", "LocalWorkspace",
    "SqliteEffectJournal", "effectIdempotencyKey", "effectIntentHash", "hostProcessRunner",
    "minimalHostEnvironment", "runHostProcess", "scrubCredentialEnvironment",
    "terminateProcessTree",
  ],
};

test("all 21 package runtime export surfaces are explicitly reviewed", async () => {
  for (const [packageName, expected] of Object.entries(expectedRuntimeExports)) {
    const packageModule = await import(packageName);
    assert.deepEqual(
      Object.keys(packageModule).sort(),
      [...expected].sort(),
      `${packageName} runtime exports changed; review and update its public API snapshot intentionally`,
    );
  }
});
