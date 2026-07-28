import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  candidateSessionDatabases,
  claimsVerbalWorkspaceMutation,
  createReport,
  detectSignals,
  parseArguments,
  resolveSessionDatabase,
  selectedOperation,
  workspaceProjectSlug,
} from "../scripts/extract-session.mjs";

const root = process.cwd();

test("analyze-qi-session project identity is readable and collision-resistant", () => {
  assert.match(workspaceProjectSlug("D:\\lab-ws\\lab"), /^lab-[0-9a-f]{12}$/);
  assert.notEqual(
    workspaceProjectSlug("D:\\lab-ws\\lab"),
    workspaceProjectSlug("E:\\lab-ws\\lab"),
  );
});

test("analyze-qi-session defaults to bounded Runs and validates narrow query selectors", () => {
  const base = ["--session", "ses_x", "--db", "qi.sqlite"];
  assert.equal(selectedOperation(parseArguments(base)), "runs");
  assert.equal(selectedOperation(parseArguments([...base, "--run", "last"])), "run");
  assert.equal(selectedOperation(parseArguments([...base, "--run", "run_123", "--problems"])), "problems");
  assert.equal(selectedOperation(parseArguments([...base, "--last-step"])), "last-step");
  assert.equal(selectedOperation(parseArguments([...base, "--step", "stp_123", "--detail"])), "step");
  assert.equal(selectedOperation(parseArguments([...base, "--action", "act_123"])), "action");
  assert.equal(parseArguments([...base, "--all"]).all, true);
  assert.throws(
    () => parseArguments([...base, "--problems", "--last-step"]),
    /mutually exclusive/,
  );
  assert.throws(
    () => parseArguments([...base, "--all", "--detail"]),
    /cannot be combined/,
  );
});

test("analyze-qi-session accepts --workspace-root and QI_WORKSPACE", () => {
  assert.equal(
    parseArguments(["--session", "ses_x", "--workspace-root", "D:\\lab-ws\\lab"]).workspace,
    "D:\\lab-ws\\lab",
  );
  assert.equal(
    parseArguments(["--session", "ses_x", "--workspace", "D:\\lab-ws\\lab"]).workspace,
    "D:\\lab-ws\\lab",
  );
  assert.equal(
    parseArguments(["--session", "ses_x"], { QI_WORKSPACE: "D:\\lab-ws\\lab" }).workspace,
    "D:\\lab-ws\\lab",
  );
  assert.equal(
    parseArguments(["--session", "ses_x", "--project", "D-lab-ws-lab"]).project,
    "D-lab-ws-lab",
  );
});

