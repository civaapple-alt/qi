import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDelegatedTaskBrief,
  delegatedTaskTitle,
} from "../apps/cli/dist/delegated-task-brief.js";

test("buildDelegatedTaskBrief uses Cursor-style Focus / Return / Constraints sections", () => {
  const brief = buildDelegatedTaskBrief({
    objective: "Explore DeepSeek docs for TS openai SDK access",
    focus: ["Context Compiler path", "Prefix stability for caching"],
    returns: ["Key file paths", "Cache hit metrics"],
    constraints: ["Stay on official docs only"],
  });
  assert.match(brief, /^Explore DeepSeek docs for TS openai SDK access\n/);
  assert.match(brief, /\nFocus on:\n1\. Context Compiler path\n2\. Prefix stability for caching\n/);
  assert.match(brief, /\nReturn:\n- Key file paths\n- Cache hit metrics\n/);
  assert.match(brief, /\nConstraints:\n/);
  assert.match(brief, /- Read-only research/);
  assert.match(brief, /- Stay on official docs only/);
});

test("buildDelegatedTaskBrief fills research defaults when focus/returns omitted", () => {
  const brief = buildDelegatedTaskBrief({
    objective: "Survey Kimi Code docs",
  });
  assert.match(brief, /Focus on:\n1\. Authoritative sources/);
  assert.match(brief, /Return:\n- Key official URLs/);
  assert.match(brief, /Return structured, synthesizable facts/);
});

test("buildDelegatedTaskBrief injects the child budget envelope into Constraints", () => {
  const brief = buildDelegatedTaskBrief({
    objective: "Survey one vendor docs surface",
    budget: { maxSteps: 8, wallTimeMs: 300_000, contextTokens: 40_000 },
  });
  assert.match(brief, /Budget envelope: maxSteps=8, wall≈5m \(300000ms\), contextTokens=40000/);
  assert.match(brief, /one document surface or theme per child/);
});

test("delegatedTaskTitle truncates long objectives for Tasks list", () => {
  const title = delegatedTaskTitle("x".repeat(200), 40);
  assert.equal(title.length, 40);
  assert.match(title, /…$/);
});
