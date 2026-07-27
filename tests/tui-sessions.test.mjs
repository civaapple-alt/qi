import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScriptedModelPort } from "@civaapple/qi-llm";
import {
  SessionsPanel,
  NEW_SESSION_ID,
  buildSessionEntries,
  formatRelativeTime,
  sessionPreviewText,
  shortSessionId,
  TuiRuntime,
  autocompleteSlashCommands,
  primarySlashCommands,
  t,
} from "@civaapple/qi";

test("formatRelativeTime covers just now / minutes / hours / days / date", () => {
  const now = Date.parse("2026-07-23T12:00:00.000Z");
  assert.equal(formatRelativeTime("2026-07-23T11:59:30.000Z", now), "just now");
  assert.equal(formatRelativeTime("2026-07-23T11:55:00.000Z", now), "5m ago");
  assert.equal(formatRelativeTime("2026-07-23T09:00:00.000Z", now), "3h ago");
  assert.equal(formatRelativeTime("2026-07-21T12:00:00.000Z", now), "2d ago");
  assert.equal(formatRelativeTime("2026-06-01T12:00:00.000Z", now), "2026-06-01");
});

test("sessionPreviewText prefers the newest run.triggered or model.completed text", () => {
  const events = [
    {
      schemaVersion: 1,
      eventId: "evt_1",
      sessionId: "ses_a",
      sequence: 1,
      occurredAt: "2026-07-23T10:00:00.000Z",
      actor: { kind: "user", id: "u" },
      type: "run.triggered",
      data: { runId: "run_1", trigger: "user", input: "first question" },
    },
    {
      schemaVersion: 1,
      eventId: "evt_2",
      sessionId: "ses_a",
      sequence: 2,
      occurredAt: "2026-07-23T10:00:01.000Z",
      actor: { kind: "agent", id: "a" },
      type: "model.completed",
      data: {
        runId: "run_1",
        stepId: "stp_1",
        requestId: "req_1",
        provider: "fake",
        model: "m",
        finishReason: "stop",
        text: "  hello   world  ",
        actionCalls: [],
      },
    },
  ];
  assert.equal(sessionPreviewText(/** @type {any} */ (events)), "hello world");
  assert.equal(shortSessionId("ses_abcdefghijklmnop"), "ses_abcd…");
});

test("TuiRuntime.listSessions returns Sessions sharing one dataRoot", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-sessions-"));
  const workspace = join(root, "workspace");
  const dataRoot = join(root, "data");
  await mkdir(workspace);
  /** @type {import("@civaapple/qi").TuiRuntime | undefined} */
  let first;
  /** @type {import("@civaapple/qi").TuiRuntime | undefined} */
  let second;
  /** @type {import("@civaapple/qi").TuiRuntime | undefined} */
  let third;
  try {
    first = await TuiRuntime.create({
      workspaceRoot: workspace,
      dataRoot,
      modelPort: new ScriptedModelPort([
        [
          { type: "text.delta", delta: "one" },
          { type: "completed", finishReason: "stop" },
        ],
      ]),
      model: { provider: "fake", model: "sessions-v1" },
    });
    await first.run("first session prompt");
    const firstId = first.sessionId;
    await first.close();
    first = undefined;

    second = await TuiRuntime.create({
      workspaceRoot: workspace,
      dataRoot,
      modelPort: new ScriptedModelPort([
        [
          { type: "text.delta", delta: "two" },
          { type: "completed", finishReason: "stop" },
        ],
      ]),
      model: { provider: "fake", model: "sessions-v1" },
    });
    await second.run("second session prompt");
    const secondId = second.sessionId;
    await second.close();
    second = undefined;

    third = await TuiRuntime.create({
      workspaceRoot: workspace,
      dataRoot,
      sessionId: firstId,
      modelPort: new ScriptedModelPort([]),
      model: { provider: "fake", model: "sessions-v1" },
    });
    const listed = third.listSessions();
    assert.equal(listed.length, 2);
    assert.ok(listed.some((session) => session.sessionId === firstId));
    assert.ok(listed.some((session) => session.sessionId === secondId));
    const entries = buildSessionEntries(listed, {
      workspaceRoot: workspace,
      readEvents: (sessionId) => third.readSessionEvents(sessionId),
    });
    assert.equal(entries.length, 2);
    assert.ok(entries.some((entry) => entry.preview.includes("second session prompt")
      || entry.preview.includes("two")
      || entry.preview.includes("first session prompt")
      || entry.preview.includes("one")));
  } finally {
    await first?.close();
    await second?.close();
    await third?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionsPanel filters by query and Enter selects a Session", () => {
  /** @type {string[]} */
  const selected = [];
  let closed = false;
  const panel = new SessionsPanel({
    title: t("en", "sessions.title"),
    hints: t("en", "sessions.hints"),
    emptyLabel: t("en", "sessions.empty"),
    currentMark: t("en", "sessions.current"),
    showingLabel: (from, to, total) => t("en", "sessions.showing", {
      from: String(from),
      to: String(to),
      total: String(total),
    }),
    items: [
      { id: NEW_SESSION_ID, title: "New Session", isNew: true },
      {
        id: "ses_aaa",
        title: "Alpha",
        sessionId: /** @type {any} */ ("ses_aaa"),
        updatedAt: "2026-07-23T11:00:00.000Z",
        workspaceRoot: "D:/ws",
        preview: "alpha preview",
        current: true,
      },
      {
        id: "ses_bbb",
        title: "Beta",
        sessionId: /** @type {any} */ ("ses_bbb"),
        updatedAt: "2026-07-22T11:00:00.000Z",
        workspaceRoot: "D:/ws",
        preview: "beta preview",
      },
    ],
    initialSelected: 1,
    onSelect: (item) => selected.push(item.id),
    onClose: () => { closed = true; },
  });
  const rendered = panel.render(80).join("\n");
  assert.match(rendered, /Sessions/);
  assert.match(rendered, /Alpha/);
  assert.match(rendered, /← current/);
  assert.match(rendered, /› alpha preview/);
  assert.match(rendered, /Showing/);

  panel.handleInput("b");
  panel.handleInput("e");
  const filtered = panel.render(80).join("\n");
  assert.match(filtered, /Beta/);
  assert.doesNotMatch(filtered, /Alpha/);
  panel.handleInput("\r");
  assert.deepEqual(selected, ["ses_bbb"]);

  panel.handleInput("\u001b"); // clear filter
  panel.handleInput("\u001b"); // dismiss
  assert.equal(closed, true);
});

test("/sessions is a primary slash command", () => {
  const primary = primarySlashCommands("en");
  assert.ok(primary.some((command) => command.name === "sessions"));
  const autocomplete = autocompleteSlashCommands("en");
  assert.ok(autocomplete.some((command) => command.name === "sessions"));
});
