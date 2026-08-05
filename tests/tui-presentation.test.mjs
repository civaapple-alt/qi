import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { projectPaths, projectSessionPaths } from "@civaapple/qi-node/paths";
import {
  commandHelp,
  canAutoOpenAttention,
  FollowUpQueue,
  FollowUpsComponent,
  FormPanel,
  highestPriorityAttention,
  InteractiveTui,
  ListPanel,
  MultiSelectPanel,
  QuestionPanel,
  loadProjectConfig,
  openJobsHubPanel,
  openSkillsHubPanel,
  parseMountsCommand,
  parseSkillInstallCommand,
  parseJobStopCommand,
  parseTuiCommand,
  primarySlashCommands,
  autocompleteSlashCommands,
  discoveryAcceleratorTip,
  eventAffectsTranscript,
  renderMarkdown,
  renderComposerPlaceholder,
  renderToolCard,
  statusGlyph,
  Theme,
  TuiPresenter,
  TuiRuntime,
} from "../apps/cli/dist/index.js";
import { createAskQuestionTool } from "../apps/cli/dist/ask-question-tool.js";
import { createPlanDocumentTool, validateFormalPlan } from "../apps/cli/dist/plan-tool.js";
import { McpBindingPanel } from "../apps/cli/dist/panels/mcp-binding-panel.js";
import { mcpServerMaxVisible } from "../apps/cli/dist/panels/flows.js";
import { visibleWidth } from "@civaapple/qi-tui";

test("TUI command catalog separates inspection, navigation, and control", () => {
  assert.deepEqual(parseTuiCommand("/actions"), { name: "actions", argument: "" });
  assert.deepEqual(
    parseTuiCommand("/model\nkeep this draft"),
    { name: "model", argument: "", draft: "keep this draft" },
  );
  assert.deepEqual(
    parseTuiCommand("/effort high --session\r\nstill drafting"),
    { name: "effort", argument: "high --session", draft: "still drafting" },
  );
  assert.equal(parseTuiCommand("fix the bug"), undefined);
  const helpZh = commandHelp(undefined, "zh");
  assert.ok(helpZh.some((line) => line.includes("键盘快捷键")));
  assert.ok(helpZh.some((line) => line.includes("/settings")));
  assert.ok(helpZh.some((line) => line.includes("/status")));
  assert.ok(helpZh.some((line) => line.includes("/mounts")));
  assert.ok(helpZh.some((line) => line.includes("/skills")));
  assert.ok(helpZh.some((line) => line.includes("/steer")));
  assert.ok(helpZh.some((line) => line.includes("/help advanced")));
  assert.ok(!helpZh.some((line) => line.includes("/context —") || line.includes("/context —")));
  assert.ok(!helpZh.some((line) => /\/context /.test(line)));
  const helpEn = commandHelp(undefined, "en");
  assert.ok(helpEn.some((line) => line.includes("Keyboard shortcuts")));
  assert.ok(helpEn.some((line) => line.includes("Ctrl+O")));
  assert.ok(helpEn.some((line) => line.includes("/status")));
  const advanced = commandHelp("advanced", "en");
  assert.ok(advanced.some((line) => line.includes("/max-steps")));
  assert.ok(advanced.some((line) => line.includes("/context")));
  assert.ok(!advanced.some((line) => /^\s+\/status\b/.test(line)));
  assert.ok(advanced.some((line) => line.includes("/task stop")));
  assert.ok(!advanced.some((line) => line.includes("/steps")));
  assert.ok(!advanced.some((line) => line.includes("/actions")));
  assert.ok(advanced.some((line) => line.includes("/coord")));
  const primary = primarySlashCommands("en");
  assert.ok(primary.some((command) => command.name === "help"));
  assert.ok(primary.some((command) => command.name === "runs"));
  assert.ok(primary.some((command) => command.name === "sessions"));
  assert.ok(primary.some((command) => command.name === "shell"));
  assert.ok(primary.some((command) => command.name === "permissions"));
  assert.ok(primary.some((command) => command.name === "status"));
  assert.ok(primary.some((command) => command.name === "plugins"));
  assert.ok(primary.some((command) => command.name === "agents"));
  assert.ok(!primary.some((command) => command.name === "config"));
  assert.ok(!primary.some((command) => command.name === "max-steps"));
  assert.ok(!primary.some((command) => command.name === "run"));
  assert.ok(!primary.some((command) => command.name === "effort"));
  const mcp = primary.find((command) => command.name === "mcp");
  assert.ok(mcp);
  assert.equal(mcp.argumentHint, undefined);
  const autocomplete = autocompleteSlashCommands("en");
  assert.ok(autocomplete.some((command) => command.name === "runs"));
  assert.ok(!autocomplete.some((command) => command.name === "run"));
  assert.ok(!autocomplete.some((command) => command.name === "step"));
  assert.ok(!autocomplete.some((command) => command.name === "action"));
  assert.ok(!autocomplete.some((command) => command.name === "agent"));
  assert.ok(!autocomplete.some((command) => command.name === "steps"));
  assert.ok(!autocomplete.some((command) => command.name === "actions"));
  assert.ok(autocomplete.some((command) => command.name === "agents"));
  assert.ok(autocomplete.some((command) => command.name === "plugins"));
  assert.ok(autocomplete.some((command) => command.name === "config"));
  assert.ok(autocomplete.some((command) => command.name === "status"));
  assert.ok(autocomplete.some((command) => command.name === "max-steps"));
  assert.ok(autocomplete.some((command) => command.name === "exit"));
  assert.ok(!autocomplete.some((command) => command.name === "coord"));
  assert.deepEqual(parseTuiCommand("/exit"), { name: "exit", argument: "" });
  assert.deepEqual(parseTuiCommand("/quit"), { name: "quit", argument: "" });
  assert.deepEqual(parseSkillInstallCommand("install skill-creator"), { source: "skill-creator", scope: "user" });
  assert.deepEqual(parseSkillInstallCommand('install --workspace "skill drafts/my-skill"'), {
    source: "skill drafts/my-skill",
    scope: "workspace",
  });
  assert.throws(() => parseSkillInstallCommand("install"), /Usage/);
  assert.deepEqual(parseMountsCommand("add D:/docs"), { mode: "add", argument: "D:/docs" });
  assert.equal(parseJobStopCommand("stop abc"), "abc");
});

test("attention policy protects active input and orders Ctrl+G gates", () => {
  assert.equal(canAutoOpenAttention({
    panelOpen: false,
    composerEmpty: true,
    followUpEditing: false,
  }), true);
  assert.equal(canAutoOpenAttention({
    panelOpen: false,
    composerEmpty: false,
    followUpEditing: false,
  }), false);
  assert.equal(canAutoOpenAttention({
    panelOpen: false,
    composerEmpty: true,
    followUpEditing: true,
  }), false);
  assert.equal(highestPriorityAttention({
    runQuestion: true,
    planReview: true,
    nextRun: true,
    sensitivePathGrant: true,
    pathGrant: true,
  }), "run-question");
  assert.equal(highestPriorityAttention({
    runQuestion: false,
    planReview: true,
    nextRun: true,
    sensitivePathGrant: true,
    pathGrant: true,
  }), "plan-review");
  assert.equal(highestPriorityAttention({
    runQuestion: false,
    planReview: false,
    nextRun: false,
    sensitivePathGrant: true,
    pathGrant: true,
  }), "sensitive-path-grant");
  assert.equal(highestPriorityAttention({
    runQuestion: false,
    planReview: false,
    nextRun: false,
    sensitivePathGrant: false,
    pathGrant: true,
  }), "path-grant");
});

test("semantic theme aliases fall back for legacy palettes and NO_COLOR rendering", () => {
  const legacy = {
    primary: "#3DB8A8",
    accent: "#6B9BD2",
    text: "#E6E6E6",
    textStrong: "#F5F5F5",
    textDim: "#8A8A8A",
    textMuted: "#6A6A6A",
    border: "#555555",
    borderFocus: "#3DB8A8",
    success: "#4EC87E",
    warning: "#D4A017",
    error: "#E05C5C",
    diffAdded: "#4EC87E",
    diffRemoved: "#E05C5C",
    diffMeta: "#8A8A8A",
    roleUser: "#E8C47C",
    userMessageBg: "#2A2A2A",
    toolPendingBg: "#243033",
    toolSuccessBg: "#1F2B24",
    toolErrorBg: "#332222",
  };
  const noColor = new Theme("dark", legacy, 0);
  assert.equal(noColor.fg("body", "正文"), "正文");
  assert.equal(noColor.fg("attention", "needs input"), "needs input");
  const basicAnsi = new Theme("dark", legacy, 1).fg("primary", "Qi");
  assert.match(basicAnsi, /\u001b\[(?:3|9)\dmQi/);
  assert.doesNotMatch(basicAnsi, /38;2|38;5/);
});

test("Memory tool has a dedicated lifecycle card", () => {
  const card = stripVTControlCharacters(renderToolCard({
    actionId: "act_memory_card",
    toolName: "memory",
    status: "completed",
    input: { statement: "The project uses pnpm.", scope: "project" },
    output: {
      memoryId: "mem_memory_card",
      status: "candidate",
      scope: "project",
      requiresConfirmation: true,
    },
  }).join("\n"));
  assert.match(card, /Memory · project/);
  assert.match(card, /The project uses pnpm/);
  assert.match(card, /pending user confirmation/);
});

test("read_image card prefers image #N · source over raw artifact JSON", () => {
  const digest = "bc2b1387d6f6ed2ca1fa4d42b0ef10c78d88d598dfac22b9543882b8dbd6b233";
  const labeled = stripVTControlCharacters(renderToolCard({
    actionId: "act_read_image_labeled",
    toolName: "read_image",
    status: "completed",
    elapsed: "124ms",
    subjectHint: "image #1 · path",
    input: {
      artifactRef: `artifact://${digest}`,
      region: { x: 40, y: 900, width: 480, height: 80 },
    },
    output: {
      artifactRef: `artifact://${"a".repeat(64)}`,
      mediaType: "image/png",
      byteLength: 1200,
      width: 480,
      height: 80,
      originalWidth: 1689,
      originalHeight: 1221,
      resized: false,
      region: { x: 40, y: 900, width: 480, height: 80 },
    },
  }).join("\n"));
  assert.match(labeled, /read_image/);
  assert.match(labeled, /image #1 · path/);
  assert.match(labeled, /crop 40,900 480×80/);
  assert.match(labeled, /480×80/);
  assert.doesNotMatch(labeled, /"artifactRef"/);
  assert.doesNotMatch(labeled, new RegExp(digest));

  const unlabeled = stripVTControlCharacters(renderToolCard({
    actionId: "act_read_image_hash",
    toolName: "read_image",
    status: "completed",
    input: { artifactRef: `artifact://${digest}` },
    output: {
      artifactRef: `artifact://${"b".repeat(64)}`,
      mediaType: "image/png",
      byteLength: 100,
      width: 100,
      height: 50,
      originalWidth: 100,
      originalHeight: 50,
      resized: false,
      region: { x: 0, y: 0, width: 100, height: 50 },
    },
  }).join("\n"));
  assert.match(unlabeled, /art_bc2b1387…b233/);
  assert.match(unlabeled, /full|crop 0,0 100×50/);
});

test("TUI reconciles effective mounts into Session audit events across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-mount-reconcile-"));
  const workspace = join(root, "workspace");
  const firstPath = join(root, "reference-a");
  const secondPath = join(root, "reference-b");
  const dataRoot = join(root, "data");
  await mkdir(workspace);
  await mkdir(firstPath);
  await mkdir(secondPath);
  let sessionId;
  let first;
  let second;
  let third;
  try {
    first = await TuiRuntime.create({
      workspaceRoot: workspace,
      dataRoot,
      projectConfigPath: join(root, "project-config.toml"),
      modelPort: new ScriptedModelPort([]),
      model: { provider: "fake", model: "mount-reconcile-v1" },
      mounts: [{ id: "docs", path: firstPath, mode: "read", source: "project_config" }],
    });
    first.syncMountEvents();
    sessionId = first.sessionId;
    assert.equal(first.view()?.mounts.docs?.path, firstPath);
    first.close();
    first = undefined;

    second = await TuiRuntime.create({
      workspaceRoot: workspace,
      dataRoot,
      projectConfigPath: join(root, "project-config.toml"),
      sessionId,
      modelPort: new ScriptedModelPort([]),
      model: { provider: "fake", model: "mount-reconcile-v1" },
      mounts: [{ id: "docs", path: secondPath, mode: "read", source: "project_config" }],
    });
    second.syncMountEvents();
    assert.equal(second.view()?.mounts.docs?.path, secondPath);
    assert.deepEqual(
      second.events().slice(-2).map((event) => event.type),
      ["workspace.mount.removed", "workspace.mount.added"],
    );
    second.close();
    second = undefined;

    third = await TuiRuntime.create({
      workspaceRoot: workspace,
      dataRoot,
      projectConfigPath: join(root, "project-config.toml"),
      sessionId,
      modelPort: new ScriptedModelPort([]),
      model: { provider: "fake", model: "mount-reconcile-v1" },
      mounts: [],
    });
    third.syncMountEvents();
    assert.equal(third.view()?.mounts.docs, undefined);
    assert.equal(third.events().at(-1)?.type, "workspace.mount.removed");
  } finally {
    first?.close();
    second?.close();
    third?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent mount changes retain explicit CLI and command grants in project policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-mount-policy-"));
  const workspace = join(root, "workspace");
  const cliPath = join(root, "cli-reference");
  const persistentPath = join(root, "persistent-reference");
  const projectConfigPath = join(root, "project-config.toml");
  await mkdir(workspace);
  await mkdir(cliPath);
  await mkdir(persistentPath);
  let runtime;
  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: workspace,
      dataRoot: join(root, "data"),
      projectConfigPath,
      modelPort: new ScriptedModelPort([]),
      model: { provider: "fake", model: "mount-policy-v1" },
      mounts: [{ id: "cli", path: cliPath, mode: "read", source: "cli" }],
    });
    await runtime.addMount(persistentPath, "command", "docs");
    const loaded = await loadProjectConfig(projectConfigPath);
    assert.deepEqual(loaded.config.mounts, [
      { id: "cli", path: cliPath, mode: "read" },
      { id: "docs", path: persistentPath, mode: "read" },
    ]);
  } finally {
    runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal Markdown renderer covers headings, lists, tables, code, and checklists", () => {
  const rendered = renderMarkdown([
    "# Title",
    "",
    "Paragraph with `code` and [link](https://example.com).",
    "",
    "- [x] Done",
    "- [ ] Todo",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "```js",
    "const x = 1;",
    "",
    "const y = 2;",
    "```",
  ].join("\n")).join("\n");
  assert.match(rendered, /Title/);
  assert.match(rendered, /═/);
  assert.match(rendered, /☑ Done/);
  assert.match(rendered, /☐ Todo/);
  assert.match(rendered, /│ A/);
  assert.match(rendered, /┌─ js/);
  assert.match(rendered, /example\.com/);
  assert.match(rendered, /const x = 1;/);
  assert.match(rendered, /│\s*$/m);
  assert.match(rendered, /const y = 2;/);
});

test("Formal Plan validation requires document structure and rejects Todo or secrets", () => {
  assert.deepEqual(
    validateFormalPlan("# Release plan\n\nShip the reviewed change.\n\n## Steps\n\n1. Implement it."),
    { title: "Release plan", overview: "Ship the reviewed change." },
  );
  assert.throws(
    () => validateFormalPlan("# Bad\n\nDo this.\n\n- [ ] hidden Todo"),
    /task-list checkboxes/,
  );
  assert.throws(
    () => validateFormalPlan("# Bad\n\napi_key=sk-abcdefghijklmnopqrstuvwxyz"),
    /detected secret/,
  );
  assert.throws(
    () => validateFormalPlan("## Missing H1\n\nSummary."),
    /unique H1/,
  );
});

test("plan_document advertises Moonshot-compatible parameters and keeps operation fields strict", async () => {
  const tool = createPlanDocumentTool({
    dataRoot: "unused",
    artifactStore: {},
    humanControl: {},
  });
  assert.equal(tool.input.type, "object");
  assert.equal(Object.hasOwn(tool.input, "anyOf"), false);
  assert.equal(JSON.stringify(tool.input).includes('"anyOf"'), false);
  assert.deepEqual(tool.input.properties.operation.enum, ["create", "read", "edit"]);
  assert.match(tool.input.description, /create=\{operation,markdown\}/);
  assert.match(tool.input.properties.planId.description, /omit for create/);

  await assert.rejects(
    tool.execute({ operation: "create" }, {}),
    /create requires markdown/,
  );
  await assert.rejects(
    tool.execute({ operation: "read", expectedSha256: "a".repeat(64) }, {}),
    /read does not accept: expectedSha256/,
  );
  await assert.rejects(
    tool.execute({ operation: "edit", planId: "pln_test" }, {}),
    /edit requires: expectedSha256, edits/,
  );
});

test("wide Markdown tables wrap every column instead of truncating the right side", () => {
  const rendered = renderMarkdown([
    "| Action | Status | Evidence | Next step |",
    "| --- | --- | --- | --- |",
    "| build-client | failed | SHELL_EXIT_NONZERO after the package script returned a diagnostic | inspect the complete retained output and retry the narrow check |",
  ].join("\n"), { width: 52 }).join("\n");
  const compact = rendered.replace(/[\s│├┼┤─]/g, "");
  assert.doesNotMatch(rendered, /…/);
  assert.match(compact, /build-client/);
  assert.match(compact, /SHELL_EXIT_NONZERO/);
  assert.match(rendered, /diagnostic/);
  assert.match(compact, /completeretained/);
  assert.match(compact, /narrowcheck/);
  for (const line of rendered.split("\n")) assert.ok(line.length <= 52);
});

