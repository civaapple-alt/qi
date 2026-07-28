import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QiWebServer, listWebProjects } from "@civaapple/qi-web";
import { EventWriter } from "@civaapple/qi-agent/loop";
import { SqliteEventStore } from "@civaapple/qi-node/storage";

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
    const project = join(root, "D-demo-workspace");
    await mkdir(project);
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
    new EventWriter(store, second).append("session.created", { title: "Newer" }, { kind: "runtime", id: "test" });
    store.close();

    const server = new QiWebServer({ projectsRoot: root });
    const address = await server.listen();
    try {
      const meta = await fetch(`${address.url}/api/meta`).then((response) => response.json());
      assert.equal(meta.mode, "projects");
      assert.equal(meta.projectsRoot, root);

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
