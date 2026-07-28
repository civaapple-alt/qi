import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  candidateSessionDatabases,
  parseArguments,
  resolveSessionDatabase,
  selectedOperation,
  workspaceProjectSlug,
} from "../scripts/extract-session.mjs";

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
