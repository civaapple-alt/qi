import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildApprovalPattern,
  evaluateApprovalPolicy,
  leasePackForPermissionMode,
  parseApprovalPattern,
  patternMatches,
  permissionAutoAcceptsInLease,
  permissionSuppressesAskQuestion,
  rememberApproval,
  serializeApprovalPattern,
  SAFE_LEASE_PACK,
} from "@civaapple/qi-agent/capability";

describe("permission mode lease pack (ADR-0040)", () => {
  it("maps manual/yolo/auto to the same coding pack", () => {
    for (const mode of ["manual", "yolo", "auto"]) {
      const pack = leasePackForPermissionMode(mode);
      assert.equal(pack.write, true);
      assert.equal(pack.execute, true);
      assert.equal(pack.verify, true);
      assert.equal(pack.network, true);
      assert.equal(pack.background, true);
      assert.equal(pack.delegate, true);
      assert.equal(pack.publish, false);
      assert.equal(pack.spend, false);
    }
  });

  it("safe overrides any permission mode", () => {
    assert.deepEqual(leasePackForPermissionMode("yolo", { safe: true }), SAFE_LEASE_PACK);
  });

  it("yolo/auto auto-accept; manual does not", () => {
    assert.equal(permissionAutoAcceptsInLease("manual"), false);
    assert.equal(permissionAutoAcceptsInLease("yolo"), true);
    assert.equal(permissionAutoAcceptsInLease("auto"), true);
    assert.equal(permissionSuppressesAskQuestion("auto"), true);
    assert.equal(permissionSuppressesAskQuestion("yolo"), false);
  });
});

describe("approval policy chain", () => {
  it("approves default reads under manual", () => {
    const result = evaluateApprovalPolicy({
      permissionMode: "manual",
      sessionMode: "agent",
      tool: "read",
      effect: "read",
      resources: ["workspace:file:README.md"],
    });
    assert.equal(result.kind, "approve");
    assert.equal(result.policy, "default-read-approve");
  });

  it("asks for write under manual", () => {
    const result = evaluateApprovalPolicy({
      permissionMode: "manual",
      sessionMode: "agent",
      tool: "write",
      effect: "write",
      resources: ["workspace:file:src/a.ts"],
    });
    assert.equal(result.kind, "ask");
    assert.equal(result.policy, "fallback-ask");
    assert.deepEqual(result.allowedScopes, ["once", "session", "project"]);
  });

  it("yolo auto-accepts write without asking", () => {
    const result = evaluateApprovalPolicy({
      permissionMode: "yolo",
      sessionMode: "agent",
      tool: "write",
      effect: "write",
      resources: ["workspace:file:src/a.ts"],
    });
    assert.equal(result.kind, "approve");
    assert.equal(result.policy, "yolo-or-auto-accept");
  });

  it("Ask + yolo still denies write via session mode", () => {
    const result = evaluateApprovalPolicy({
      permissionMode: "yolo",
      sessionMode: "ask",
      tool: "write",
      effect: "write",
      resources: ["workspace:file:src/a.ts"],
    });
    assert.equal(result.kind, "deny");
    assert.equal(result.policy, "session-mode-deny");
  });

  it("mount grant always asks even under yolo", () => {
    const result = evaluateApprovalPolicy({
      permissionMode: "yolo",
      sessionMode: "agent",
      tool: "read",
      effect: "read",
      resources: ["mount:docs/readme.md"],
      requiresMountGrant: true,
    });
    assert.equal(result.kind, "ask");
    assert.equal(result.policy, "mount-grant-required");
  });

  it("session memory skips ask under manual", () => {
    const pattern = buildApprovalPattern("write", "write", ["workspace:file:src/a.ts"]);
    const memory = [
      rememberApproval({ pattern, decision: "allow", scope: "session" }),
    ];
    const result = evaluateApprovalPolicy({
      permissionMode: "manual",
      sessionMode: "agent",
      tool: "write",
      effect: "write",
      resources: ["workspace:file:src/a.ts"],
      sessionMemory: memory,
    });
    assert.equal(result.kind, "approve");
    assert.equal(result.policy, "approval-memory-session");
  });

  it("project memory matches directory tree patterns", () => {
    const stored = buildApprovalPattern("write", "write", ["workspace:file:src/nested/a.ts"]);
    assert.ok(stored.resourceClass.endsWith("/**") || stored.resourceClass.includes("src"));
    const memory = [
      rememberApproval({
        pattern: { tool: "write", effect: "write", resourceClass: "workspace:file:src/**" },
        decision: "allow",
        scope: "project",
      }),
    ];
    const result = evaluateApprovalPolicy({
      permissionMode: "manual",
      sessionMode: "agent",
      tool: "write",
      effect: "write",
      resources: ["workspace:file:src/other/b.ts"],
      projectMemory: memory,
    });
    assert.equal(result.kind, "approve");
    assert.equal(result.policy, "approval-memory-project");
  });

  it("serializes and parses approval patterns", () => {
    const pattern = buildApprovalPattern("shell", "execute", [
      "host-process:npm",
      "shell-profile:direct",
    ]);
    const serialized = serializeApprovalPattern(pattern);
    const parsed = parseApprovalPattern(serialized);
    assert.deepEqual(parsed, pattern);
    assert.ok(patternMatches(pattern, pattern));
  });
});