test("analyze-qi-session resolves only the QI_HOME private project database", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-extract-db-"));
  try {
    const workspace = join(root, "lab");
    const qiHome = join(root, "home");
    const slug = workspaceProjectSlug(workspace);
    const homeDb = join(qiHome, "projects", slug, "state", "qi.sqlite");
    await mkdir(join(homeDb, ".."), { recursive: true });
    await writeFile(homeDb, "");

    const candidates = candidateSessionDatabases({
      workspace,
      environment: { QI_HOME: qiHome },
    });
    assert.deepEqual(
      candidates.map((item) => item.kind),
      ["qi-home"],
    );

    const resolved = resolveSessionDatabase({
      workspace,
      environment: { QI_HOME: qiHome },
    });
    assert.equal(resolved, homeDb);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyze-qi-session never falls back to Workspace-local runtime state", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-extract-local-"));
  try {
    const workspace = join(root, "lab");
    const qiHome = join(root, "home");
    assert.throws(
      () => resolveSessionDatabase({
        workspace,
        environment: { QI_HOME: qiHome },
      }),
      /No qi\.sqlite found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyze-qi-session resolves by project ID alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-extract-slug-"));
  try {
    const qiHome = join(root, "home");
    const db = join(qiHome, "projects", "lab-123456789abc", "state", "qi.sqlite");
    await mkdir(join(db, ".."), { recursive: true });
    await writeFile(db, "");
    const resolved = resolveSessionDatabase({
      projectSlug: "lab-123456789abc",
      environment: { QI_HOME: qiHome },
    });
    assert.equal(resolved, db);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimsVerbalWorkspaceMutation matches high-confidence mutation claims only", () => {
  assert.equal(claimsVerbalWorkspaceMutation("两处问题都已修复，edit 返回 diff 确认。"), true);
  assert.equal(claimsVerbalWorkspaceMutation("刚刚已用 edit 工具实际完成两处修改"), true);
  assert.equal(claimsVerbalWorkspaceMutation("The edit returned a diff confirming the change."), true);
  assert.equal(claimsVerbalWorkspaceMutation("I can fix the layout next if you want."), false);
  assert.equal(claimsVerbalWorkspaceMutation("The previous Run had writeCompleted=0."), false);
});

test("detectSignals flags verbal mutation claims without completed write Actions", () => {
  const narrative = {
    runs: [
      {
        runId: "run_verbal",
        status: "completed",
        displayStatus: "responded",
        terminalReason: "response",
        startSequence: 1,
        endSequence: 4,
        summary: { stepCount: 1, actionCount: 0 },
        steps: [
          {
            stepId: "stp_verbal",
            modelText: "两处都改掉了：scrollbar-gutter 已修复，diff 确认。",
            rejectedCalls: [],
            actions: [],
          },
        ],
      },
      {
        runId: "run_honest",
        status: "completed",
        displayStatus: "responded",
        terminalReason: "response",
        startSequence: 5,
        endSequence: 8,
        summary: { stepCount: 1, actionCount: 0 },
        steps: [
          {
            stepId: "stp_honest",
            modelText: "I have not edited any files yet; say if I should proceed.",
            rejectedCalls: [],
            actions: [],
          },
        ],
      },
      {
        runId: "run_real_write",
        status: "completed",
        displayStatus: "responded",
        terminalReason: "response",
        startSequence: 9,
        endSequence: 20,
        summary: { stepCount: 1, actionCount: 1 },
        steps: [
          {
            stepId: "stp_write",
            modelText: "两处问题都已修复。",
            rejectedCalls: [],
            actions: [
              {
                actionId: "act_write",
                stepId: "stp_write",
                toolName: "edit",
                effect: "write",
                status: "completed",
                milestones: { proposed: 10, authorityGranted: 11, started: 12, terminal: 13 },
              },
            ],
          },
        ],
      },
    ],
  };
  const codes = detectSignals(narrative, []).map((item) => `${item.code}:${item.evidence.runId}`);
  assert.ok(codes.includes("CLAIMED_MUTATION_WITHOUT_ACTIONS:run_verbal"));
  assert.equal(codes.includes("CLAIMED_MUTATION_WITHOUT_ACTIONS:run_honest"), false);
  assert.equal(codes.includes("CLAIMED_MUTATION_WITHOUT_ACTIONS:run_real_write"), false);
});

test("analyze-qi-session skill and extract --all surface Formal Plan / reasoning diagnostics", async () => {
  const skill = await readFile(join(root, ".qi", "skills", "analyze-qi-session", "SKILL.md"), "utf8");
  assert.match(skill, /version:\s*1\.3\.0/);
  assert.match(skill, /displayTitle/);
  assert.match(skill, /modelReasoning/);
  assert.match(skill, /actionFacts/);
  const checklist = await readFile(
    join(root, ".qi", "skills", "analyze-qi-session", "references", "analysis-checklist.md"),
    "utf8",
  );
  assert.match(checklist, /Formal Plan vs Work Plan/);
  assert.match(checklist, /Thinking is not Evidence/);
  assert.match(checklist, /qi-run-facts/);

  const report = createReport({
    source: { kind: "test" },
    view: {
      sessionId: "ses_extract_fields",
      title: "Extract fields",
      version: 1,
      presence: { state: "idle", reason: "test" },
      goals: {},
      evidence: {},
      memories: {},
    },
    events: [],
    narrative: {
      sessionId: "ses_extract_fields",
      runs: [{
        runId: "run_extract_fields",
        trigger: "user",
        input: "<accepted-plan># Long plan</accepted-plan>",
        displayTitle: "Accepted Plan · Long plan · rev 1",
        formalPlan: {
          planId: "pln_extract01",
          revision: 1,
          title: "Long plan",
          path: "/tmp/long.md",
          previewCollapsed: false,
          markdownPreview: "# Long plan",
        },
        workPlan: {
          workPlanId: "wpl_extract01",
          revision: 1,
          explanation: "Track",
          items: [{ workItemId: "wit_extract01", step: "Do work", status: "in_progress" }],
        },
        status: "completed",
        displayStatus: "responded",
        terminalReason: "response",
        summary: { stepCount: 1, actionCount: 1 },
        steps: [{
          stepId: "stp_extract01",
          index: 1,
          status: "settled",
          finishReason: "response",
          modelText: "Done.",
          modelReasoning: "Keep mutations explicit.",
          rejectedCalls: [],
          actions: [{
            actionId: "act_extract01",
            toolName: "shell",
            effect: "execute",
            resources: [],
            target: "npm test",
            status: "completed",
            gitWorkspaceChange: true,
            process: { command: "npm test", exitCode: 0, workspaceChanged: true },
            milestones: {},
          }],
        }],
      }],
    },
  });
  assert.equal(report.runs[0].displayTitle, "Accepted Plan · Long plan · rev 1");
  assert.equal(report.runs[0].formalPlan.title, "Long plan");
  assert.equal(report.runs[0].workPlan.items[0].status, "in_progress");
  assert.equal(report.runs[0].steps[0].modelReasoning, "Keep mutations explicit.");
  assert.equal(report.runs[0].steps[0].actions[0].gitWorkspaceChange, true);
  assert.equal(report.runs[0].steps[0].actions[0].process.command, "npm test");
});
