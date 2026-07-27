import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  candidateSessionDatabases,
  parseArguments,
  resolveSessionDatabase,
  workspaceProjectSlug,
} from "../.qi/skills/analyze-qi-session/scripts/extract-session.mjs";

test("analyze-qi-session slug matches TUI Cursor-style encoding", () => {
  assert.equal(workspaceProjectSlug("D:\\lab-ws\\lab"), "D-lab-ws-lab");
  assert.equal(workspaceProjectSlug("/home/alwar/work/fastai"), "home-alwar-work-fastai");
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

test("analyze-qi-session prefers QI_HOME project DB over workspace-local", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-extract-db-"));
  try {
    const workspace = join(root, "lab");
    const qiHome = join(root, "home");
    const slug = workspaceProjectSlug(workspace);
    const homeDb = join(qiHome, "projects", slug, "qi.sqlite");
    const localDb = join(workspace, ".qi", "qi.sqlite");
    await mkdir(join(homeDb, ".."), { recursive: true });
    await mkdir(join(localDb, ".."), { recursive: true });
    await writeFile(homeDb, "");
    await writeFile(localDb, "");

    const candidates = candidateSessionDatabases({
      workspace,
      environment: { QI_HOME: qiHome },
    });
    assert.deepEqual(
      candidates.map((item) => item.kind),
      ["qi-home", "workspace-local"],
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

test("analyze-qi-session falls back to workspace-local when home DB is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-extract-local-"));
  try {
    const workspace = join(root, "lab");
    const qiHome = join(root, "home");
    const localDb = join(workspace, ".qi", "qi.sqlite");
    await mkdir(join(localDb, ".."), { recursive: true });
    await writeFile(localDb, "");

    const resolved = resolveSessionDatabase({
      workspace,
      environment: { QI_HOME: qiHome },
    });
    assert.equal(resolved, localDb);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyze-qi-session resolves by project slug alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-extract-slug-"));
  try {
    const qiHome = join(root, "home");
    const db = join(qiHome, "projects", "D-lab-ws-lab", "qi.sqlite");
    await mkdir(join(db, ".."), { recursive: true });
    await writeFile(db, "");
    const resolved = resolveSessionDatabase({
      projectSlug: "D-lab-ws-lab",
      environment: { QI_HOME: qiHome },
    });
    assert.equal(resolved, db);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
