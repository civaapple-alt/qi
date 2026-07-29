import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QiWebServer, listWebProjects } from "@civaapple/qi-web";
import { EventWriter } from "@civaapple/qi-agent/loop";
import { MemoryController } from "@civaapple/qi-agent/memory";
import { SqliteEventStore, SqliteMemoryIndex } from "@civaapple/qi-node/storage";

test("listWebProjects discovers state/qi.sqlite under project IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-web-projects-"));
  try {
    const newer = join(root, "Z-newer");
    const older = join(root, "A-older");
    await mkdir(newer);
    await mkdir(older);
    await mkdir(join(older, "state"));
    await writeFile(join(older, "project.json"), JSON.stringify({
      projectId: "A-older",
      workspaceRoot: join(root, "older-workspace"),
    }));
    await writeFile(join(older, "state", "qi.sqlite"), "");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mkdir(join(newer, "state"));
    await writeFile(join(newer, "project.json"), JSON.stringify({
      projectId: "Z-newer",
      workspaceRoot: join(root, "newer-workspace"),
    }));
    await writeFile(join(newer, "state", "qi.sqlite"), "");
    await mkdir(join(root, "empty"));
    const projects = await listWebProjects(root);
    assert.deepEqual(projects.map((item) => item.id), ["Z-newer", "A-older"]);
    assert.equal(projects[0]?.dbPath, join(newer, "state", "qi.sqlite"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Web workbench projects mode lists projects and switches Sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-web-projects-srv-"));
  try {
    const projectsRoot = join(root, "projects");
    const project = join(projectsRoot, "D-demo-workspace");
    await mkdir(project, { recursive: true });
    const dbPath = join(project, "state", "qi.sqlite");
    await mkdir(join(project, "state"));
    await writeFile(join(project, "project.json"), JSON.stringify({
      projectId: "D-demo-workspace",
      workspaceRoot: join(root, "workspace"),
    }));
    const store = new SqliteEventStore(dbPath);
    const first = "ses_web_project_a";
    const second = "ses_web_project_b";
    new EventWriter(store, first).append("session.created", { title: "Older" }, { kind: "runtime", id: "test" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const source = new EventWriter(store, second).append(
      "session.created",
      { title: "Newer" },
      { kind: "runtime", id: "test" },
    );
    const memorySource = new EventWriter(store, second).append(
      "memory.user.asserted",
      {
        operationId: "assert:web-memory",
        statement: "Web Memory source",
        scope: { kind: "project", projectId: "D-demo-workspace" },
      },
      { kind: "user", id: "local" },
    );
    const projectIndex = new SqliteMemoryIndex(join(project, "state", "memory.sqlite"));
    const projectMemory = new MemoryController(store, projectIndex, second);
    const projectClaim = projectMemory.propose({
      layer: "semantic",
      statement: "This project uses pnpm.",
      scope: { kind: "project", projectId: "D-demo-workspace" },
      provenance: [{
        projectId: "D-demo-workspace",
        sessionId: second,
        eventId: memorySource.eventId,
        sequence: memorySource.sequence,
      }],
      confidence: 1,
      sensitivity: "public",
    }, { actorId: "projector", autoAccept: true });
    projectIndex.close();

    await mkdir(join(root, "state"));
    const continuityStore = new SqliteEventStore(join(root, "state", "continuity.sqlite"));
    const continuityId = "ses_continuity_local";
    new EventWriter(continuityStore, continuityId).append(
      "session.created",
      { title: "Local user continuity" },
      { kind: "runtime", id: "test" },
    );
    const userIndex = new SqliteMemoryIndex(join(root, "state", "memory.sqlite"));
    const userMemory = new MemoryController(continuityStore, userIndex, continuityId, {
      provenanceResolver: {
        resolve: (reference) => store.read(reference.sessionId).events.find(
          (event) => event.eventId === reference.eventId && event.sequence === reference.sequence,
        ),
      },
    });
    const userClaim = userMemory.propose({
      layer: "semantic",
      statement: "The user prefers concise summaries.",
      scope: { kind: "user", userId: "local" },
      provenance: [{
        projectId: "D-demo-workspace",
        sessionId: second,
        eventId: memorySource.eventId,
        sequence: memorySource.sequence,
      }],
      confidence: 1,
      sensitivity: "private",
      requiresConfirmation: true,
    }, { actorId: "memory" });
    userMemory.accept(userClaim.memoryId, { kind: "user", id: "local" });
    userIndex.close();
    continuityStore.close();

    const runId = "run_web_memory";
    const stepId = "stp_web_memory";
    const writer = new EventWriter(store, second);
    writer.append("run.triggered", { runId, trigger: "user", input: "Use memory" }, { kind: "user", id: "local" });
    writer.append("run.started", { runId }, { kind: "runtime", id: "test" });
    writer.append("step.started", { runId, stepId }, { kind: "runtime", id: "test" });
    writer.append("context.compiled", {
      runId,
      stepId,
      includedBlockIds: [`memory:${projectClaim.memoryId}`],
      omittedBlockIds: [`memory:${userClaim.memoryId}`],
      estimatedTokens: 100,
      budgetTokens: 1_000,
    }, { kind: "runtime", id: "test" });
    store.close();

    const server = new QiWebServer({ projectsRoot });
    const address = await server.listen();
    try {
      const meta = await fetch(`${address.url}/api/meta`).then((response) => response.json());
      assert.equal(meta.mode, "projects");
      assert.equal(meta.projectsRoot, projectsRoot);

      const projects = await fetch(`${address.url}/api/projects`).then((response) => response.json());
      assert.equal(projects.length, 1);
      assert.equal(projects[0].id, "D-demo-workspace");

      const sessions = await fetch(`${address.url}/api/sessions?project=D-demo-workspace`).then((response) => response.json());
      assert.equal(sessions.length, 2);
      assert.equal(sessions[0].sessionId, second);
      assert.equal(sessions[0].title, "Newer");

      const workbench = await fetch(
        `${address.url}/api/session/${second}/workbench?project=D-demo-workspace`,
      ).then((response) => response.json());
      assert.equal(workbench.view.title, "Newer");
      assert.equal(workbench.memory.userIndexAvailable, true);
      assert.deepEqual(
        workbench.memory.claims.map((claim) => claim.scope.kind).sort(),
        ["project", "user"],
      );
      assert.deepEqual(workbench.memory.usage, [{
        runId,
        stepId,
        included: [projectClaim.memoryId],
        omitted: [userClaim.memoryId],
      }]);

      assert.equal((await fetch(`${address.url}/api/sessions`)).status, 400);
      const page = await fetch(address.url).then((response) => response.text());
      assert.match(page, /project-select/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