test("final summary Markdown renders h3 and glued heading+table without raw hashes", () => {
  const rendered = renderMarkdown([
    "已完成文案与可释放空间口径调整。",
    "",
    "### 1. 文案",
    "| 原 | 现 |",
    "|---|---|",
    "| Lab 平台占用 | 平台占用 / 项目占用（按 scope） |",
    "| 扫描产物 | 扫描日志与 SARIF |",
    "",
    "### 2. 原因与修复",
    "• 原因：统计口径不一致",
    "• 修复：reclaimableBytes 与预览共用 selectCleanupItems",
    "",
    "### 涉及文件",
    "• backend/internal/datamanage/service/storage.go",
  ].join("\n"), { width: 100 }).join("\n");
  assert.match(rendered, /^1\. 文案$/m);
  assert.match(rendered, /^─+$/m);
  assert.doesNotMatch(rendered, /^#{1,6}\s/m);
  assert.match(rendered, /│ 原/);
  assert.match(rendered, /│ Lab 平台占用/);
  assert.match(rendered, /│ 平台占用 \/ 项目占用/);
  assert.match(rendered, /• 原因：统计口径不一致/);
  assert.match(rendered, /^2\. 原因与修复$/m);
  assert.match(rendered, /^涉及文件$/m);
  assert.doesNotMatch(rendered, /^\| 原 \| 现 \|$/m);
});

test("TUI presenter reconstructs context, shell, diff, and durable Plan progress from events", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-presentation-"));
  const model = new ScriptedModelPort([
    [
      {
        type: "reasoning.delta",
        delta: "I am turning the requested feature into a self-contained implementation and verification plan.",
      },
      {
        type: "action.requested",
        callId: "call_plan",
        name: "plan_document",
        input: {
          operation: "create",
          markdown: "# Feature plan\n\nShip a small feature with verification.\n\n## Implementation\n\n1. Inspect the workspace before editing.\n2. Write feature.js and verify with a short script.\n\n## Verification\n\nRun the focused script.",
        },
      },
      { type: "completed", finishReason: "actions" },
    ],
    [
      { type: "text.delta", delta: "Plan revision ready for review." },
      { type: "completed", finishReason: "stop" },
    ],
    [
      {
        type: "action.requested",
        callId: "call_code",
        name: "write",
        input: {
          path: "feature.js",
          content: "export const ready = true;\n",
          expectedSha256: null,
        },
      },
      { type: "completed", finishReason: "actions" },
    ],
    [
      {
        type: "action.requested",
        callId: "call_shell",
        name: "shell",
        input: {
          command: process.execPath,
          args: ["-e", "console.log('verified')"],
          timeoutMs: 10_000,
        },
      },
      { type: "completed", finishReason: "actions" },
    ],
    [
      { type: "text.delta", delta: "Implemented and verified the feature." },
      { type: "usage", inputTokens: 1_200, outputTokens: 30 },
      { type: "completed", finishReason: "stop" },
    ],
  ]);
  const runtime = await TuiRuntime.create({
    workspaceRoot: root,
    dataRoot: join(root, ".qi"),
    modelPort: model,
    model: { provider: "fake", model: "presentation-v1" },
    contextWindowTokens: 80_000,
    outputReserveTokens: 16_000,
    allowWrite: true,
    allowExecute: true,
  });
  try {
    runtime.changeMode("plan", "test setup");
    const planned = await runtime.run("Draft a plan for the feature.");
    assert.equal(planned.status, "completed");
    assert.equal(runtime.view()?.pendingReview?.status, "pending");

    const accepted = runtime.acceptPlan();
    const acceptedPresenter = new TuiPresenter({
      workspaceRoot: root,
      dataRoot: join(root, ".qi"),
      provider: "fake",
      model: "presentation-v1",
      capabilities: ["write", "host execute"],
      contextWindowTokens: 80_000,
      contextBudgetTokens: 64_000,
      outputReserveTokens: 16_000,
      historyBudgetTokens: 16_000,
      maxSteps: 20,
      maxActionsPerStep: 6,
    });
    acceptedPresenter.update(runtime.events(), runtime.view());
    const acceptedTranscript = acceptedPresenter.render().join("\n");
    assert.match(acceptedTranscript, /Accepted Plan · Feature plan · rev 1/);
    assert.match(acceptedTranscript, /Inspect the workspace before editing/);
    assert.match(acceptedTranscript, /Run the focused script/);
    assert.match(acceptedTranscript, /Formal Plan file · .*plans.*\.md/);
    assert.doesNotMatch(acceptedTranscript, /\[Pasted text|<accepted-plan|Ctrl\+O to expand/);

    const result = await runtime.runTriggered(accepted.runId, accepted.input);
    assert.equal(result.status, "completed");
    const executorPrompt = model.requests[2].messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert.match(executorPrompt, /<accepted-plan/);
    assert.match(executorPrompt, /Write feature\.js/);
    assert.doesNotMatch(executorPrompt, /Draft a plan for the feature/);
    assert.equal(await readFile(join(root, "feature.js"), "utf8"), "export const ready = true;\n");
    assert.equal(runtime.view()?.pendingQuestion, undefined);

    const presenter = new TuiPresenter({
      workspaceRoot: root,
      dataRoot: join(root, ".qi"),
      provider: "fake",
      model: "presentation-v1",
      capabilities: ["write", "host execute"],
      contextWindowTokens: 80_000,
      contextBudgetTokens: 64_000,
      outputReserveTokens: 16_000,
      historyBudgetTokens: 16_000,
      maxSteps: 20,
      maxActionsPerStep: 6,
    });
    presenter.update(runtime.events(), runtime.view());

    const overview = presenter.render().join("\n");
    assert.match(overview, /^Qi  v/m);
    assert.match(overview, /Draft a plan for the feature|Execute Plan item/);
    assert.match(overview, /Thinking · \d+(?:ms|s) · Ctrl\+O/);
    assert.doesNotMatch(overview, /self-contained implementation and verification plan/);
    presenter.setDensity("diagnostic");
    assert.match(presenter.render().join("\n"), /self-contained implementation and verification plan/);
    presenter.setDensity("standard");
    assert.match(overview, /Accepted Plan · Feature plan · rev 1/);
    assert.match(overview, /Inspect the workspace before editing/);
    assert.match(overview, /Run the focused script/);
    assert.doesNotMatch(overview, /<accepted-plan|\[Pasted text ·|Implement the accepted plan/);
    assert.match(overview, /Implemented and verified the feature/);
    assert.match(overview, /\$ /);
    assert.match(overview, /Ctrl\+O to expand|verified|exit /);
    assert.match(overview, /Edited feature\.js \+1/);
    assert.match(overview, /▎ \+export const ready = true/);
    assert.doesNotMatch(overview, /Next Run pending/);
    assert.doesNotMatch(overview, /Todo\s+/);
    assert.doesNotMatch(overview, /── Handoff ──/);
    assert.doesNotMatch(overview, /Session timeline/);
    assert.doesNotMatch(overview, /╭ Run /);
    assert.match(presenter.renderPlan().join("\n"), /Feature plan/);
    // write/edit cards must show real diff lines, not only a collapsed summary
    assert.match(overview, /\+export const ready = true/);

    presenter.pushInspection("providers");
    assert.match(presenter.render().join("\n"), /Providers/);
    assert.match(presenter.render().join("\n"), /fake\/presentation-v1|profile\s+fake/);
    presenter.pushInspection("coord");
    assert.match(presenter.render().join("\n"), /not available in this runtime build/);
    assert.match(presenter.render().join("\n"), /No simulated/);

    const status = presenter.formatStatusline(false, 120).join("\n");
    assert.match(status, /fake\/presentation-v1/);
    assert.match(status, /Agent/);
    assert.match(status, /files/);
    assert.match(presenter.renderWorking(true).join("\n"), /◇\s+Waiting/);

    presenter.pushInspection("diff");
    const withDiff = presenter.render().join("\n");
    assert.match(withDiff, /Execute Plan item|Draft a plan/);
    assert.match(withDiff, /\+export const ready = true/);
    assert.match(presenter.selectAction("2"), /Inspecting Action/);
    presenter.pushInspection("diff");
    assert.match(presenter.render().join("\n"), /feature\.js/);
    assert.ok(
      presenter.inspections().length >= 4,
      `expected at least 4 inspections, got ${presenter.inspections().length}`,
    );
    assert.ok(presenter.inspections().every((entry) => Number.isInteger(entry.sessionSequence)));

    presenter.pushInspection("context");
    const context = presenter.render().join("\n");
    assert.match(context, /history\s+newest completed turns, capped at 16\.00k/);
    assert.match(context, /boundary\s+safe between Steps/);

    presenter.pushInspection("actions");
    assert.match(presenter.render().join("\n"), /shell\s+completed/);
    assert.match(presenter.selectAction("1"), /Inspecting Action/);
    assert.match(presenter.selectStep("prev"), /Inspecting Step/);

    presenter.pushInspection("overview");
    assert.match(presenter.render().join("\n"), /Status/);
    assert.match(presenter.render().join("\n"), /run \d+\/\d+ responded/);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Ctrl+C clears a non-empty composer before exiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-ctrlc-"));
  const runtime = await TuiRuntime.create({
    workspaceRoot: root,
    dataRoot: join(root, ".qi"),
    userSkillsRoot: join(root, "user-skills"),
    skillCompatibilityRoots: [],
    modelPort: new ScriptedModelPort([]),
    model: { provider: "fake", model: "ctrlc-v1" },
  });
  const terminal = new FakeTerminal();
  const presenter = new TuiPresenter({
    workspaceRoot: root,
    dataRoot: join(root, ".qi"),
    provider: "fake",
    model: "ctrlc-v1",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const tui = new InteractiveTui(runtime, presenter, { terminal });
  try {
    const running = tui.run();
    await delay(25);
    terminal.sendText("draft that should clear");
    await delay(25);
    assert.match(terminal.output, /ctrl\+c to clear/);
    terminal.sendText("\u0003");
    await delay(25);
    assert.equal(terminal.stopped, false);
    assert.match(terminal.output, /ctrl\+c to quit/);
    terminal.sendText("\u0003");
    await Promise.race([
      running,
      delay(2_000).then(() => { throw new Error("interactive TUI did not exit after empty Ctrl+C"); }),
    ]);
    assert.equal(terminal.stopped, true);
  } finally {
    await tui.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI pads a multi-line user message as one block", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-multiline-card-"));
  const runtime = await TuiRuntime.create({
    workspaceRoot: root,
    dataRoot: join(root, ".qi"),
    userSkillsRoot: join(root, "user-skills"),
    skillCompatibilityRoots: [],
    modelPort: new ScriptedModelPort([[
      { type: "text.delta", delta: "Received both lines." },
      { type: "completed", finishReason: "stop", responseId: "response_multiline_card" },
    ]]),
    model: { provider: "fake", model: "multiline-card-v1" },
  });
  await runtime.run("first logical line\nsecond logical line");
  const terminal = new FakeTerminal();
  const presenter = new TuiPresenter({
    workspaceRoot: root,
    dataRoot: join(root, ".qi"),
    provider: "fake",
    model: "multiline-card-v1",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const tui = new InteractiveTui(runtime, presenter, { terminal });
  try {
    const running = tui.run();
    await delay(25);
    const rendered = stripVTControlCharacters(terminal.output);
    const firstEnd = rendered.indexOf("first logical line") + "first logical line".length;
    const secondStart = rendered.indexOf("second logical line", firstEnd);
    assert.ok(firstEnd >= "first logical line".length);
    assert.ok(secondStart > firstEnd);
    assert.equal((rendered.slice(firstEnd, secondStart).match(/\n/g) ?? []).length, 1);
    terminal.sendText("\u0003");
    await running;
  } finally {
    await tui.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI renders command help and exits through the editor", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-interactive-"));
  const runtime = await TuiRuntime.create({
    workspaceRoot: root,
    dataRoot: join(root, ".qi"),
    userSkillsRoot: join(root, "user-skills"),
    skillCompatibilityRoots: [],
    modelPort: new ScriptedModelPort([]),
    model: { provider: "fake", model: "interactive-v1" },
  });
  const terminal = new FakeTerminal();
  const presenter = new TuiPresenter({
    workspaceRoot: root,
    dataRoot: join(root, ".qi"),
    provider: "fake",
    model: "interactive-v1",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const tui = new InteractiveTui(runtime, presenter, { terminal });
  try {
    const running = tui.run();
    await delay(25);
    terminal.sendText("/help\r");
    await delay(25);
    assert.match(terminal.output, /Qi|QI|栖/);
    assert.match(terminal.output, /Keyboard shortcuts|Slash commands|键盘快捷键|常用 Slash 命令/);
    assert.match(terminal.output, /\/settings|\/mounts|\/mode/);
    // Esc closes the temporary panel (does not write Session).
    terminal.sendText("\u001b");
    await delay(25);
    terminal.sendText("/settings\r");
    await waitUntil(() => /Providers|提供商|Language|语言/.test(terminal.output));
    assert.match(terminal.output, /\btheme\b|Theme|主题/);
    const settingsSection = [...stripVTControlCharacters(terminal.output).matchAll(/(?:Settings|设置)[\s\S]*?(?=─{20,})/g)].at(-1)?.[0] ?? "";
    assert.ok(settingsSection.length > 0);
    assert.doesNotMatch(settingsSection, /^\s*[❯]?\s*\/runs\b/m);
    assert.doesNotMatch(settingsSection, /Session history|会话历史|Run 历史/);
    terminal.sendText("\u001b");
    await delay(25);
    terminal.sendText("/skills\r");
    await waitUntil(() => /Install skill|安装技能|Always-on Skills|始终启用的 Skill/.test(terminal.output));
    terminal.sendText("\r");
    await waitUntil(() => /No always-on Skills|没有始终启用的 Skill/.test(terminal.output));
    assert.match(terminal.output, /\/skills/);
    assert.equal(presenter.inspections().length, 0);
    assert.equal(runtime.events().length, 0);
    // Empty always-on list keeps the hub visible; Esc returns to the composer.
    terminal.sendText("\u001b");
    await delay(25);
    terminal.sendText("/quit\r");
    await Promise.race([
      running,
      delay(2_000).then(() => { throw new Error("interactive TUI did not exit"); }),
    ]);
    assert.equal(terminal.stopped, true);
  } finally {
    await tui.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("slash inspect commands open temporary panels without writing Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-inspect-"));
  const model = new ScriptedModelPort([
    [
      { type: "text.delta", delta: "# Done\n\n- item one\n- item two" },
      { type: "completed", finishReason: "stop" },
    ],
  ]);
  const runtime = await TuiRuntime.create({
    workspaceRoot: root,
    dataRoot: join(root, ".qi"),
    modelPort: model,
    model: { provider: "fake", model: "inspect-v1" },
  });
  const terminal = new FakeTerminal();
  const presenter = new TuiPresenter({
    workspaceRoot: root,
    dataRoot: join(root, ".qi"),
    provider: "fake",
    model: "inspect-v1",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const tui = new InteractiveTui(runtime, presenter, { terminal });
  try {
    const running = tui.run();
    await delay(25);
    terminal.sendText("Ship a short Markdown reply\r");
    await waitUntil(() => /item one/.test(terminal.output));
    assert.match(terminal.output, /Ship a short Markdown reply/);
    assert.match(terminal.output, /• item one/);
    assert.doesNotMatch(terminal.output, /── Handoff ──/);
    assert.doesNotMatch(terminal.output, /Session timeline/);
    const eventsBefore = runtime.events().length;
    terminal.sendText("/config\r");
    await waitUntil(() => /Effective configuration/.test(terminal.output));
    assert.match(terminal.output, /Ship a short Markdown reply/);
    assert.equal(presenter.inspections().length, 0);
    assert.equal(runtime.events().length, eventsBefore);
    terminal.sendText("\u001b");
    await delay(25);
    terminal.sendText("/quit\r");
    await Promise.race([
      running,
      delay(2_000).then(() => { throw new Error("interactive TUI did not exit"); }),
    ]);
  } finally {
    await tui.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery tip recommends rg/fd when accelerators are missing", () => {
  assert.equal(discoveryAcceleratorTip("en", []), undefined);
  assert.match(
    discoveryAcceleratorTip("en", ["rg", "fd"]) ?? "",
    /Tip: install rg \+ fd on PATH/,
  );
  assert.match(
    discoveryAcceleratorTip("zh", ["rg"]) ?? "",
    /提示: 建议安装 rg 到 PATH/,
  );
  if (process.platform === "win32") {
    assert.match(
      discoveryAcceleratorTip("en", ["rg", "fd"]) ?? "",
      /winget install BurntSushi\.ripgrep\.MSVC sharkdp\.fd/,
    );
  }
});

test("empty composer placeholder shows → Add prompt with static caret on A", () => {
  const idle = renderComposerPlaceholder(80, {
    left: "→ Add a message",
    right: "ctrl+c to quit",
  });
  assert.equal(idle.length, 3);
  assert.match(idle[0] ?? "", /─{10,}/);
  assert.match(idle[1] ?? "", /→ /);
  assert.match(idle[1] ?? "", /dd a message/);
  assert.match(idle[1] ?? "", /ctrl\+c to quit/);
  // Static reverse-video caret on the A — not a hardware CURSOR_MARKER.
  assert.match(idle[1] ?? "", /\u001b\[7mA\u001b\[0m/);
  assert.doesNotMatch(idle.join("\n"), /\u001b_pi:c\u0007/);

  const followUp = renderComposerPlaceholder(80, {
    left: "→ Add a follow-up",
    right: "ctrl+c to stop",
  });
  assert.match(followUp[1] ?? "", /\u001b\[7mA\u001b\[0m/);
  assert.match(followUp[1] ?? "", /dd a follow-up/);
  assert.match(followUp[1] ?? "", /ctrl\+c to stop/);
});

test("chat-only Runs match the Cursor-style compact transcript", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "D:\\lab-ws\\projects\\todo-demo",
    dataRoot: "D:\\lab-ws\\projects\\todo-demo\\.qi",
    provider: "xai",
    model: "grok-4.5",
    capabilities: ["write", "host execute"],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
    branch: "main",
    version: "0.4.0",
  });
  presenter.update([], {
    sessionId: "ses_chat",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "agent",
    runOrder: ["run_1"],
    currentRunId: "run_1",
    runs: {
      run_1: {
        runId: "run_1",
        trigger: "user",
        mode: "agent",
        status: "completed",
        input: "hi",
        content: [
          { type: "text", text: "hi" },
          {
            type: "image",
            source: "clipboard",
            originalArtifactRef: `artifact://${"a".repeat(64)}`,
            preparedArtifactRef: `artifact://${"b".repeat(64)}`,
            originalMediaType: "image/png",
            mediaType: "image/jpeg",
            originalByteLength: 5000000,
            byteLength: 100000,
            originalWidth: 2400,
            originalHeight: 1200,
            width: 1200,
            height: 600,
            downsampled: true,
            formatChanged: true,
            orientationApplied: false,
          },
        ],
        stepOrder: ["stp_1"],
        steps: {
          stp_1: {
            stepId: "stp_1",
            status: "completed",
            context: { estimatedTokens: 3400, budgetTokens: 240_000, includedBlockIds: [], omittedBlockIds: [] },
            model: { text: "Hi — what would you like to work on?", finishReason: "stop" },
          },
        },
        actions: {},
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "completed", reason: "response" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "waiting", reason: "idle" },
  });
  const rendered = presenter.render(80).join("\n");
  assert.match(rendered, /Qi  v0\.4\.0/);
  assert.match(rendered, /⟦user⟧hi/);
  assert.match(rendered, /image #1 · clipboard · 2400×1200 → 1200×600 · image\/png → image\/jpeg/);
  assert.match(rendered, /^Hi — what would you like to work on\?$/m);
  assert.doesNotMatch(rendered, /Step 1\/1/);
  assert.doesNotMatch(rendered, /── Handoff ──/);
  assert.doesNotMatch(rendered, /Session timeline|╭ Run /);
  const status = presenter.formatStatusline(false, 80).join("\n");
  assert.match(status, /xai\/grok-4\.5/);
  assert.match(status, /Agent/);
  assert.match(status, /todo-demo · main/);
  assert.doesNotMatch(status, /write\+host execute/);
  assert.match(presenter.renderWorking(true, 0).join("\n"), /◇\s+Waiting/);
});

test("chat render reuses settled-run blocks and indexes Action events", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "perf",
    capabilities: ["write"],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const actor = { kind: "runtime", id: "t" };
  const runs = {};
  const runOrder = [];
  const events = [];
  let sequence = 1;
  for (let i = 1; i <= 12; i += 1) {
    const runId = `run_${i}`;
    const stepId = `stp_${i}`;
    const actionId = `act_${i}`;
    runOrder.push(runId);
    runs[runId] = {
      runId,
      trigger: "user",
      mode: "agent",
      status: "completed",
      input: `prompt ${i}`,
      stepOrder: [stepId],
      steps: {
        [stepId]: {
          stepId,
          status: "completed",
          context: { estimatedTokens: 100, budgetTokens: 64_000, includedBlockIds: [], omittedBlockIds: [] },
          model: { text: `done ${i}`, finishReason: "stop" },
        },
      },
      actions: {
        [actionId]: {
          actionId,
          stepId,
          toolName: "edit",
          effect: "write",
          status: "completed",
          resources: [`file://${i}.ts`],
        },
      },
      evaluations: {},
      steering: [],
      delegations: {},
      terminal: { type: "completed", reason: "response" },
    };
    events.push({
      type: "action.proposed",
      sequence: sequence++,
      occurredAt: new Date(0).toISOString(),
      actor,
      data: {
        runId,
        stepId,
        actionId,
        toolName: "edit",
        effect: "write",
        input: { path: `src/f${i}.ts`, old_string: "a", new_string: "b" },
        resources: [`file://${i}.ts`],
      },
    });
    events.push({
      type: "action.started",
      sequence: sequence++,
      occurredAt: new Date(0).toISOString(),
      actor,
      data: { runId, stepId, actionId, leaseId: `lease_${i}` },
    });
    events.push({
      type: "action.completed",
      sequence: sequence++,
      occurredAt: new Date(0).toISOString(),
      actor,
      data: {
        runId,
        stepId,
        actionId,
        modelOutput: [{ type: "text", text: JSON.stringify({ path: `src/f${i}.ts`, diff: `+line ${i}` }) }],
      },
    });
  }
  // Active trailing Run forces live path while settled Runs stay cacheable.
  runOrder.push("run_live");
  runs.run_live = {
    runId: "run_live",
    trigger: "user",
    mode: "agent",
    status: "active",
    input: "keep going",
    stepOrder: ["stp_live"],
    steps: {
      stp_live: {
        stepId: "stp_live",
        status: "running",
        context: { estimatedTokens: 200, budgetTokens: 64_000, includedBlockIds: [], omittedBlockIds: [] },
      },
    },
    actions: {},
    evaluations: {},
    steering: [],
    delegations: {},
  };
  presenter.update(events, {
    sessionId: "ses_perf",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "agent",
    runOrder,
    currentRunId: "run_live",
    runs,
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "busy", reason: "running" },
  });
  const first = presenter.render(100).join("\n");
  const second = presenter.render(100).join("\n");
  assert.equal(second, first);
  assert.match(first, /⟦user⟧prompt 1/);
  assert.match(first, /edit\s+src\/f12\.ts/);
  assert.match(first, /⟦user⟧keep going/);
  presenter.selectRun("run_12");
  const actions = presenter.historyActionItems();
  assert.equal(actions.length, 1);
  assert.match(actions[0].description, /src\/f12\.ts/);
  // Indexed propose pass feeds files-changed for the executing Run (live has none).
  assert.doesNotMatch(presenter.formatStatusline(true, 80).join("\n"), /\d+ files/);
});

test("timeline density groups consecutive read-only exploration and preserves diagnostic detail", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "density",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
    timelineDensity: "standard",
  });
  const actor = { kind: "runtime", id: "timeline-test" };
  const actionSpecs = [
    ["act_read", "read", { path: "src/a.ts" }],
    ["act_find", "find", { pattern: "TODO" }],
    ["act_search", "search", { query: "timeline" }],
  ];
  const events = actionSpecs.flatMap(([actionId, toolName, input], index) => [
    {
      schemaVersion: 1,
      eventId: `evt_${actionId}_proposed`,
      sessionId: "ses_density",
      sequence: index * 3 + 1,
      occurredAt: new Date(index * 10).toISOString(),
      actor,
      type: "action.proposed",
      data: {
        runId: "run_density",
        stepId: "stp_density",
        actionId,
        toolName,
        effect: "read",
        input,
        resources: [],
      },
    },
    {
      schemaVersion: 1,
      eventId: `evt_${actionId}_started`,
      sessionId: "ses_density",
      sequence: index * 3 + 2,
      occurredAt: new Date(index * 10 + 1).toISOString(),
      actor,
      type: "action.started",
      data: { runId: "run_density", stepId: "stp_density", actionId },
    },
    {
      schemaVersion: 1,
      eventId: `evt_${actionId}_completed`,
      sessionId: "ses_density",
      sequence: index * 3 + 3,
      occurredAt: new Date(index * 10 + 2).toISOString(),
      actor,
      type: "action.completed",
      data: { runId: "run_density", stepId: "stp_density", actionId, modelOutput: [] },
    },
  ]);
  const actions = Object.fromEntries(actionSpecs.map(([actionId, toolName]) => [
    actionId,
    {
      actionId,
      stepId: "stp_density",
      toolName,
      effect: "read",
      status: "completed",
      resources: [],
    },
  ]));
  const view = {
    sessionId: "ses_density",
    createdAt: new Date(0).toISOString(),
    version: events.length,
    mode: "agent",
    runOrder: ["run_density"],
    runs: {
      run_density: {
        runId: "run_density",
        trigger: "user",
        mode: "agent",
        status: "completed",
        input: "inspect the timeline",
        stepOrder: ["stp_density"],
        steps: {
          stp_density: {
            stepId: "stp_density",
            status: "completed",
            context: { estimatedTokens: 100, budgetTokens: 64_000, includedBlockIds: [], omittedBlockIds: [] },
            model: { text: "Inspection complete.", reasoning: "First inspect, then compare.", finishReason: "stop" },
          },
        },
        actions,
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "completed", reason: "response" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "idle" },
  };
  presenter.update(events, view);
  const standard = presenter.render(100).join("\n");
  assert.match(standard, /Explored 3 actions · read 1 · find 1 · search 1 · Ctrl\+O/);
  assert.match(standard, /Thinking ·/);

  presenter.setDensity("diagnostic");
  const diagnostic = presenter.render(100).join("\n");
  assert.equal(presenter.density(), "diagnostic");
  assert.match(diagnostic, /First inspect, then compare/);
  assert.match(diagnostic, /src\/a\.ts|TODO|timeline/);

  presenter.setDensity("compact");
  assert.doesNotMatch(presenter.render(100).join("\n"), /Thinking ·/);
});

test("applyCommitted accepts contiguous facts and requests resync for gaps", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "incremental",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const view = {
    sessionId: "ses_incremental",
    createdAt: new Date(0).toISOString(),
    version: 2,
    mode: "agent",
    runOrder: [],
    runs: {},
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "idle" },
  };
  const first = {
    schemaVersion: 1,
    eventId: "evt_incremental_1",
    sessionId: "ses_incremental",
    sequence: 1,
    occurredAt: new Date(0).toISOString(),
    actor: { kind: "runtime", id: "test" },
    type: "session.created",
    data: { mode: "agent" },
  };
  const second = {
    schemaVersion: 1,
    eventId: "evt_incremental_2",
    sessionId: "ses_incremental",
    sequence: 2,
    occurredAt: new Date(1).toISOString(),
    actor: { kind: "runtime", id: "test" },
    type: "session.mode.changed",
    data: { mode: "agent" },
  };
  assert.equal(presenter.applyCommitted(first, view), true);
  assert.equal(presenter.applyCommitted(second, view), true);
  assert.equal(presenter.applyCommitted({ ...second, sequence: 4, eventId: "evt_incremental_4" }, view), false);
});

test("eventAffectsTranscript classifies chrome-only Session facts", () => {
  assert.equal(eventAffectsTranscript({ type: "authority.requested" }), false);
  assert.equal(eventAffectsTranscript({ type: "authority.granted" }), false);
  assert.equal(eventAffectsTranscript({ type: "authority.denied" }), true);
  assert.equal(eventAffectsTranscript({ type: "safety.redaction.applied" }), false);
  assert.equal(eventAffectsTranscript({ type: "context.compiled" }), false);
  assert.equal(eventAffectsTranscript({ type: "workspace.mount.added" }), false);
  assert.equal(eventAffectsTranscript({ type: "action.completed" }), true);
  assert.equal(eventAffectsTranscript({ type: "step.completed" }), true);
  assert.equal(eventAffectsTranscript({ type: "run.started" }), true);
});

test("authority denial repaints the visible Action settlement", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "denial",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const runId = "run_denied";
  const stepId = "stp_denied";
  const actionId = "act_denied";
  presenter.update(
    [{
      type: "action.proposed",
      sequence: 1,
      occurredAt: new Date(0).toISOString(),
      actor: { kind: "runtime", id: "t" },
      data: {
        runId,
        stepId,
        actionId,
        toolName: "edit",
        effect: "write",
        input: { path: "src/denied.ts" },
        resources: ["file://src/denied.ts"],
      },
    }],
    {
      sessionId: "ses_denied",
      createdAt: new Date(0).toISOString(),
      version: 1,
      mode: "agent",
      runOrder: [runId],
      currentRunId: runId,
      runs: {
        [runId]: {
          runId,
          trigger: "user",
          mode: "agent",
          status: "active",
          input: "try edit",
          stepOrder: [stepId],
          steps: {
            [stepId]: {
              stepId,
              status: "running",
              context: { estimatedTokens: 100, budgetTokens: 64_000, includedBlockIds: [], omittedBlockIds: [] },
            },
          },
          actions: {
            [actionId]: {
              actionId,
              stepId,
              toolName: "edit",
              effect: "write",
              status: "denied",
              resources: ["file://src/denied.ts"],
            },
          },
          evaluations: {},
          steering: [],
          delegations: {},
        },
      },
      goals: {},
      goalOrder: [],
      evidence: {},
      controlReceipts: {},
      memories: {},
      memoryOrder: [],
      tasks: {},
      taskOrder: [],
      plans: {},
      planOrder: [],
      presence: { state: "busy", reason: "running" },
    },
  );
  assert.match(
    stripVTControlCharacters(presenter.render(100).join("\n")),
    /⊘ edit\s+src\/denied\.ts.*denied/,
  );
});

test("active Run folds older Steps but keeps bounded edit diffs in the retained window", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "fold",
    capabilities: ["write"],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 40,
    maxActionsPerStep: 6,
  });
  const actor = { kind: "runtime", id: "t" };
  const runId = "run_long";
  const stepOrder = [];
  const steps = {};
  const actions = {};
  const events = [];
  let sequence = 1;
  for (let i = 1; i <= 12; i += 1) {
    const stepId = `stp_${i}`;
    const actionId = `act_${i}`;
    stepOrder.push(stepId);
    steps[stepId] = {
      stepId,
      status: i === 12 ? "running" : "completed",
      context: { estimatedTokens: 100, budgetTokens: 64_000, includedBlockIds: [], omittedBlockIds: [] },
      ...(i === 12
        ? {}
        : { model: { text: `narration ${i}`, finishReason: "actions" } }),
    };
    actions[actionId] = {
      actionId,
      stepId,
      toolName: "edit",
      effect: "write",
      status: i === 12 ? "running" : "completed",
      resources: [`file://f${i}.ts`],
    };
    events.push({
      type: "action.proposed",
      sequence: sequence++,
      occurredAt: new Date(0).toISOString(),
      actor,
      data: {
        runId,
        stepId,
        actionId,
        toolName: "edit",
        effect: "write",
        input: { path: `src/f${i}.ts`, old_string: "a", new_string: "b" },
        resources: [`file://f${i}.ts`],
      },
    });
    if (i < 12) {
      events.push({
        type: "action.started",
        sequence: sequence++,
        occurredAt: new Date(0).toISOString(),
        actor,
        data: { runId, stepId, actionId, leaseId: `lease_${i}` },
      });
      events.push({
        type: "action.completed",
        sequence: sequence++,
        occurredAt: new Date(0).toISOString(),
        actor,
        data: {
          runId,
          stepId,
          actionId,
          modelOutput: [{
            type: "text",
            text: JSON.stringify({
              path: `src/f${i}.ts`,
              diff: [
                "--- a/src/f.ts",
                "+++ b/src/f.ts",
                "@@ -1 +1 @@",
                `-old ${i}`,
                `+new ${i}`,
              ].join("\n"),
            }),
          }],
        },
      });
    }
  }
  events.push({
    type: "action.started",
    sequence: sequence++,
    occurredAt: new Date(0).toISOString(),
    actor,
    data: { runId, stepId: "stp_12", actionId: "act_12", leaseId: "lease_12" },
  });
  presenter.update(events, {
    sessionId: "ses_fold",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "agent",
    runOrder: [runId],
    currentRunId: runId,
    runs: {
      [runId]: {
        runId,
        trigger: "user",
        mode: "agent",
        status: "active",
        input: "explore the codebase",
        stepOrder,
        steps,
        actions,
        evaluations: {},
        steering: [],
        delegations: {},
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "busy", reason: "running" },
  });
  const first = presenter.render(100);
  const firstText = first.join("\n");
  assert.match(firstText, /… 4 earlier steps · 4 actions · Ctrl\+O/);
  assert.doesNotMatch(firstText, /· narration 1$/m);
  assert.doesNotMatch(firstText, /src\/f1\.ts/);
  assert.match(firstText, /Edited src\/f5\.ts/);
  assert.match(firstText, /Edited src\/f11\.ts/);
  assert.match(firstText, /▎ -old 5/);
  assert.match(firstText, /▎ \+new 11/);
  // Narration stays summarized while completed mutations retain their bounded diff cards.
  assert.match(firstText, /· narration 11/);
  const second = presenter.render(100);
  assert.equal(second.join("\n"), firstText);
  assert.equal(presenter.toggleExpand(), "Expanded earlier steps");
  const expanded = presenter.render(100).join("\n");
  assert.match(expanded, /· narration 1$/m);
  assert.match(expanded, /Edited src\/f1\.ts/);
  assert.match(expanded, /▎ \+new 1/);
  assert.equal(presenter.toggleExpand(), "Collapsed earlier steps");
  const collapsedAgain = presenter.render(100).join("\n");
  assert.match(collapsedAgain, /… 4 earlier steps · 4 actions · Ctrl\+O/);
  assert.doesNotMatch(collapsedAgain, /· narration 1$/m);

  presenter.applyActivity({
    type: "model.text",
    sessionId: "ses_fold",
    runId,
    stepId: "stp_12",
    text: "earlier model text\nlatest model tail",
    estimatedOutputTokens: 10,
    provisional: true,
  });
  const modelWorking = presenter.renderWorking(true, 0, 40);
  assert.equal(modelWorking.length, 3);
  assert.match(modelWorking[1], /earlier model text/);
  assert.match(modelWorking[2], /latest model tail/);

  presenter.applyActivity({
    type: "model.reasoning",
    sessionId: "ses_fold",
    runId,
    stepId: "stp_12",
    text: "reasoning one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen",
    estimatedOutputTokens: 20,
    provisional: true,
  });
  const reasoningWorking = presenter.renderWorking(true, 0, 40);
  assert.equal(reasoningWorking.length, 4);
  assert.equal(reasoningWorking.slice(1).every((line) => /thinking ·/.test(line)), true);

  presenter.applyActivity({
    type: "action.output",
    sessionId: "ses_fold",
    runId,
    stepId: "stp_12",
    actionId: "act_12",
    stream: "stderr",
    text: "old tool output\nlatest tool tail",
    truncated: false,
    provisional: true,
  });
  const actionWorking = presenter.renderWorking(true, 0, 40);
  assert.equal(actionWorking.length, 3);
  assert.match(actionWorking[1], /stderr · old tool output/);
  assert.match(actionWorking[2], /stderr · latest tool tail/);
  assert.ok(actionWorking.slice(1).every((line) => line.length <= 40));

  presenter.applyActivity({
    type: "action.output",
    sessionId: "ses_fold",
    runId,
    stepId: "stp_12",
    actionId: "act_12",
    stream: "stdout",
    text: "first\nsecond\nthird\nfourth",
    truncated: false,
    provisional: true,
  });
  const boundedWorking = presenter.renderWorking(true, 0, 40);
  assert.equal(boundedWorking.length, 4);
  assert.doesNotMatch(boundedWorking.join("\n"), /first/);
  assert.match(boundedWorking[1], /second/);
  assert.match(boundedWorking[3], /fourth/);
  assert.match(presenter.renderWorking(true, 2_001, 80)[0], /2\.0s/);
  assert.match(presenter.renderWorking(true, 30_001, 80)[0], /still running/);
});

test("length-truncated thinking dumps stay collapsed in the transcript", () => {
  const wall = `UNIQUE_THINKING_MARKER ${"thinking ".repeat(2_000)}${"tail ".repeat(200)}`;
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "length-thinking",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const stepId = "stp_length";
  const runId = "run_length";
  presenter.update([], {
    sessionId: "ses_length",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "agent",
    runOrder: [runId],
    runs: {
      [runId]: {
        runId,
        trigger: "user",
        mode: "agent",
        status: "parked",
        input: "continue",
        stepOrder: [stepId],
        steps: {
          [stepId]: {
            stepId,
            status: "completed",
            context: {
              estimatedTokens: 100,
              budgetTokens: 64_000,
              includedBlockIds: [],
              omittedBlockIds: [],
            },
            model: {
              text: wall,
              reasoning: wall,
              finishReason: "length",
            },
          },
        },
        actions: {},
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "parked", reason: "budget", detail: "Model output reached its length boundary" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
  });
  const collapsed = presenter.render(80);
  const transcript = collapsed.join("\n");
  assert.ok(collapsed.length < 40, `expected compact transcript, got ${collapsed.length} lines`);
  assert.match(transcript, /Thinking · Ctrl\+O/);
  assert.match(transcript, /truncated model output · Ctrl\+O/);
  // Handoff may show a one-line preview; the wall of CoT must not appear in full.
  assert.equal((transcript.match(/UNIQUE_THINKING_MARKER/g) ?? []).length, 1);
  assert.doesNotMatch(transcript, /thinking thinking thinking thinking thinking thinking thinking thinking thinking thinking thinking thinking thinking thinking thinking thinking thinking thinking thinking thinking/);
  // Ctrl+O must expand the truncated assistant text, not only the Thinking line.
  assert.equal(presenter.toggleExpand(), "Expanded model output");
  const expanded = presenter.render(80).join("\n");
  assert.doesNotMatch(expanded, /truncated model output · Ctrl\+O/);
  assert.match(expanded, /UNIQUE_THINKING_MARKER/);
  assert.equal(presenter.toggleExpand(), "Collapsed model output");
  assert.match(presenter.render(80).join("\n"), /truncated model output · Ctrl\+O/);
});

test("long response reports preview from the head like Formal Plan, not an 8-line tail", () => {
  const report = [
    "# Offline memo evaluation",
    "",
    "Intro paragraph that must be visible in the collapsed document preview.",
    "",
    ...Array.from({ length: 260 }, (_, index) => `Section line ${index + 1}: ${"detail ".repeat(12)}`),
    "",
    "## Summary",
    "TAIL_ONLY_SUMMARY_MARKER prefer fixing image storage first.",
  ].join("\n");
  assert.ok(report.length > 4_000);
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "long-report",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const stepId = "stp_report";
  const runId = "run_report";
  presenter.update([], {
    sessionId: "ses_report",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "agent",
    runOrder: [runId],
    runs: {
      [runId]: {
        runId,
        trigger: "goal",
        mode: "agent",
        status: "completed",
        input: "enumerate offline memo features",
        stepOrder: [stepId],
        steps: {
          [stepId]: {
            stepId,
            status: "completed",
            context: {
              estimatedTokens: 100,
              budgetTokens: 64_000,
              includedBlockIds: [],
              omittedBlockIds: [],
            },
            model: {
              text: report,
              reasoning: "Draft the evaluation report in the user's language.",
              finishReason: "response",
            },
          },
        },
        actions: {},
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "completed", reason: "response" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
  });
  const collapsed = presenter.render(100).join("\n");
  assert.match(collapsed, /Thinking · Ctrl\+O/);
  assert.match(collapsed, /Intro paragraph that must be visible in the collapsed document preview/);
  assert.match(collapsed, /truncated model output · Ctrl\+O/);
  assert.doesNotMatch(collapsed, /TAIL_ONLY_SUMMARY_MARKER/);
  assert.ok(
    collapsed.split("\n").length > 40,
    "collapsed long-response preview should be document-scale, not an 8-line tail",
  );
  assert.equal(presenter.toggleExpand(), "Expanded model output");
  const expanded = presenter.render(100).join("\n");
  assert.match(expanded, /Intro paragraph that must be visible in the collapsed document preview/);
  assert.match(expanded, /TAIL_ONLY_SUMMARY_MARKER/);
  assert.doesNotMatch(expanded, /truncated model output · Ctrl\+O/);
  assert.equal(presenter.toggleExpand(), "Collapsed model output");
});

test("Ctrl+O expands a rendered-long final response before Thinking", () => {
  const report = [
    "# Middleware setup",
    "",
    ...Array.from({ length: 70 }, (_, index) => `Configuration note ${index + 1}.`),
  ].join("\n");
  assert.ok(report.length < 4_000);
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "rendered-long-response",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const runId = "run_rendered_long";
  const stepId = "stp_rendered_long";
  presenter.update([], {
    sessionId: "ses_rendered_long",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "agent",
    runOrder: [runId],
    runs: {
      [runId]: {
        runId,
        trigger: "user",
        mode: "agent",
        status: "completed",
        input: "set up middleware",
        stepOrder: [stepId],
        steps: {
          [stepId]: {
            stepId,
            status: "completed",
            context: { estimatedTokens: 100, budgetTokens: 64_000, includedBlockIds: [], omittedBlockIds: [] },
            model: { text: report, reasoning: "Think through the setup.", finishReason: "stop" },
          },
        },
        actions: {},
        evaluations: {},
        steering: {},
        delegations: {},
        terminal: { type: "completed", reason: "response" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    presence: { state: "waiting", reason: "idle" },
  });
  const collapsed = presenter.render(80).join("\n");
  assert.match(collapsed, /earlier lines · Ctrl\+O/);
  assert.equal(presenter.toggleExpand(), "Expanded model output");
  const expanded = presenter.render(80).join("\n");
  assert.match(expanded, /Configuration note 1/);
  assert.doesNotMatch(expanded, /earlier lines · Ctrl\+O/);
});

test("live reasoning activity does not render as agent narration in the transcript", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "live-reasoning",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const stepId = "stp_live";
  const runId = "run_live";
  presenter.update([], {
    sessionId: "ses_live",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "agent",
    runOrder: [runId],
    currentRunId: runId,
    runs: {
      [runId]: {
        runId,
        trigger: "user",
        mode: "agent",
        status: "active",
        input: "continue",
        stepOrder: [stepId],
        steps: {
          [stepId]: {
            stepId,
            status: "running",
            context: {
              estimatedTokens: 100,
              budgetTokens: 64_000,
              includedBlockIds: [],
              omittedBlockIds: [],
            },
          },
        },
        actions: {},
        evaluations: {},
        steering: [],
        delegations: {},
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
  });
  presenter.applyActivity({
    type: "model.reasoning",
    sessionId: "ses_live",
    runId,
    stepId,
    text: `LIVE_REASONING_MARKER ${"wall ".repeat(4_000)}`,
    estimatedOutputTokens: 4_000,
    provisional: true,
  });
  const transcript = presenter.render(80).join("\n");
  assert.doesNotMatch(transcript, /LIVE_REASONING_MARKER/);
  assert.doesNotMatch(transcript, /wall wall wall/);
  const working = presenter.renderWorking(true, 0, 80).join("\n");
  assert.match(working, /thinking ·/);
});

test("Working strip grows with live estimatedOutputTokens then uses provider usage", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "live-tokens",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const occurredAt = new Date(0).toISOString();
  const stepId = "stp_live_tok";
  const runId = "run_live_tok";
  const baseView = {
    sessionId: "ses_live_tok",
    createdAt: occurredAt,
    version: 1,
    mode: "agent",
    currentRunId: runId,
    runOrder: [runId],
    runs: {
      [runId]: {
        runId,
        trigger: "user",
        mode: "agent",
        status: "active",
        stepOrder: [stepId],
        steps: {
          [stepId]: {
            stepId,
            status: "running",
            context: { estimatedTokens: 5_900, budgetTokens: 64_000 },
          },
        },
        actions: {},
        evaluations: {},
        steering: [],
        delegations: {},
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "working", reason: "live tokens" },
  };
  presenter.update([], baseView);
  assert.match(presenter.renderWorking(true, 0).join("\n"), /5\.90k tokens/);

  presenter.applyActivity({
    type: "model.reasoning",
    sessionId: "ses_live_tok",
    runId,
    stepId,
    text: "thinking…",
    estimatedOutputTokens: 400,
    provisional: true,
  });
  assert.match(presenter.renderWorking(true, 0).join("\n"), /6\.30k tokens/);

  presenter.update([], {
    ...baseView,
    runs: {
      [runId]: {
        ...baseView.runs[runId],
        steps: {
          [stepId]: {
            stepId,
            status: "running",
            context: { estimatedTokens: 5_900, budgetTokens: 64_000 },
            model: {
              text: "ok",
              usage: { inputTokens: 6_000, outputTokens: 500 },
            },
          },
        },
      },
    },
  });
  // update() clears model activity once step.model is present.
  assert.match(presenter.renderWorking(true, 0).join("\n"), /6\.50k tokens/);
});

test("line-mode panel snapshots append after the transcript without interleaving", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "inspect-order",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const actor = { kind: "runtime", id: "t" };
  const completedRun = (runId, input, text) => ({
    runId,
    trigger: "user",
    mode: "agent",
    status: "completed",
    input,
    stepOrder: [`stp_${runId}`],
    steps: {
      [`stp_${runId}`]: {
        stepId: `stp_${runId}`,
        status: "completed",
        model: { text, finishReason: "stop", requestId: "r", provider: "fake", model: "m" },
      },
    },
    actions: {},
    evaluations: {},
    steering: [],
    delegations: {},
    terminal: { type: "completed", reason: "response" },
  });

  presenter.update(
    [
      { schemaVersion: 1, eventId: "evt_1", sessionId: "ses_order", sequence: 1, occurredAt: "2026-07-23T00:00:00.000Z", actor, type: "session.created", data: { mode: "agent" } },
      { schemaVersion: 1, eventId: "evt_2", sessionId: "ses_order", sequence: 2, occurredAt: "2026-07-23T00:00:01.000Z", actor: { kind: "user", id: "u" }, type: "run.triggered", data: { runId: "run_a", trigger: "user", mode: "agent", input: "first question" } },
      { schemaVersion: 1, eventId: "evt_3", sessionId: "ses_order", sequence: 3, occurredAt: "2026-07-23T00:00:02.000Z", actor, type: "run.started", data: { runId: "run_a" } },
      { schemaVersion: 1, eventId: "evt_4", sessionId: "ses_order", sequence: 4, occurredAt: "2026-07-23T00:00:03.000Z", actor, type: "run.completed", data: { runId: "run_a", completionKind: "response", evaluationIds: [] } },
      { schemaVersion: 1, eventId: "evt_5", sessionId: "ses_order", sequence: 5, occurredAt: "2026-07-23T00:00:04.000Z", actor: { kind: "user", id: "u" }, type: "run.triggered", data: { runId: "run_b", trigger: "user", mode: "agent", input: "second question" } },
      { schemaVersion: 1, eventId: "evt_6", sessionId: "ses_order", sequence: 6, occurredAt: "2026-07-23T00:00:05.000Z", actor, type: "run.started", data: { runId: "run_b" } },
      { schemaVersion: 1, eventId: "evt_7", sessionId: "ses_order", sequence: 7, occurredAt: "2026-07-23T00:00:06.000Z", actor, type: "run.completed", data: { runId: "run_b", completionKind: "response", evaluationIds: [] } },
    ],
    {
      sessionId: "ses_order",
      createdAt: "2026-07-23T00:00:00.000Z",
      version: 7,
      mode: "agent",
      runOrder: ["run_a", "run_b"],
      currentRunId: "run_b",
      runs: {
        run_a: completedRun("run_a", "first question", "first answer"),
        run_b: completedRun("run_b", "second question", "second answer"),
      },
      goals: {},
      goalOrder: [],
      evidence: {},
      controlReceipts: {},
      memories: {},
      memoryOrder: [],
      tasks: {},
      taskOrder: [],
      plans: {},
      planOrder: [],
      presence: { state: "sleeping", reason: "idle" },
    },
  );
  presenter.pushInspection("config");
  const rendered = presenter.render(100).join("\n");
  const first = rendered.indexOf("⟦user⟧first question");
  const second = rendered.indexOf("⟦user⟧second question");
  const config = rendered.indexOf("/config");
  assert.ok(first >= 0 && second >= 0 && config >= 0);
  assert.ok(first < second, "Runs stay chronological");
  assert.ok(second < config, "line-mode panel snapshot trails the transcript");
  assert.match(rendered, /Effective configuration/);
  assert.doesNotMatch(rendered, /[╭╰]/);
});

test("follow-ups panel renders queued items and edit hints", () => {
  const queue = new FollowUpQueue();
  queue.enqueue("first follow-up");
  queue.enqueue("second follow-up");
  const panel = new FollowUpsComponent(queue, () => "en");
  const browse = panel.render(80).join("\n");
  assert.match(browse, /follow-ups/);
  assert.match(browse, /first follow-up/);
  assert.match(browse, /second follow-up/);
  assert.match(browse, /● /); // latest enqueue is selected
  assert.match(browse, /enter send now/);
  assert.match(browse, /d delete/);
  assert.match(browse, /esc clear selection/);
  queue.beginEdit();
  const editing = panel.render(80).join("\n");
  assert.match(editing, /editing · enter save/);
  assert.match(editing, /›/);
});

test("statusline keeps mode on narrow terminals", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/very/long/path/to/workspace/project",
    dataRoot: "/very/long/path/to/workspace/project/.qi",
    provider: "fake",
    model: "very-long-model-name-v1",
    capabilities: ["write", "host execute", "network"],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  presenter.update([], {
    sessionId: "ses_narrow",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "plan",
    runOrder: [],
    currentRunId: undefined,
    runs: {},
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "sleeping", reason: "idle" },
  });
  const narrow = presenter.formatStatusline(false, 36).join("\n");
  assert.match(narrow, /Plan/);
});

test("statusline shows thinking effort between model and context percent", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
    capabilities: [],
    contextWindowTokens: 1_048_576,
    contextBudgetTokens: 983_040,
    outputReserveTokens: 65_536,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  presenter.update([], {
    sessionId: "ses_effort",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "agent",
    runOrder: ["run_1"],
    currentRunId: "run_1",
    runs: {
      run_1: {
        runId: "run_1",
        trigger: "user",
        mode: "agent",
        status: "active",
        input: "hello",
        stepOrder: ["step_1"],
        steps: {
          step_1: {
            stepId: "step_1",
            status: "running",
            context: { estimatedTokens: 31_457, budgetTokens: 983_040 },
            model: {
              requestId: "req_1",
              provider: "deepseek",
              model: "deepseek-v4-flash",
              finishReason: "stop",
              text: "ok",
              usage: { inputTokens: 10_000, outputTokens: 40, cachedInputTokens: 9_870 },
            },
          },
        },
        actions: {},
        delegations: {},
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "active", reason: "run" },
  });
  const status = presenter.formatStatusline(true, 120).join("\n");
  // Statusline CH% is Run-cumulative (same as a single completed Step here).
  assert.match(status, /deepseek\/deepseek-v4-flash · high · 3% · CH98\.7%/);
  assert.match(status, /Agent/);

  presenter.patchAuthLaunch({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningEffort: "max",
    wireApi: "responses",
    authStatus: "ready",
  });
  assert.match(
    presenter.formatStatusline(true, 120).join("\n"),
    /deepseek\/deepseek-v4-flash · responses · max · 3% · CH98\.7%/,
  );

  presenter.patchAuthLaunch({
    provider: "qianwenai",
    model: "glm-5-2",
    reasoningEffort: "high",
    wireApi: "chat.completions",
    authStatus: "ready",
  });
  assert.match(
    presenter.formatStatusline(true, 120).join("\n"),
    /qianwenai\/glm-5-2 · chat\.completions · high · 3%/,
  );

  presenter.patchAuthLaunch({
    provider: "openai",
    model: "gpt-5",
    wireApi: "responses",
    authStatus: "ready",
  });
  assert.doesNotMatch(presenter.formatStatusline(true, 120).join("\n"), /\b(high|max|low|none)\b/);
});

test("statusline CH% is Run-cumulative so a final Step miss does not hide the loop hit rate", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
    capabilities: [],
    contextWindowTokens: 1_048_576,
    contextBudgetTokens: 983_040,
    outputReserveTokens: 65_536,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  presenter.update([], {
    sessionId: "ses_cache_cum",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "agent",
    runOrder: ["run_1"],
    currentRunId: "run_1",
    runs: {
      run_1: {
        runId: "run_1",
        trigger: "user",
        mode: "agent",
        status: "completed",
        input: "hello",
        stepOrder: ["step_1", "step_2"],
        steps: {
          step_1: {
            stepId: "step_1",
            status: "completed",
            finishReason: "actions",
            context: { estimatedTokens: 31_457, budgetTokens: 983_040 },
            model: {
              requestId: "req_1",
              provider: "deepseek",
              model: "deepseek-v4-flash",
              finishReason: "actions",
              text: "ok",
              usage: { inputTokens: 10_000, outputTokens: 40, cachedInputTokens: 9_870 },
            },
          },
          step_2: {
            stepId: "step_2",
            status: "completed",
            finishReason: "response",
            context: { estimatedTokens: 40_000, budgetTokens: 983_040 },
            model: {
              requestId: "req_2",
              provider: "deepseek",
              model: "deepseek-v4-flash",
              finishReason: "stop",
              text: "done",
              usage: { inputTokens: 10_000, outputTokens: 20, cachedInputTokens: 780 },
            },
          },
        },
        actions: {},
        delegations: {},
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "idle", reason: "completed" },
  });
  // Latest Step alone would be CH7.8%; cumulative is (9870+780)/20000 = 53.3%.
  assert.match(presenter.formatStatusline(false, 120).join("\n"), /CH53\.3%/);
  assert.doesNotMatch(presenter.formatStatusline(false, 120).join("\n"), /CH7\.8%/);
});

test("renderPanel exposes config for temporary panels", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "panel-v1",
    capabilities: ["write"],
    disabledCapabilities: ["verify", "network", "execute", "background", "delegate"],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const lines = presenter.renderPanel("config").join("\n");
  assert.match(lines, /Effective configuration/);
  assert.match(lines, /fake\/panel-v1/);
  const welcome = presenter.renderWelcome(80).join("\n");
  assert.match(welcome, /QI|栖/);
  assert.match(welcome, /Permissions enabled:  read, write/);
  assert.match(welcome, /Permissions disabled: verify, network, execute, background, delegate/);
});

test("context panel shows ContextBlock kind shares, counts, and omitted tokens", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "context-v1",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  presenter.update([
    {
      type: "action.proposed",
      data: { runId: "run_context", stepId: "stp_context", actionId: "act_skill", input: { operation: "load", name: "review-code" } },
    },
    {
      type: "action.completed",
      data: {
        runId: "run_context",
        stepId: "stp_context",
        actionId: "act_skill",
        modelOutput: [{
          type: "text",
          text: JSON.stringify({ name: "review-code", scope: "user", instructions: "hidden" }),
        }],
      },
    },
  ], {
    sessionId: "ses_context",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "agent",
    currentRunId: "run_context",
    runOrder: ["run_context"],
    runs: {
      run_context: {
        runId: "run_context",
        trigger: "user",
        mode: "agent",
        status: "completed",
        input: "qqq",
        stepOrder: ["stp_context"],
        steps: {
          stp_context: {
            stepId: "stp_context",
            status: "completed",
            context: {
              estimatedTokens: 10_000,
              budgetTokens: 64_000,
              includedBlockIds: ["constitution", "memory:1", "tool-catalog", "conversation:0", "skill:active:user:review-code:0123456789abcdef"],
              omittedBlockIds: ["memory:2", "skills:catalog"],
              blockStats: [
                {
                  kind: "constitution",
                  includedCount: 1,
                  includedEstimatedTokens: 4_800,
                  omittedCount: 0,
                  omittedEstimatedTokens: 0,
                },
                {
                  kind: "memory",
                  includedCount: 1,
                  includedEstimatedTokens: 1_200,
                  omittedCount: 1,
                  omittedEstimatedTokens: 800,
                },
                {
                  kind: "skill",
                  includedCount: 0,
                  includedEstimatedTokens: 0,
                  omittedCount: 1,
                  omittedEstimatedTokens: 2_000,
                },
              ],
            },
            model: { text: "done", finishReason: "stop" },
          },
        },
        actions: {
          act_skill: {
            actionId: "act_skill",
            stepId: "stp_context",
            toolName: "skill",
            effect: "read",
            status: "completed",
            resources: ["skill:review-code"],
          },
        },
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "completed", reason: "response" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "waiting", reason: "idle" },
  });

  const lines = presenter.renderPanel("context").join("\n");
  assert.match(lines, /block mix\s+2 included · 2 omitted · 6\.00k included tokens/);
  assert.match(lines, /constitution\s+4\.80k ·\s+80% · 1 in \/ 0 out/);
  assert.match(lines, /memory\s+1\.20k ·\s+20% · 1 in \/ 1 out · 800 omitted/);
  assert.match(lines, /skill\s+0 ·\s+0% · 0 in \/ 1 out · 2\.00k omitted/);
  assert.match(lines, /non-block\s+4\.00k · conversation messages \+ advertised Tool schemas/);
  assert.match(lines, /candidates\s+8\.80k ContextBlock tokens before omission/);
  const chat = presenter.renderChat().join("\n");
  assert.match(chat, /⟦user⟧Skill · review-code · user/);
  assert.match(chat, /⟦user⟧Skill tool · load · review-code · completed/);
  assert.match(chat, /⟦user⟧qqq/);
  assert.doesNotMatch(chat, /hidden/);
});

test("/skills exposes always-on catalog, activation management, and installation", () => {
  const pushed = [];
  let applied;
  let notice;
  const ctx = {
    panels: {
      depth: 0,
      push(panel) { pushed.push(panel); },
      closeAll() {},
      dismiss() { pushed.pop(); },
    },
    presenter: {
      setNotice(message) { notice = message; },
    },
    locale: () => "zh",
    terminalRows: 40,
    discoveredSkills: () => [
      {
        name: "prompting-guide",
        version: "unversioned",
        description: "Prompt migration",
        scope: "workspace",
        origin: "qi",
      },
      {
        name: "global-review",
        version: "1.0.0",
        description: "Review code",
        scope: "user",
        origin: "agent",
      },
    ],
    skillCandidates: () => [{
      name: "future-skill",
      version: "unversioned",
      description: "Future workflow",
      root: "C:\\skills\\future-skill",
      source: "global-agent",
    }],
    saveAgentSkillActivation(names) { applied = [...names]; },
    render() {},
  };

  openSkillsHubPanel(ctx);
  const hub = pushed[0];
  const hubText = hub.render(100).join("\n");
  assert.match(hubText, /始终启用的 Skill/);
  assert.match(hubText, /1 个 · Workspace \/ 用户 Qi · 无需开关/);
  assert.match(hubText, /启用 \/ 停用全局 Skill/);
  assert.match(hubText, /安装技能/);
  assert.doesNotMatch(hubText, /prompting-guide|global-review|future-skill/);

  hub.handleInput("\r");
  const alwaysOn = pushed[1];
  const alwaysOnText = alwaysOn.render(100).join("\n");
  assert.match(alwaysOnText, /始终启用的 Skill/);
  assert.match(alwaysOnText, /prompting-guide/);
  assert.match(alwaysOnText, /workspace · qi · unversioned/);
  assert.doesNotMatch(alwaysOnText, /global-review|future-skill/);
  alwaysOn.handleInput("\r");
  assert.equal(notice, "使用 /skill:prompting-guide <task> 调用该 Skill");

  openSkillsHubPanel(ctx);
  const hubAgain = pushed.at(-1);
  hubAgain.handleInput("\u001b[B"); // down to activation
  hubAgain.handleInput("\r");
  const activation = pushed.at(-1);
  assert.match(activation.render(100).join("\n"), /Space 启用\/停用/);
  activation.handleInput(" ");
  activation.handleInput("\r");
  assert.deepEqual(applied, []);
});

test("info notices expire while Run notices remain until explicitly cleared", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "notice-v1",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  presenter.setNotice("Switched to xai/grok-4.5", "info", 1_000);
  presenter.clearRunNotice();
  assert.equal(presenter.notice(4_999), "Switched to xai/grok-4.5");
  assert.equal(presenter.notice(5_000), undefined);
  presenter.setNotice("Run parked: indeterminate effect", "run", 1_000);
  assert.equal(presenter.notice(Number.MAX_SAFE_INTEGER), "Run parked: indeterminate effect");
  presenter.clearRunNotice();
  assert.equal(presenter.notice(), undefined);
});

test("long pasted user input collapses until Ctrl+O expands it", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "paste-v1",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const pasted = Array.from({ length: 8 }, (_, index) => `line ${index + 1} of a long paste`).join("\n");
  presenter.update([], {
    sessionId: "ses_paste",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "agent",
    runOrder: ["run_1"],
    currentRunId: "run_1",
    runs: {
      run_1: {
        runId: "run_1",
        trigger: "user",
        mode: "agent",
        status: "completed",
        input: pasted,
        stepOrder: [],
        steps: {},
        actions: {},
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "completed", reason: "response" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "waiting", reason: "idle" },
  });
  const collapsed = presenter.render().join("\n");
  assert.match(collapsed, /\[Pasted text · 8 lines · \d+ chars\]/);
  assert.doesNotMatch(collapsed, /line 4 of a long paste/);
  assert.match(presenter.toggleExpand(), /Expanded pasted input/);
  const expanded = presenter.render().join("\n");
  assert.match(expanded, /line 4 of a long paste/);
});

test("accepted Formal Plan preview caps at 200 rendered lines and points to the immutable file", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/data",
    provider: "fake",
    model: "plan-preview-v1",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const markdown = [
    "# Long Formal Plan",
    "",
    "A complete plan passed to the Executor.",
    "",
    ...Array.from({ length: 240 }, (_, index) => `${index + 1}. Implement bounded step ${index + 1}.`),
  ].join("\n");
  const path = "C:\\Users\\tester\\.qi\\projects\\demo\\plans\\pln_long\\sha.md";
  presenter.update([], {
    sessionId: "ses_formal_preview",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "agent",
    currentPlanId: "pln_long",
    runOrder: ["run_formal"],
    currentRunId: "run_formal",
    runs: {
      run_formal: {
        runId: "run_formal",
        trigger: "user",
        mode: "agent",
        status: "triggered",
        input: `<accepted-plan>${markdown}</accepted-plan>`,
        planBinding: { planId: "pln_long", revision: 1 },
        stepOrder: [],
        steps: {},
        actions: {},
        evaluations: {},
        steering: [],
        delegations: {},
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {
      pln_long: {
        planId: "pln_long",
        latestRevision: 1,
        acceptedRevision: 1,
        revisions: {
          1: {
            revision: 1,
            format: "formal_markdown",
            title: "Long Formal Plan",
            overview: "A complete plan passed to the Executor.",
            artifactRef: "art_plan",
            sha256: "a".repeat(64),
            path,
            markdown,
            items: [],
            recordedAt: new Date(0).toISOString(),
          },
        },
      },
    },
    planOrder: ["pln_long"],
    presence: { state: "waiting", reason: "accepted" },
  });

  const rendered = presenter.render(100).join("\n");
  assert.match(rendered, /Accepted Plan · Long Formal Plan · rev 1/);
  assert.match(rendered, /1\. Implement bounded step 1/);
  assert.doesNotMatch(rendered, /240\. Implement bounded step 240/);
  assert.match(rendered, /Collapsed · \d+ rendered lines hidden/);
  assert.match(rendered, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(rendered, /\[Pasted text|<accepted-plan|Ctrl\+O/);
});

test("background ProcessTasks remain visible after their Run and can be stopped explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-task-"));
  const taskSecret = "sk-abcdefghijklmnopqrstuvwxyz012345";
  const activities = [];
  const model = new ScriptedModelPort([
    [
      {
        type: "action.requested",
        callId: "call_server",
        name: "task",
        input: {
          command: process.execPath,
          args: ["-e", `process.on('SIGTERM',()=>{}); console.log('token ${taskSecret}'); setInterval(() => console.log('tick'), 100)`],
          lifetimeMs: 10_000,
        },
      },
      { type: "completed", finishReason: "actions" },
    ],
    [{ type: "text.delta", delta: "Server started." }, { type: "completed", finishReason: "stop" }],
  ]);
  const runtime = await TuiRuntime.create({
    workspaceRoot: root,
    dataRoot: join(root, ".qi"),
    modelPort: model,
    model: { provider: "fake", model: "task-v1" },
    allowBackground: true,
    onActivity: (activity) => activities.push(activity),
  });
  try {
    const result = await runtime.run("Start the development server in the background.");
    assert.equal(result.status, "completed");
    const [task] = runtime.tasks();
    assert.equal(task?.status, "running");
    assert.equal(task?.command, process.execPath);
    await waitUntil(() => activities.some((activity) => activity.type === "task.output"));
    assert.doesNotMatch(JSON.stringify(activities), new RegExp(taskSecret));
    const taskLog = join(
      projectSessionPaths(projectPaths({ workspaceRoot: root, dataRoot: join(root, ".qi") }), runtime.sessionId).tasksRoot,
      `${task.taskId}.log`,
    );
    await waitUntil(async () => {
      try { return (await readFile(taskLog, "utf8")).includes("REDACTED"); }
      catch { return false; }
    });
    assert.doesNotMatch(await readFile(taskLog, "utf8"), new RegExp(taskSecret));

    const presenter = new TuiPresenter({
      workspaceRoot: root,
      dataRoot: join(root, ".qi"),
      provider: "fake",
      model: "task-v1",
      capabilities: ["background tasks"],
      contextWindowTokens: 128_000,
      contextBudgetTokens: 112_000,
      outputReserveTokens: 16_000,
      historyBudgetTokens: 16_000,
      maxSteps: 20,
      maxActionsPerStep: 6,
    });
    presenter.update(runtime.events(), runtime.view());
    presenter.pushInspection("jobs");
    const jobsView = presenter.render().join("\n");
    assert.match(jobsView, /Jobs 1/);
    assert.match(jobsView, /\/jobs → Enter · \/jobs stop tsk_/);
    assert.match(presenter.formatStatusline(false, 120).join("\n"), /jobs 1/);

    await runtime.stopTask(task.taskId);
    await waitUntil(() => runtime.tasks()[0]?.status === "exited");
    assert.equal(runtime.tasks()[0]?.terminalReason, "stopped");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("/jobs Enter stops the selected running Job while terminal Jobs stay disabled", () => {
  let panel;
  let closed = false;
  let stoppedTaskId;
  const startedAt = new Date(0).toISOString();
  const base = {
    runId: "run_jobs_panel",
    stepId: "stp_jobs_panel",
    actionId: "act_jobs_panel",
    command: "npm",
    args: ["run", "dev"],
    workdir: "web",
    pid: 4317,
    startedAt,
    expiresAt: "2099-01-01T00:00:00.000Z",
    logRef: "task-log:test",
  };
  openJobsHubPanel({
    locale: () => "en",
    terminalRows: 40,
    presenter: { setNotice: () => {} },
    panels: {
      push: (candidate) => { panel = candidate; },
      closeAll: () => { closed = true; },
      dismiss: () => {},
    },
    listTasks: () => [
      { ...base, taskId: "tsk_running", status: "running" },
      { ...base, taskId: "tsk_exited", status: "exited", terminalReason: "stopped", exitCode: 0 },
    ],
    stopTask: (taskId) => { stoppedTaskId = taskId; },
    render: () => {},
  });

  assert.ok(panel);
  const rendered = stripVTControlCharacters(panel.render(100).join("\n"));
  assert.match(rendered, /Enter stop running Job/);
  assert.match(rendered, /● npm run dev/);
  assert.match(rendered, /○ npm run dev/);

  panel.handleInput("\u001b[B");
  panel.handleInput("\r");
  assert.equal(stoppedTaskId, undefined, "terminal Job must remain disabled");
  panel.handleInput("\u001b[A");
  panel.handleInput("\r");
  assert.equal(stoppedTaskId, "tsk_running");
  assert.equal(closed, true);
});

test("Action settlement glyphs stay distinct and plan_document has its own card", () => {
  assert.equal(statusGlyph("completed"), "✓");
  assert.equal(statusGlyph("failed"), "!");
  assert.equal(statusGlyph("denied"), "⊘");
  assert.equal(statusGlyph("indeterminate"), "?");
  assert.equal(statusGlyph("cancelled"), "×");
  assert.equal(statusGlyph("running"), "●");
  const card = renderToolCard({
    actionId: "act_plan",
    toolName: "plan_document",
    status: "completed",
    input: {
      title: "Ship feature",
      overview: "Explore then implement.",
      items: [{ title: "Inspect" }, { title: "Implement" }],
    },
    output: { planId: "pln_1", revision: 2, path: "/tmp/plans/pln_1.md", artifactRef: "art_1", itemCount: 2 },
  }, { expanded: true });
  const text = card.join("\n");
  assert.match(text, /plan_document/);
  assert.match(text, /Ship feature/);
  assert.match(text, /rev 2/);
  assert.match(text, /• Inspect/);
  assert.doesNotMatch(text, /│/);

  const failed = renderToolCard({
    actionId: "act_plan_failed",
    toolName: "plan_document",
    status: "failed",
    input: {
      operation: "create",
      markdown: "# Formal title\n\nComplete plan.",
      planId: "pln_model_supplied",
    },
    output: {
      code: "PLAN_OPERATION_FIELDS",
      message: "create does not accept: planId",
    },
    errorCode: "PLAN_OPERATION_FIELDS",
  }, { expanded: true }).join("\n");
  assert.match(failed, /Formal title/);
  assert.match(failed, /create · PLAN_OPERATION_FIELDS/);
  assert.match(failed, /create does not accept: planId/);
  assert.doesNotMatch(failed, /rev undefined/);
});

test("completed ask_question cards retain every option and confirmed answer", () => {
  const card = renderToolCard({
    actionId: "act_questions",
    toolName: "ask_question",
    status: "completed",
    input: {
      questions: [
        {
          id: "style",
          header: "Style",
          prompt: "Choose the writing style",
          selection: "single",
          options: [
            { id: "classic", label: "Classic", description: "Traditional narration" },
            { id: "gulong", label: "Gu Long", description: "Concise and suspenseful" },
          ],
          allowText: true,
        },
        {
          id: "themes",
          header: "Themes",
          prompt: "Choose one or more themes",
          selection: "multiple",
          options: [
            { id: "mystery", label: "Mystery" },
            { id: "honor", label: "Honor" },
            { id: "romance", label: "Romance" },
          ],
          allowText: true,
        },
        {
          id: "detail",
          header: "Detail",
          prompt: "Add a required detail",
          selection: "text",
          options: [],
          allowText: true,
        },
      ],
    },
    output: {
      answers: [
        { questionId: "style", selectedOptionIds: ["gulong"], skipped: false },
        {
          questionId: "themes",
          selectedOptionIds: ["mystery", "honor"],
          text: "A colder ending",
          skipped: false,
        },
        { questionId: "detail", selectedOptionIds: [], text: "Open on a rainy night", skipped: false },
      ],
    },
  }, { expanded: true }).join("\n");

  assert.match(card, /3 questions · 3 answered/);
  assert.match(card, /Choose the writing style/);
  assert.match(card, /○ Classic/);
  assert.match(card, /● Gu Long/);
  assert.match(card, /☑ Mystery/);
  assert.match(card, /☑ Honor/);
  assert.match(card, /☐ Romance/);
  assert.match(card, /✓ Other: A colder ending/);
  assert.match(card, /✓ Answer: Open on a rainy night/);

  const skipped = renderToolCard({
    actionId: "act_skipped_question",
    toolName: "ask_question",
    status: "completed",
    input: {
      questions: [{
        id: "optional",
        header: "Optional",
        prompt: "Choose or skip",
        selection: "single",
        options: [{ id: "yes", label: "Yes" }],
        allowText: true,
      }],
    },
    output: {
      answers: [{ questionId: "optional", selectedOptionIds: [], skipped: true }],
    },
  }).join("\n");
  assert.match(skipped, /1 question · 0 answered · 1 skipped/);
  assert.match(skipped, /○ Yes/);
  assert.match(skipped, /↷ Skipped/);
});

test("confirmed ask_question cards stay expanded while a Plan Run continues", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "questions-v1",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const actor = { kind: "runtime", id: "test" };
  const input = {
    questions: [{
      id: "style",
      header: "Style",
      prompt: "Choose the style",
      selection: "single",
      options: [{ id: "classic", label: "Classic" }, { id: "gulong", label: "Gu Long" }],
      allowText: true,
    }],
  };
  const output = {
    answers: [{ questionId: "style", selectedOptionIds: [], text: "More experimental", skipped: false }],
  };
  presenter.update([
    {
      type: "action.proposed",
      sequence: 1,
      occurredAt: new Date(0).toISOString(),
      actor,
      data: {
        runId: "run_questions",
        stepId: "stp_questions",
        actionId: "act_questions",
        toolName: "ask_question",
        effect: "read",
        input,
        resources: ["run-question:user"],
      },
    },
    {
      type: "action.started",
      sequence: 2,
      occurredAt: new Date(0).toISOString(),
      actor,
      data: {
        runId: "run_questions",
        stepId: "stp_questions",
        actionId: "act_questions",
        leaseId: "lease_questions",
      },
    },
    {
      type: "action.completed",
      sequence: 3,
      occurredAt: new Date(0).toISOString(),
      actor,
      data: {
        runId: "run_questions",
        stepId: "stp_questions",
        actionId: "act_questions",
        modelOutput: [{ type: "text", text: JSON.stringify(output) }],
      },
    },
  ], {
    sessionId: "ses_questions",
    createdAt: new Date(0).toISOString(),
    version: 1,
    mode: "plan",
    runOrder: ["run_questions"],
    currentRunId: "run_questions",
    runs: {
      run_questions: {
        runId: "run_questions",
        trigger: "user",
        mode: "plan",
        status: "active",
        input: "Plan the work",
        stepOrder: ["stp_questions", "stp_continuing"],
        steps: {
          stp_questions: {
            stepId: "stp_questions",
            status: "completed",
            model: { text: "I need one clarification.", finishReason: "actions" },
          },
          stp_continuing: {
            stepId: "stp_continuing",
            status: "running",
          },
        },
        actions: {
          act_questions: {
            actionId: "act_questions",
            stepId: "stp_questions",
            toolName: "ask_question",
            effect: "read",
            status: "completed",
            resources: ["run-question:user"],
          },
        },
        evaluations: {},
        steering: [],
        delegations: {},
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "busy", reason: "running" },
  });

  const rendered = presenter.render(100).join("\n");
  assert.match(rendered, /Choose the style/);
  assert.match(rendered, /○ Classic/);
  assert.match(rendered, /○ Gu Long/);
  assert.match(rendered, /✓ Other: More experimental/);
});

test("pending Next Run handoff points at the choice panel, not composer digits", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "next-v1",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const occurredAt = new Date(0).toISOString();
  presenter.update([], {
    sessionId: "ses_next",
    createdAt: occurredAt,
    version: 1,
    mode: "agent",
    currentPlanId: "pln_1",
    pendingQuestion: {
      questionId: "q_next_1",
      kind: "next_run",
      status: "pending",
      prompt: "Start the next Plan item: Implement?",
      choices: [
        { id: "continue", label: "Continue" },
        { id: "stop", label: "Stop" },
        { id: "return_to_plan", label: "Return to Plan" },
      ],
      planId: "pln_1",
      revision: 1,
      completedRunId: "run_1",
      nextPlanItemId: "pit_b",
    },
    runOrder: ["run_1"],
    currentRunId: "run_1",
    runs: {
      run_1: {
        runId: "run_1",
        trigger: "user",
        mode: "agent",
        status: "completed",
        input: "do item",
        planBinding: {
          planId: "pln_1",
          revision: 1,
          planItemId: "pit_a",
        },
        stepOrder: ["stp_1"],
        steps: {
          stp_1: {
            stepId: "stp_1",
            status: "completed",
            finishReason: "response",
            model: {
              requestId: "req_1",
              provider: "fake",
              model: "next-v1",
              finishReason: "stop",
              text: "Item done.",
            },
          },
        },
        actions: {},
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "completed", reason: "response" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {
      pln_1: {
        planId: "pln_1",
        latestRevision: 1,
        acceptedRevision: 1,
        revisions: {
          1: {
            revision: 1,
            title: "Demo",
            overview: "Overview",
            artifactRef: "artifact://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            path: "/tmp/plans/pln_1.md",
            items: [
              { planItemId: "pit_a", title: "Inspect", description: "d1", dependsOn: [] },
              { planItemId: "pit_b", title: "Implement", description: "d2", dependsOn: [] },
            ],
          },
        },
      },
    },
    planOrder: ["pln_1"],
    presence: { state: "waiting", reason: "Awaiting next-Run answer" },
  });
  const rendered = presenter.render().join("\n");
  assert.match(rendered, /Next Run pending/);
  assert.match(rendered, /↑↓ \/ Enter in the choice panel/);
  assert.match(rendered, /stop 后可用 \/next/);
  assert.doesNotMatch(rendered, /1 \/next continue/);
  assert.doesNotMatch(rendered, /── Handoff ──/);
});

test("unadvertised write-tool failure guides to /permissions", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "edit-v1",
    language: "en",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const occurredAt = new Date(0).toISOString();
  const actor = { kind: "runtime", id: "t" };
  const diagnostic = `diagnostic:inline:${encodeURIComponent("Error: Model requested unadvertised tool edit")}`;
  presenter.update([
    {
      type: "session.created",
      sessionId: "ses_edit",
      sequence: 1,
      occurredAt,
      actor,
      data: { workspaceRoot: "/tmp/ws", createdAt: occurredAt },
    },
    {
      type: "run.triggered",
      sessionId: "ses_edit",
      sequence: 2,
      occurredAt,
      actor,
      data: { runId: "run_1", trigger: "user", mode: "agent", input: "edit the file" },
    },
    {
      type: "run.failed",
      sessionId: "ses_edit",
      sequence: 3,
      occurredAt,
      actor,
      data: { runId: "run_1", code: "INVALID_MODEL_ACTION", diagnosticRef: diagnostic },
    },
  ], {
    sessionId: "ses_edit",
    createdAt: occurredAt,
    version: 1,
    mode: "agent",
    runOrder: ["run_1"],
    currentRunId: "run_1",
    runs: {
      run_1: {
        runId: "run_1",
        trigger: "user",
        mode: "agent",
        status: "failed",
        input: "edit the file",
        stepOrder: [],
        steps: {},
        actions: {},
        actionOrder: [],
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "failed", reason: "INVALID_MODEL_ACTION" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "waiting", reason: "Run failed" },
  });
  const rendered = presenter.render().join("\n");
  assert.match(rendered, /INVALID_MODEL_ACTION/);
  assert.match(rendered, /unadvertised tool edit/);
  assert.match(rendered, /\/permissions/);
  assert.match(rendered, /Write/);
  assert.equal(
    presenter.selectedRunFailureGuidance(),
    "Needs Write: enable it with /permissions, then retry",
  );
});

test("parked budget handoff shows reason and continue guidance", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "park-v1",
    capabilities: ["write"],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const occurredAt = new Date(0).toISOString();
  const actor = { kind: "runtime", id: "qi" };
  presenter.update([
    {
      eventId: "evt_1",
      sessionId: "ses_park",
      sequence: 1,
      type: "run.parked",
      occurredAt,
      actor,
      data: { runId: "run_1", reason: "budget", detail: "Reached maxSteps=20" },
    },
  ], {
    sessionId: "ses_park",
    createdAt: occurredAt,
    version: 1,
    mode: "agent",
    runOrder: ["run_1"],
    currentRunId: "run_1",
    runs: {
      run_1: {
        runId: "run_1",
        trigger: "user",
        mode: "agent",
        status: "parked",
        input: "keep going",
        stepOrder: [],
        steps: {},
        actions: {},
        actionOrder: [],
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "parked", reason: "budget", detail: "Reached maxSteps=20" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "waiting", reason: "Run parked" },
  });
  const rendered = presenter.render().join("\n");
  assert.match(rendered, /Status\s+parked|状态\s+已暂停/);
  assert.match(rendered, /budget: Reached maxSteps=20/);
  assert.match(rendered, /Step budget exhausted|Step 预算已用尽/);
  assert.equal(presenter.selectedRunFailureDetail(), "budget: Reached maxSteps=20");
});

test("parked Goal attempts handoff points to /goal Continue", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "park-goal-v1",
    capabilities: ["write"],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const occurredAt = new Date(0).toISOString();
  const actor = { kind: "runtime", id: "qi" };
  presenter.update([
    {
      eventId: "evt_1",
      sessionId: "ses_park_goal",
      sequence: 1,
      type: "run.parked",
      occurredAt,
      actor,
      data: {
        runId: "run_1",
        reason: "budget",
        detail: "attempts budget exhausted at 20/20",
      },
    },
  ], {
    sessionId: "ses_park_goal",
    createdAt: occurredAt,
    version: 1,
    mode: "agent",
    runOrder: ["run_1"],
    currentRunId: "run_1",
    runs: {
      run_1: {
        runId: "run_1",
        trigger: "goal",
        mode: "agent",
        status: "parked",
        input: "continue goal",
        goalBinding: { goalId: "gol_1", contractVersion: 1 },
        stepOrder: [],
        steps: {},
        actions: {},
        actionOrder: [],
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: {
          type: "parked",
          reason: "budget",
          detail: "attempts budget exhausted at 20/20",
        },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "waiting", reason: "Run parked" },
  });
  const rendered = presenter.render().join("\n");
  assert.match(rendered, /Goal attempts exhausted|Goal attempts 已用尽/);
  assert.match(rendered, /\/goal → Continue/);
  assert.doesNotMatch(rendered, /Step budget exhausted|Step 预算已用尽/);
});

test("parked indeterminate handoff surfaces Action evidence and no-retry guidance", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "park-indet-v1",
    capabilities: ["write", "host execute"],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const occurredAt = new Date(0).toISOString();
  const actor = { kind: "runtime", id: "qi" };
  presenter.update([
    {
      eventId: "evt_proposed",
      sessionId: "ses_indet",
      sequence: 1,
      type: "action.proposed",
      occurredAt,
      actor,
      data: {
        runId: "run_1",
        stepId: "stp_1",
        actionId: "act_1",
        toolName: "shell",
        effect: "execute",
        input: {
          command: "pnpm",
          args: ["create", "tauri-app", "desktop"],
          workdir: "apps",
        },
      },
    },
    {
      eventId: "evt_indet",
      sessionId: "ses_indet",
      sequence: 2,
      type: "action.indeterminate",
      occurredAt,
      actor,
      data: {
        runId: "run_1",
        stepId: "stp_1",
        actionId: "act_1",
        reason: "ENOENT: no such file or directory, realpath 'D:\\\\code\\\\qi-ws\\\\qi-notebook\\\\apps'",
        reconciliationHint: "Inspect the Effect Journal before retrying this action",
      },
    },
    {
      eventId: "evt_park",
      sessionId: "ses_indet",
      sequence: 3,
      type: "run.parked",
      occurredAt,
      actor,
      data: {
        runId: "run_1",
        reason: "indeterminate-effect",
        detail: "Tool settlement could not be confirmed",
      },
    },
  ], {
    sessionId: "ses_indet",
    createdAt: occurredAt,
    version: 1,
    mode: "agent",
    runOrder: ["run_1"],
    currentRunId: "run_1",
    runs: {
      run_1: {
        runId: "run_1",
        trigger: "user",
        mode: "agent",
        status: "parked",
        input: "scaffold tauri",
        stepOrder: ["stp_1"],
        steps: {
          stp_1: { stepId: "stp_1", status: "completed", finishReason: "actions" },
        },
        actions: {
          act_1: {
            actionId: "act_1",
            stepId: "stp_1",
            toolName: "shell",
            effect: "execute",
            status: "indeterminate",
            terminalDetail: "ENOENT: no such file or directory, realpath 'D:\\\\code\\\\qi-ws\\\\qi-notebook\\\\apps'",
            resources: ["host-workspace:apps", "shell-profile:direct"],
          },
        },
        actionOrder: ["act_1"],
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: {
          type: "parked",
          reason: "indeterminate-effect",
          detail: "Tool settlement could not be confirmed",
        },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "waiting", reason: "Run parked" },
  });
  const rendered = presenter.render().join("\n");
  assert.match(rendered, /Status\s+parked|状态\s+已暂停/);
  assert.match(rendered, /indeterminate-effect: shell: ENOENT/);
  assert.match(rendered, /realpath/);
  assert.match(rendered, /Do not auto-retry|不要自动重试/);
  assert.match(rendered, /ENOENT: no such file or directory/);
  assert.match(rendered, /Inspect the Effect Journal|Effect Journal/);
  assert.match(
    presenter.selectedRunFailureDetail() ?? "",
    /indeterminate-effect: shell: ENOENT/,
  );
});

test("pending Formal Plan Review shows the complete bounded plan before its choices", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "review-v1",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const occurredAt = new Date(0).toISOString();
  const reviewMarkdown = [
    "# Demo Formal Plan",
    "",
    "The reviewer must see this complete document before deciding.",
    "",
    "## Implementation",
    "",
    "1. Inspect the current behavior.",
    "2. Implement the reviewed change.",
    "3. Verify the result.",
  ].join("\n");
  const reviewPath = "/tmp/plans/pln_1/review.md";
  presenter.update([], {
    sessionId: "ses_review",
    createdAt: occurredAt,
    version: 1,
    mode: "plan",
    currentPlanId: "pln_1",
    pendingReview: { planId: "pln_1", revision: 1, status: "pending" },
    runOrder: ["run_1"],
    currentRunId: "run_1",
    runs: {
      run_1: {
        runId: "run_1",
        trigger: "user",
        mode: "plan",
        status: "completed",
        input: "draft plan",
        stepOrder: ["stp_1"],
        steps: {
          stp_1: {
            stepId: "stp_1",
            status: "completed",
            finishReason: "response",
            model: {
              requestId: "req_1",
              provider: "fake",
              model: "review-v1",
              finishReason: "stop",
              text: "Plan ready for review.",
            },
          },
        },
        actions: {},
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "completed", reason: "response" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {
      pln_1: {
        planId: "pln_1",
        latestRevision: 1,
        revisions: {
          1: {
            revision: 1,
            format: "formal_markdown",
            title: "Demo Formal Plan",
            overview: "The reviewer must see this complete document before deciding.",
            artifactRef: "artifact://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            path: reviewPath,
            markdown: reviewMarkdown,
            items: [],
          },
        },
      },
    },
    planOrder: ["pln_1"],
    presence: { state: "waiting", reason: "Awaiting Plan review" },
  });
  const rendered = presenter.render().join("\n");
  assert.match(rendered, /Formal Plan for Review · Demo Formal Plan · rev 1/);
  assert.match(rendered, /The reviewer must see this complete document before deciding/);
  assert.match(rendered, /1\. Inspect the current behavior/);
  assert.match(rendered, /3\. Verify the result/);
  assert.match(rendered, new RegExp(reviewPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(rendered, /Plan Review pending/);
  assert.match(rendered, /开始实现/);
  assert.ok(rendered.indexOf("Formal Plan for Review") < rendered.indexOf("Plan Review pending"));
  assert.doesNotMatch(rendered, /── Handoff ──/);
  // Todo stays out of the stream until 开始实现 starts a Plan-bound Run.
  assert.doesNotMatch(rendered, /^Todo\s+/m);
});

test("shell cards use compact $ command · duration grammar", () => {
  const collapsed = renderToolCard({
    actionId: "act_shell",
    toolName: "shell",
    status: "completed",
    elapsed: "6.1s",
    input: { command: "git", args: ["status"] },
    output: { exitCode: 0, stdout: "line1\nline2\nline3\nnothing to commit\n" },
  });
  const text = collapsed.join("\n");
  assert.match(text, /\$ git status 6\.1s/);
  assert.doesNotMatch(text, /output lines hidden|line2|line3|nothing to commit/);
  assert.doesNotMatch(text, /^  line1$/m);
  assert.doesNotMatch(text, /cwd /);

  const summary = renderToolCard({
    actionId: "act_shell",
    toolName: "shell",
    status: "completed",
    elapsed: "6.1s",
    input: { command: "git", args: ["status"] },
    output: { exitCode: 0, stdout: "line1\nline2\nline3\nnothing to commit\n" },
  }, { summaryOnly: true });
  assert.match(summary[0] ?? "", /\$ git status 6\.1s/);
  assert.equal(summary.length, 1);
  assert.doesNotMatch(summary.join("\n"), /line2|line3|nothing to commit/);
});

test("failed git cards show full request, error code, and message", () => {
  const invalidRef = renderToolCard({
    actionId: "act_git_ref",
    toolName: "git",
    status: "failed",
    elapsed: "32ms",
    errorCode: "INVALID_GIT_ARGUMENT",
    input: { operation: "status", ref: "HEAD" },
    output: {
      code: "INVALID_GIT_ARGUMENT",
      message: "ref is only valid for rev-parse and show",
      details: { command: "git status · ref HEAD", operation: "status", ref: "HEAD" },
    },
  }).join("\n");
  assert.match(invalidRef, /git status · ref HEAD/);
  assert.match(invalidRef, /INVALID_GIT_ARGUMENT/);
  assert.match(invalidRef, /ref is only valid for rev-parse and show/);

  const invalidCount = renderToolCard({
    actionId: "act_git_count",
    toolName: "git",
    status: "failed",
    elapsed: "18ms",
    errorCode: "INVALID_GIT_ARGUMENT",
    input: { operation: "diff", maxCount: 5 },
    output: {
      code: "INVALID_GIT_ARGUMENT",
      message: "maxCount is only valid for log",
      details: { command: "git diff · maxCount 5", operation: "diff", maxCount: 5 },
    },
  }, { summaryOnly: true }).join("\n");
  assert.match(invalidCount, /git diff · maxCount 5/);
  assert.match(invalidCount, /maxCount is only valid for log/);
});

test("failed shell cards unwrap bounded process evidence from the ToolFailure envelope", () => {
  const model = {
    actionId: "act_shell_failed",
    toolName: "shell",
    status: "failed",
    elapsed: "240ms",
    errorCode: "SHELL_EXIT_NONZERO",
    input: { command: "node", args: ["-e", "bad code"], workdir: "packages/kernel" },
    output: {
      code: "SHELL_EXIT_NONZERO",
      message: "Process exited unsuccessfully",
      details: {
        exitCode: 1,
        timedOut: false,
        stdout: "partial output\n",
        stderr: "SyntaxError: Expected ',', got ';'\n",
        workspaceChange: { changed: true },
      },
    },
  };
  const collapsed = renderToolCard(model).join("\n");
  assert.match(collapsed, /SHELL_EXIT_NONZERO · exit 1/);
  assert.match(collapsed, /SyntaxError: Expected ',', got ';'/);
  assert.doesNotMatch(collapsed, /partial output/);

  const summary = renderToolCard(model, { summaryOnly: true }).join("\n");
  assert.match(summary, /\$ node -e/);
  assert.match(summary, /SyntaxError: Expected ',', got ';'/);
  assert.ok(summary.split("\n").length >= 2);
  assert.ok(summary.split("\n").length <= 4);

  const expanded = renderToolCard(model, { expanded: true }).join("\n");
  assert.match(expanded, /cwd packages\/kernel/);
  assert.match(expanded, /stderr\s+SyntaxError/);
  assert.match(expanded, /stdout\s+partial output/);
  assert.match(expanded, /workspace changed/);
});

test("write/edit cards show Cursor-style Edited header, gutter, and context", () => {
  const shortDiff = [
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,1 +1,2 @@",
    " keep",
    "+added line",
  ].join("\n");
  const shortCard = renderToolCard({
    actionId: "act_w1",
    toolName: "write",
    status: "completed",
    elapsed: "183ms",
    input: { path: "a.ts" },
    output: { path: "a.ts", diff: shortDiff },
  }).join("\n");
  assert.match(shortCard, /Edited a\.ts \+1/);
  assert.match(shortCard, /▎ \+added line/);
  assert.match(shortCard, /▎  keep/);
  assert.doesNotMatch(shortCard, /\(\+1/);
  assert.doesNotMatch(shortCard, /@@/);
  assert.doesNotMatch(shortCard, /^  --- a\//m);
  assert.doesNotMatch(shortCard, /^  \+\+\+ b\//m);
  assert.doesNotMatch(shortCard, /truncated/);

  const longBody = Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`).join("\n");
  const longDiff = ["--- a/pkg/b.ts", "+++ b/pkg/b.ts", "@@ -0,0 +1,40 @@", longBody].join("\n");
  const longCard = renderToolCard({
    actionId: "act_w2",
    toolName: "edit",
    status: "completed",
    input: { path: "pkg/b.ts" },
    output: { path: "pkg/b.ts", diff: longDiff },
    // Shared Action budget is tiny; mutation cards must still keep a Cursor-like context window.
  }, { outputLines: 4 }).join("\n");
  assert.match(longCard, /Edited pkg\/b\.ts \+40/);
  assert.match(longCard, /▎ \+line 1/);
  assert.match(longCard, /truncated \(\d+ more lines\) · Ctrl\+O/);
  assert.match(longCard, /▎ \+line 40/);

  // Leading context must not push the real +/− code lines into the hidden middle.
  const contextHeavy = [
    "--- a/frontend/index.html",
    "+++ b/frontend/index.html",
    "@@ -360,6 +360,9 @@",
    ...Array.from({ length: 20 }, (_, i) => ` context ${i + 1}`),
    "+real added",
    "+second added",
    ...Array.from({ length: 20 }, (_, i) => ` trailing ${i + 1}`),
  ].join("\n");
  const contextCard = renderToolCard({
    actionId: "act_w3",
    toolName: "edit",
    status: "completed",
    input: { path: "frontend/index.html" },
    output: { path: "frontend/index.html", diff: contextHeavy },
  }, { outputLines: 4 }).join("\n");
  assert.match(contextCard, /Edited frontend\/index\.html \+2/);
  assert.match(contextCard, /▎ \+real added/);
  assert.match(contextCard, /▎ \+second added/);
  assert.doesNotMatch(contextCard, /@@/);

  const deepPathCard = renderToolCard({
    actionId: "act_w4",
    toolName: "edit",
    status: "failed",
    errorCode: "EDIT_TARGET_NOT_FOUND",
    elapsed: "81ms",
    input: { path: "apps/desktop/src/components/Sidebar.tsx" },
  }).join("\n");
  assert.match(deepPathCard, /edit\s+apps\/desktop\/src\/components\/Sidebar\.tsx/);
  assert.doesNotMatch(deepPathCard, /edit\s+components\/Sidebar\.tsx/);
});

test("read cards stay header-only and never dump file contents", () => {
  const card = renderToolCard({
    actionId: "act_r1",
    toolName: "read",
    status: "completed",
    elapsed: "12ms",
    input: { path: "src/app.ts" },
    output: { path: "src/app.ts", content: "line one\nline two\nsecret body\n" },
  }).join("\n");
  assert.match(card, /read\s+src\/app\.ts/);
  assert.match(card, /3 lines/);
  assert.doesNotMatch(card, /secret body/);
  assert.doesNotMatch(card, /line one/);
});

test("step timeline shows narration before tools when finishReason is actions", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "chrono-v1",
    capabilities: ["host execute"],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const occurredAt = new Date(0).toISOString();
  const actor = { kind: "runtime", id: "t" };
  presenter.update([
    {
      type: "session.created",
      sessionId: "ses_chrono",
      sequence: 1,
      occurredAt,
      actor,
      data: { workspaceRoot: "/tmp/ws", createdAt: occurredAt },
    },
    {
      type: "run.triggered",
      sessionId: "ses_chrono",
      sequence: 2,
      occurredAt,
      actor,
      data: { runId: "run_1", trigger: "user", mode: "agent", input: "status?" },
    },
    {
      type: "step.started",
      sessionId: "ses_chrono",
      sequence: 3,
      occurredAt,
      actor,
      data: { runId: "run_1", stepId: "stp_1" },
    },
    {
      type: "model.completed",
      sessionId: "ses_chrono",
      sequence: 4,
      occurredAt,
      actor,
      data: {
        runId: "run_1",
        stepId: "stp_1",
        requestId: "req_1",
        provider: "fake",
        model: "chrono-v1",
        finishReason: "actions",
        text: "我先查看一下当前的 git 状态。",
        actionCalls: [{ callId: "call_1", name: "shell", input: { command: "git", args: ["status"] } }],
      },
    },
    {
      type: "action.proposed",
      sessionId: "ses_chrono",
      sequence: 5,
      occurredAt,
      actor,
      data: {
        runId: "run_1",
        stepId: "stp_1",
        actionId: "act_1",
        toolName: "shell",
        effect: "execute",
        input: { command: "git", args: ["status"] },
      },
    },
    {
      type: "action.started",
      sessionId: "ses_chrono",
      sequence: 6,
      occurredAt,
      actor,
      data: { runId: "run_1", stepId: "stp_1", actionId: "act_1" },
    },
    {
      type: "action.completed",
      sessionId: "ses_chrono",
      sequence: 7,
      occurredAt,
      actor,
      data: {
        runId: "run_1",
        stepId: "stp_1",
        actionId: "act_1",
        modelOutput: [{ type: "text", text: JSON.stringify({ exitCode: 0, stdout: "clean\n" }) }],
      },
    },
  ], {
    sessionId: "ses_chrono",
    createdAt: occurredAt,
    version: 1,
    mode: "agent",
    runOrder: ["run_1"],
    currentRunId: "run_1",
    runs: {
      run_1: {
        runId: "run_1",
        trigger: "user",
        mode: "agent",
        status: "completed",
        input: "status?",
        stepOrder: ["stp_1"],
        steps: {
          stp_1: {
            stepId: "stp_1",
            status: "completed",
            finishReason: "action-requested",
            model: {
              requestId: "req_1",
              provider: "fake",
              model: "chrono-v1",
              finishReason: "actions",
              text: "我先查看一下当前的 git 状态。",
            },
          },
        },
        actions: {
          act_1: {
            actionId: "act_1",
            stepId: "stp_1",
            toolName: "shell",
            effect: "execute",
            status: "completed",
            resources: [],
          },
        },
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "completed", reason: "response" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "waiting", reason: "idle" },
  });
  const rendered = presenter.render().join("\n");
  const narrationAt = rendered.indexOf("我先查看一下当前的 git 状态");
  const shellAt = rendered.indexOf("$ git status");
  assert.ok(narrationAt >= 0, "expected narration");
  assert.ok(shellAt >= 0, "expected shell card");
  assert.ok(narrationAt < shellAt, "narration should appear before the tool card");
});

test("ListPanel Enter selects and Esc closes without inventing Session state", () => {
  const selected = [];
  let closed = false;
  const panel = new ListPanel({
    title: "Mode",
    items: [
      { id: "ask", label: "Ask" },
      { id: "plan", label: "Plan" },
      { id: "agent", label: "Agent", current: true },
    ],
    onSelect: (item) => selected.push(item.id),
    onClose: () => { closed = true; },
  });
  const rendered = panel.render(80).join("\n");
  assert.match(rendered, /Mode/);
  assert.match(rendered, /Ask/);
  panel.handleInput("\u001b[B"); // down
  panel.handleInput("\r");
  assert.deepEqual(selected, ["plan"]);
  panel.handleInput("\u001b");
  assert.equal(closed, true);
});

test("History-style ListPanel searches bounded labels and status descriptions", () => {
  let closed = false;
  const panel = new ListPanel({
    title: "History Center",
    searchable: true,
    maxVisible: 5,
    items: [
      { id: "run_ok", label: "Run 1", description: "completed · read" },
      { id: "run_failed", label: "Run 2", description: "failed · shell" },
      { id: "run_denied", label: "Run 3", description: "denied · edit" },
    ],
    onClose: () => { closed = true; },
    onSelect: () => {},
  });
  for (const character of "failed") panel.handleInput(character);
  const filtered = stripVTControlCharacters(panel.render(60).join("\n"));
  assert.match(filtered, /Run 2/);
  assert.doesNotMatch(filtered, /Run 1|Run 3/);
  panel.handleInput("\u001b");
  assert.equal(closed, false, "first Esc clears search");
  assert.match(stripVTControlCharacters(panel.render(60).join("\n")), /Run 1/);
});

test("ListPanel keeps multiline remote metadata on one render row", () => {
  const panel = new ListPanel({
    title: "MCP",
    items: [{
      id: "query-docs",
      label: "tool · query-docs",
      description: "First paragraph\n\nYou MUST call this tool before querying docs.",
    }],
    onSelect: () => {},
    onClose: () => {},
  });
  const lines = panel.render(80);
  assert.ok(lines.every((line) => !line.includes("\n")), "each rendered item must occupy one terminal row");
  const rendered = stripVTControlCharacters(lines.join("\n"));
  assert.match(rendered, /First paragraph You MUST call this tool/);
  assert.equal((rendered.match(/tool · query-docs/g) ?? []).length, 1);
});

test("MCP server capability list stays compact across terminal heights", () => {
  assert.equal(mcpServerMaxVisible(24), 5);
  assert.equal(mcpServerMaxVisible(30), 6);
  assert.equal(mcpServerMaxVisible(40), 7);
  assert.equal(mcpServerMaxVisible(80), 7);
});

test("MCP binding panel drafts multiple effects with arrows and saves once with Enter", () => {
  const actions = [];
  const applied = [];
  let action;
  let closed = false;
  const panel = new McpBindingPanel({
    title: "playwright · MCP",
    locale: "zh",
    actions: [{ id: "refresh", label: "刷新发现", description: "重新读取能力。" }],
    candidates: [
      { id: "close", label: "tool · browser_close", description: "Close", effects: ["read", "execute"], state: "unbound" },
      { id: "snapshot", label: "tool · browser_snapshot", description: "Snapshot", effects: ["read", "execute"], currentEffect: "read", state: "bound" },
    ],
    onAction: (id) => { action = id; },
    onApply: (changes) => { applied.push(...changes); },
    onClose: () => { closed = true; },
  });
  assert.match(stripVTControlCharacters(panel.render(100).join("\n")), /隔离 ← 当前/);
  panel.handleInput("\u001b[C"); // close: unbound -> read
  panel.handleInput("\u001b[B"); // snapshot
  panel.handleInput("\u001b[C"); // snapshot: read -> execute
  panel.handleInput("\r");
  assert.deepEqual(applied, [
    { id: "close", effect: "read" },
    { id: "snapshot", effect: "execute" },
  ]);
  assert.match(stripVTControlCharacters(panel.render(100).join("\n")), /2 项待保存/);
  panel.handleInput("\u001b[A");
  panel.handleInput("\u001b[A"); // refresh action
  panel.handleInput("\r");
  assert.equal(action, "refresh");
  panel.handleInput("\u001b");
  assert.equal(closed, true);
});

test("MCP binding panel collapses multiline remote descriptions to one terminal row", () => {
  const panel = new McpBindingPanel({
    title: "context7@claude-plugins-official · MCP",
    locale: "zh",
    candidates: [{
      id: "query-docs",
      label: "tool · query-docs",
      description: "You MUST call this tool.\nRetrieves up-to-date documentation\nand code examples.",
      effects: ["read"],
      state: "unbound",
    }],
    onAction() {},
    onApply() {},
    onClose() {},
  });
  const lines = stripVTControlCharacters(panel.render(100).join("\n")).split("\n");
  assert.equal(lines.filter((line) => line.includes("❯") || line.includes("tool · query-docs")).length, 1);
  assert.equal(lines.filter((line) => line.includes("隔离 ← 当前")).length, 1);
  assert.ok(lines.some((line) => /You MUST call this tool\. Retrieves up-to-date documentation and code examples\./.test(line)));
  assert.equal(lines.some((line) => line.trimStart().startsWith("You MUST call this tool.")), false);
});

test("FormPanel wraps long multi-line descriptions instead of truncating to one line", () => {
  const endpoint = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
  const panel = new FormPanel({
    title: "Configure model",
    description: [
      "qianwenai:default",
      "wire responses",
      `endpoint ${endpoint}`,
      "endpoint is read-only",
    ].join("\n"),
    fields: [{ id: "model", label: "Model", initialValue: "qwen3.8-max", required: true }],
    onSubmit() {},
    onClose() {},
  });
  const rendered = panel.render(48).join("\n");
  assert.match(rendered, /qianwenai:default/);
  assert.match(rendered, /wire responses/);
  assert.match(rendered, /endpoint https:\/\/token-plan/);
  assert.match(rendered, /compatible-mode\/v1/);
  assert.doesNotMatch(rendered, /\(rea…|\(read-only…/);
});

test("FormPanel dropdowns support dependent defaults and a final custom text option", () => {
  let submitted;
  const panel = new FormPanel({
    title: "Kimi login",
    fields: [
      {
        id: "model",
        label: "Model",
        initialValue: "k3",
        options: [
          { value: "k3", label: "K3" },
          { value: "k3-256k", label: "K3 256K" },
          { value: "", label: "Enter manually", customInput: true, placeholder: "model id" },
        ],
      },
      {
        id: "effort",
        label: "Effort",
        initialValue: "high",
        options: [
          { value: "high", label: "High" },
          { value: "max", label: "Max" },
        ],
      },
      {
        id: "context",
        label: "Context",
        initialValue: "1048576",
      },
    ],
    onChange: (fieldId, value) => fieldId === "model"
      ? { context: value === "k3-256k" ? "262144" : "1048576" }
      : undefined,
    onSubmit: (values) => { submitted = values; },
    onClose: () => {},
  });

  const collapsed = stripVTControlCharacters(panel.render(90).join("\n"));
  assert.match(collapsed, /K3/);
  assert.doesNotMatch(collapsed, /○ K3 256K/);
  assert.doesNotMatch(collapsed, /● K3 256K/);
  panel.handleInput("\u001b[C"); // right -> k3-256k while collapsed
  panel.handleInput("\u001b[B"); // down -> effort field (not change model)
  panel.handleInput("\t"); // context
  panel.handleInput("\r");
  assert.deepEqual(submitted, {
    model: "k3-256k",
    effort: "high",
    context: "262144",
  });

  const custom = new FormPanel({
    title: "Custom model",
    fields: [{
      id: "model",
      label: "Model",
      initialValue: "future-kimi",
      options: [
        { value: "k3", label: "K3" },
        { value: "", label: "Enter manually", customInput: true, placeholder: "model id" },
      ],
    }],
    onSubmit: (values) => { submitted = values; },
    onClose: () => {},
  });
  assert.match(stripVTControlCharacters(custom.render(90).join("\n")), /future-kimi/);
  custom.handleInput("\r");
  assert.deepEqual(submitted, { model: "future-kimi" });
});

test("MultiSelectPanel Space toggles and Enter applies selected capability ids", () => {
  /** @type {string[] | undefined} */
  let applied;
  let closed = false;
  const panel = new MultiSelectPanel({
    title: "Select capability grants",
    items: [
      { id: "write", label: "Write", description: "edit files" },
      { id: "network", label: "Network", description: "fetch text" },
      { id: "delegate", label: "Delegate", description: "subagent" },
    ],
    selectedIds: ["write"],
    currentIds: ["write"],
    onApply: (ids) => { applied = [...ids].sort(); },
    onClose: () => { closed = true; },
  });
  const rendered = panel.render(80).join("\n");
  assert.match(rendered, /Select capability grants/);
  assert.match(rendered, /\[x\] Write/);
  assert.match(rendered, /← current/);
  panel.handleInput(" "); // toggle write off
  panel.handleInput("\u001b[B"); // network
  panel.handleInput(" "); // toggle network on
  panel.handleInput("\r");
  assert.deepEqual(applied, ["network"]);
  assert.equal(closed, false);
  panel.handleInput("\u001b");
  assert.equal(closed, true);
});

test("QuestionPanel answers multiple/text questions and persists Esc as skip", () => {
  let submitted;
  const panel = new QuestionPanel({
    questions: [
      {
        id: "targets",
        header: "Targets",
        prompt: "Choose targets",
        selection: "multiple",
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        allowText: false,
      },
      {
        id: "detail",
        header: "Detail",
        prompt: "Describe it",
        selection: "text",
        options: [],
        allowText: true,
      },
      {
        id: "optional",
        header: "Optional",
        prompt: "Choose or skip",
        selection: "single",
        options: [{ id: "yes", label: "Yes" }],
        allowText: false,
      },
    ],
    onSubmit: (answers) => { submitted = answers; },
  });
  panel.handleInput(" ");
  panel.handleInput("\u001b[B");
  panel.handleInput(" ");
  panel.handleInput("\r");
  panel.handleInput("custom detail");
  panel.handleInput("\r");
  panel.handleInput("\u001b");
  assert.deepEqual(submitted, [
    { questionId: "targets", selectedOptionIds: ["a", "b"], skipped: false },
    { questionId: "detail", selectedOptionIds: [], text: "custom detail", skipped: false },
    { questionId: "optional", selectedOptionIds: [], skipped: true },
  ]);
});

test("QuestionPanel hard-wraps long CJK prompts within the terminal width", () => {
  const prompt =
    "确认 v1 冲突策略：草稿采用「服务端按 updated_at 取较新者（LWW），旧版本写入 note_versions 快照兜底，但 v1 不做冲突合并 UI」。是否接受？";
  const panel = new QuestionPanel({
    questions: [{
      id: "conflict",
      header: "冲突处理确认",
      prompt,
      selection: "single",
      options: [
        { id: "accept", label: "接受（服务端留快照，v1 无冲突 UI）", description: "按草稿假设执行，实现最简单" },
        { id: "ui", label: "v1 就需要冲突解决 UI", description: "冲突时提示用户选择保留哪一版" },
      ],
      allowText: true,
    }],
    onSubmit: () => {},
  });
  const width = 120;
  const lines = panel.render(width);
  assert.ok(lines.some((line) => stripVTControlCharacters(line).includes("冲突策略")));
  assert.ok(lines.some((line) => stripVTControlCharacters(line).includes("是否接受")));
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line exceeds width ${width}: visible=${visibleWidth(line)} text=${JSON.stringify(stripVTControlCharacters(line))}`,
    );
  }
});

test("ask_question enables custom input by default unless explicitly disabled", async () => {
  let received;
  const tool = createAskQuestionTool({
    wait: async (_sessionId, _refs, questions) => {
      received = questions;
      return questions.map((question) => ({
        questionId: question.id,
        selectedOptionIds: question.selection === "text" ? [] : [question.options[0].id],
        ...(question.selection === "text" ? { text: "custom detail" } : {}),
        skipped: false,
      }));
    },
  });

  const result = await tool.execute({
    questions: [
      {
        id: "default_choice",
        header: "Default",
        prompt: "Choose or customize",
        selection: "single",
        options: [{ id: "a", label: "A" }],
      },
      {
        id: "closed_choice",
        header: "Closed",
        prompt: "Choose only",
        selection: "multiple",
        options: [{ id: "b", label: "B" }],
        allowText: false,
      },
      {
        id: "free_text",
        header: "Detail",
        prompt: "Describe it",
        selection: "text",
      },
    ],
  }, {
    sessionId: "ses_question_defaults",
    runId: "run_question_defaults",
    stepId: "stp_question_defaults",
    actionId: "act_question_defaults",
    signal: new AbortController().signal,
  });

  assert.deepEqual(received.map((question) => question.allowText), [true, false, true]);
  assert.equal(result.answers[2].text, "custom detail");
});

test("Agent update_plan records a stable Work Plan snapshot and renders it in the timeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-work-plan-"));
  const runtime = await TuiRuntime.create({
    workspaceRoot: root,
    dataRoot: join(root, ".qi"),
    modelPort: new ScriptedModelPort([
      [
        {
          type: "action.requested",
          callId: "call_work_plan",
          name: "update_plan",
          input: {
            explanation: "Track the cross-package change.",
            plan: [
              { step: "Extend protocol", status: "completed" },
              { step: "Wire runtime", status: "in_progress" },
              { step: "Verify behavior", status: "pending" },
            ],
          },
        },
        { type: "completed", finishReason: "actions" },
      ],
      [{ type: "text.delta", delta: "Implementation is underway." }, { type: "completed", finishReason: "stop" }],
    ]),
    model: { provider: "fake", model: "work-plan-v1" },
  });
  try {
    const result = await runtime.run("Implement a cross-package change.");
    assert.equal(result.status, "completed");
    const view = runtime.view();
    const workPlan = view?.currentWorkPlanId ? view.workPlans[view.currentWorkPlanId] : undefined;
    assert.equal(workPlan?.latestRevision, 1);
    assert.equal(workPlan?.revisions[1].items[1].status, "in_progress");
    assert.ok(workPlan?.revisions[1].items.every((item) => item.workItemId.startsWith("wit_")));
    assert.ok(workPlan?.revisions[1].items.every((item) => !item.workItemId.startsWith("wit_model_")));
    const action = Object.values(view.runs[result.runId].actions)[0];
    const event = runtime.events().find((candidate) => candidate.type === "action.completed");
    assert.ok(action);
    assert.ok(event);
    const card = renderToolCard({
      actionId: action.actionId,
      toolName: "update_plan",
      status: "completed",
      input: {
        explanation: "Track the cross-package change.",
        plan: workPlan.revisions[1].items,
      },
      output: {
        explanation: "Track the cross-package change.",
        plan: workPlan.revisions[1].items,
      },
    });
    const cardText = card.join("\n");
    assert.match(cardText, /To-do · Working on 3 to-dos/);
    assert.match(cardText, /1\/3 done/);
    assert.match(cardText, /✔ Extend protocol/);
    assert.match(cardText, /◐ Wire runtime/);
    assert.match(cardText, /○ Verify behavior/);
    assert.equal(renderToolCard({
      actionId: action.actionId,
      toolName: "update_plan",
      status: "completed",
      output: { plan: workPlan.revisions[1].items },
    }, { summaryOnly: true }).length, 1);

    const presenter = new TuiPresenter({
      workspaceRoot: root,
      dataRoot: join(root, ".qi"),
      provider: "fake",
      model: "work-plan-v1",
      capabilities: [],
      contextWindowTokens: 80_000,
      maxSteps: 8,
    });
    const liveView = structuredClone(view);
    liveView.runs[result.runId].status = "active";
    presenter.update(runtime.events(), liveView);
    const chat = presenter.renderChat().join("\n");
    assert.match(chat, /To-do · Working on 3 to-dos/);
    assert.match(chat, /✔ Extend protocol/);
    assert.match(chat, /◐ Wire runtime/);
    assert.match(chat, /○ Verify behavior/);
    assert.doesNotMatch(chat, /Todo  Working on/);

    const failedCard = renderToolCard({
      actionId: "act_failed_work_plan",
      toolName: "update_plan",
      status: "failed",
      errorCode: "WORK_PLAN_REJECTED",
      input: {
        workPlanId: "wpl_invented",
        plan: [{ step: "Do the work", status: "in_progress" }],
      },
      output: {
        code: "WORK_PLAN_REJECTED",
        message: "Work Plan wpl_invented does not exist. Omit workPlanId and every workItemId when creating.",
      },
    }).join("\n");
    assert.match(failedCard, /WORK_PLAN_REJECTED/);
    assert.match(failedCard, /does not exist.*Omit workPlanId/);
    assert.doesNotMatch(failedCard, /0\/1 done/);
    assert.match(failedCard, /◐ Do the work/);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("history run list selects observational Run via Enter", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "hist-v1",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const occurredAt = new Date(0).toISOString();
  presenter.update([], {
    sessionId: "ses_hist",
    createdAt: occurredAt,
    version: 1,
    mode: "agent",
    runOrder: ["run_a", "run_b"],
    currentRunId: "run_b",
    runs: {
      run_a: {
        runId: "run_a",
        trigger: "user",
        mode: "agent",
        status: "completed",
        input: "first",
        stepOrder: [],
        steps: {},
        actions: {},
        actionOrder: [],
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "completed", reason: "response" },
      },
      run_b: {
        runId: "run_b",
        trigger: "user",
        mode: "agent",
        status: "completed",
        input: "second",
        stepOrder: [],
        steps: {},
        actions: {},
        actionOrder: [],
        evaluations: {},
        steering: [],
        delegations: {},
        terminal: { type: "completed", reason: "response" },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "waiting", reason: "Idle" },
  });
  const items = presenter.historyRunItems();
  assert.equal(items.length, 2);
  assert.equal(items[0]?.id, "run_b");
  assert.equal(items[0]?.current, true);
  assert.equal(items[1]?.id, "run_a");
  /** @type {string | undefined} */
  let selected;
  const panel = new ListPanel({
    title: "Runs",
    items,
    initialSelected: items.findIndex((item) => item.current),
    onSelect: (item) => { selected = item.id; },
    onClose: () => {},
  });
  panel.handleInput("\u001b[B"); // down to older run_a
  panel.handleInput("\r");
  assert.equal(selected, "run_a");
  assert.match(presenter.selectRun("run_a"), /Inspecting Run 1/);
  assert.equal(presenter.selectedRun()?.runId, "run_a");
});

test("Running strip keeps parent tokens; Subagent rows show child tokens", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "delegate-v1",
    capabilities: ["delegate"],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  presenter.setChildViewLookup((id) => {
    if (id !== "ses_child_1") return undefined;
    return {
      sessionId: "ses_child_1",
      createdAt: new Date(0).toISOString(),
      version: 1,
      mode: "agent",
      currentRunId: "run_child",
      runOrder: ["run_child"],
      runs: {
        run_child: {
          runId: "run_child",
          trigger: "user",
          mode: "agent",
          status: "active",
          stepOrder: ["stp_child"],
          steps: {
            stp_child: {
              stepId: "stp_child",
              status: "running",
              context: { estimatedTokens: 1_200, budgetTokens: 8_000 },
            },
          },
          actions: {},
          evaluations: {},
          steering: [],
          delegations: {},
        },
      },
      goals: {},
      goalOrder: [],
      evidence: {},
      controlReceipts: {},
      memories: {},
      memoryOrder: [],
      tasks: {},
      taskOrder: [],
      plans: {},
      planOrder: [],
      presence: { state: "working", reason: "child" },
    };
  });
  const occurredAt = new Date(0).toISOString();
  presenter.update([], {
    sessionId: "ses_parent",
    createdAt: occurredAt,
    version: 1,
    mode: "agent",
    currentRunId: "run_parent",
    runOrder: ["run_parent"],
    runs: {
      run_parent: {
        runId: "run_parent",
        trigger: "user",
        mode: "agent",
        status: "active",
        input: "use subagent",
        stepOrder: ["stp_parent"],
        steps: {
          stp_parent: {
            stepId: "stp_parent",
            status: "running",
            context: { estimatedTokens: 5_900, budgetTokens: 64_000 },
          },
        },
        actions: {
          act_delegate: {
            actionId: "act_delegate",
            stepId: "stp_parent",
            toolName: "delegate",
            status: "running",
            effect: "other",
          },
        },
        evaluations: {},
        steering: [],
        delegations: {
          dlg_1: {
            delegationId: "dlg_1",
            childSessionId: "ses_child_1",
            outcome: "只读调研日志打印",
            returnPolicy: "result",
            status: "running",
            depth: 1,
            receiptId: "rcp_1",
            parentLeaseId: "lea_1",
            childLeaseId: "lea_2",
            childSubject: "subagent:dlg_1",
            contextRefs: [],
            contractRef: "artifact://c".padEnd(74, "c"),
            resourceEnvelope: {},
            evidenceRefs: [],
          },
        },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "working", reason: "parent" },
  });
  const working = presenter.renderWorking(true, 0).join("\n");
  assert.match(working, /waiting on subagent/);
  assert.match(working, /5\.90k tokens/);
  assert.doesNotMatch(working, /1\.20k/);
  const overview = presenter.render().join("\n");
  assert.match(overview, /Tasks · 1 running · \/tasks/);
  assert.match(overview, /只读调研日志打印/);
  assert.match(overview, /Running · 1\.20k tokens/);
  assert.doesNotMatch(overview, /summary artifact:\/\//);
});

test("TUI timeline Tasks strip hides finished Subagent detail", () => {
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/ws",
    dataRoot: "/tmp/ws/.qi",
    provider: "fake",
    model: "delegate-v1",
    capabilities: ["delegate"],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });
  const occurredAt = new Date(0).toISOString();
  presenter.update([], {
    sessionId: "ses_parent",
    createdAt: occurredAt,
    version: 2,
    mode: "plan",
    currentRunId: "run_parent",
    runOrder: ["run_parent"],
    runs: {
      run_parent: {
        runId: "run_parent",
        trigger: "user",
        mode: "plan",
        status: "active",
        input: "research vendors",
        stepOrder: ["stp_parent"],
        steps: {
          stp_parent: {
            stepId: "stp_parent",
            status: "running",
            context: { estimatedTokens: 4_000, budgetTokens: 64_000 },
          },
        },
        actions: {},
        evaluations: {},
        steering: [],
        delegations: {
          dlg_done: {
            delegationId: "dlg_done",
            childSessionId: "ses_child_done",
            outcome: "Finished DeepSeek survey that should stay off the timeline",
            returnPolicy: "result",
            status: "accepted",
            depth: 1,
            receiptId: "rcp_1",
            parentLeaseId: "lea_1",
            childLeaseId: "lea_2",
            childSubject: "subagent:dlg_done",
            contextRefs: [],
            contractRef: "artifact://c".padEnd(74, "c"),
            resourceEnvelope: {},
            evidenceRefs: [],
            summaryRef: `artifact://${"a".repeat(64)}`,
          },
          dlg_run: {
            delegationId: "dlg_run",
            childSessionId: "ses_child_run",
            outcome: "Running Kimi survey still visible",
            returnPolicy: "result",
            status: "running",
            depth: 1,
            receiptId: "rcp_2",
            parentLeaseId: "lea_1",
            childLeaseId: "lea_3",
            childSubject: "subagent:dlg_run",
            contextRefs: [],
            contractRef: "artifact://d".padEnd(74, "d"),
            resourceEnvelope: {},
            evidenceRefs: [],
          },
        },
      },
    },
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "working", reason: "parent" },
  });
  const overview = presenter.render().join("\n");
  assert.match(overview, /Tasks · 1 running · 1 finished · \/tasks/);
  assert.match(overview, /Running Kimi survey still visible/);
  assert.doesNotMatch(overview, /Finished DeepSeek survey that should stay off the timeline/);
  assert.doesNotMatch(overview, /summary artifact:\/\//);
  const panel = presenter.renderTasks().join("\n");
  assert.match(panel, /Finished DeepSeek survey/);
  assert.match(panel, /Running Kimi survey/);
});

class FakeTerminal {
  columns = 120;
  rows = 50;
  kittyProtocolActive = false;
  output = "";
  stopped = false;
  #input;

  start(onInput) {
    this.#input = onInput;
  }

  stop() { this.stopped = true; }
  async drainInput() {}
  write(data) { this.output += data; }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}

  sendText(text) {
    for (const character of text) this.#input?.(character);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await delay(20);
  }
}
