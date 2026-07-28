import assert from "node:assert/strict";
import test from "node:test";

const expectedRuntimeExports = {
  "@civaapple/qi-agent": ["QiAgent", "InMemoryArtifactStore"],
  "@civaapple/qi-agent/capability": [
    "ASK_MODE_TOOLS", "InMemoryCapabilityBroker",
    "InMemoryCredentialBroker", "PLAN_MODE_EXTRA_TOOLS", "SESSION_MODES",
    "formatModeLabel", "isToolAllowedInMode", "mergeRedactionSummaries", "modeAllowsIntent",
    "nextSessionMode", "redactSensitiveText", "redactSensitiveValue", "toolsForMode",
  ],
  "@civaapple/qi-node/codeact": [
    "CodeActRunner", "ContainerProgramSandbox", "ControlledToolClient",
    "FixtureProgramSandbox", "buildContainerInvocation", "probeContainerRuntime",
  ],
  "@civaapple/qi-ai/context": ["ContextBudgetError", "approximateTokenEstimator", "compileContext"],
  "@civaapple/qi-agent/extensions": [
    "Coordinator", "DECLARATIVE_RESOURCE_KINDS", "GraphGovernor", "MultiAgentBaselineGate",
    "PublicPackageMaturitySchema", "QI_SELF_SECTIONS", "QiSelfDecisionSchema", "QiSelfGapSchema",
    "QiSelfInvariantSchema", "QiSelfModelSchema", "QiSelfPackageSchema",
    "QiSessionInspectionError", "RuntimeMaturitySchema", "SelfModelPackageKindSchema",
    "contextBlocksFromRefs", "createQiIntrospectionTool", "createQiSelfContext",
    "createQiSessionInspectionTool", "inspectQiSession", "parseQiPluginManifest",
    "parseQiSelfModel", "qiSelfModel", "queryQiSelfModel", "runDelegatedTurn", "validateGraph",
  ],
  "@civaapple/qi-agent/eval": [
    "DeterministicEvaluator", "EvaluatorCalibrationRegistry", "GoalEngine", "SemanticEvaluator",
    "evaluatorIdentity", "failureFingerprint",
  ],
  "@civaapple/qi-agent/kernel": [
    "ConcurrencyError", "InMemoryEventStore", "KERNEL_ASK_MODE_TOOLS",
    "KERNEL_PLAN_MODE_EXTRA_TOOLS", "StateTransitionError", "applySessionEvent",
    "replaySession",
  ],
  "@civaapple/qi-ai": [
    "BUILTIN_PROVIDER_PROFILES", "ModelContentPartSchema", "ModelEventSchema",
    "ModelMessageSchema", "ModelRefSchema", "ModelRequestSchema",
    "OpenAIChatCompletionsModelPort", "OpenAIResponsesModelPort", "PortableToolSchema",
    "ScriptedModelPort", "assertProfileSupportsRequest", "classifyProfileEndpoint",
    "createModelPortForProfile", "getProviderProfile", "listProviderProfiles",
    "modelCapabilitiesFromProfile", "normalizeFunctionParameters", "parseModelEvent",
    "parseModelRequest", "requireProviderProfile",
  ],
  "@civaapple/qi-agent/loop": [
    "ASK_MODE_TOOLS", "EventWriter", "HumanControlService", "PLAN_MODE_EXTRA_TOOLS",
    "SESSION_MODES", "SessionSupervisor", "SteeringMailbox", "TurnLoop",
    "firstIncompleteItem", "formatModeLabel", "formatPlanItemInput", "isToolAllowedInMode",
    "latestTerminalPlanBoundRun", "nextSessionMode", "toolsForMode",
  ],
  "@civaapple/qi-agent/tools": [
    "AuthorityDeniedError", "EffectReplayBlockedError", "StaleToolError", "ToolFailure",
    "ToolInputError", "ToolOutputError", "ToolRegistry", "defineTool",
  ],
  "@civaapple/qi-agent/effects": ["effectIdempotencyKey", "effectIntentHash"],
  "@civaapple/qi-node/mcp": ["McpBridge"],
  "@civaapple/qi-agent/memory": ["ContinuityController", "MemoryController"],
  "@civaapple/qi-protocol": [
    "ActionIdSchema", "EvaluationIdSchema", "EventIdSchema", "EvidenceIdSchema",
    "GoalIdSchema", "LeaseIdSchema", "MemoryIdSchema", "PlanIdSchema",
    "PlanItemIdSchema", "QuestionIdSchema", "ReceiptIdSchema", "RunIdSchema",
    "SessionEventSchema", "SessionIdSchema", "SessionModeSchema", "StepIdSchema",
    "TaskIdSchema", "assertSchema", "createId", "parseSessionEvent",
  ],
  "@civaapple/qi-node/scheduler": ["SessionEventTriggerSink", "SqliteWatcherScheduler"],
  "@civaapple/qi-node/storage": [
    "EncryptedFileCredentialStore", "SqliteEventStore", "SqliteMemoryIndex",
  ],
  "@civaapple/qi-node": [
    "QI_LAYOUT_GENERATION", "QI_LAYOUT_VERSION", "assertSafePrivateRoot",
    "canonicalWorkspacePath", "defaultProjectConfigPath", "defaultProjectsRoot",
    "defaultQiHome", "defaultSessionDataRoot", "discoverProjects", "ensureProjectLayout",
    "ensureQiLayout", "projectPaths", "workspaceProjectId",
  ],
  "@civaapple/qi-node/extensions": [
    "DeclarativePackageStore", "WORKSPACE_QI_DIRECTORIES", "WORKSPACE_QI_FILES",
    "assertPinnedPackageSource", "resolveLayeredResources", "validateDeclarativeTree",
    "validateWorkspaceQiDirectory",
  ],
  "@civaapple/qi-node/skills": [
    "SkillCatalog", "SkillLoader", "SkillStaleError", "SkillUpdateIndeterminateError",
    "loadAgentDefinition", "parseFrontmatter", "requireString",
  ],
  "@civaapple/qi-node/stream": ["EventStreamService", "SessionEventHub", "encodeSseEvent", "sseStream"],
  "@civaapple/qi-node/tools": [
    "AuthorityDeniedError", "EffectReplayBlockedError", "FileArtifactStore",
    "SHELL_PROFILE_IDS", "StaleToolError", "ToolFailure", "ToolInputError",
    "ToolOutputError", "ToolRegistry", "artifactTool", "builtinTools", "createFetchTool",
    "createScriptTool", "createVerifyTool", "defaultVerificationManifestPath", "defineTool",
    "editTool", "fetchTool", "findTool", "findTrustedExecutable", "formatAccessiblePath",
    "gitTool", "isRegularFile", "listTool", "loadVerificationProfiles", "mountsFromContext",
    "moveTool", "networkResource", "prepareVerificationProfiles", "prewarmTrustedExecutables", "probeShellProfiles",
    "readTool", "removeTool", "resolveAccessiblePath", "resolveShellConfig",
    "resolveShellExecutable", "resolveWorkspaceEntry", "resolveWorkspacePath", "scanVerificationCandidates",
    "searchTool", "shellProfileResource", "shellTool", "treeTool", "verificationResource",
    "windowsCommandInvocation", "writeTool", "writeVerificationManifest",
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
  "@civaapple/qi-node/workspace": [
    "ContainerWorkspaceAdapter", "GitWorktreeAdapter", "LocalWorkspace",
    "SqliteEffectJournal", "effectIdempotencyKey", "effectIntentHash", "hostProcessRunner",
    "minimalHostEnvironment", "runHostProcess", "scrubCredentialEnvironment",
    "terminateProcessTree",
  ],
};

test("all controlled six-package runtime entrypoints are explicitly reviewed", async () => {
  for (const [packageName, expected] of Object.entries(expectedRuntimeExports)) {
    const packageModule = await import(packageName);
    assert.deepEqual(
      Object.keys(packageModule).sort(),
      [...expected].sort(),
      `${packageName} runtime exports changed; review and update its public API snapshot intentionally`,
    );
  }
});
