import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  loadProjectConfig,
  projectApprovalFromStored,
  saveProjectConfig,
  storedApprovalsFromProject,
} from "../apps/cli/dist/project-config.js";
import { rememberApproval, serializeApprovalPattern } from "@civaapple/qi-agent/capability";

describe("project [[approvals]] persistence", () => {
  it("round-trips StoredApproval through policy.toml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qi-approvals-"));
    const path = join(dir, "policy.toml");
    try {
      const entry = rememberApproval({
        pattern: {
          tool: "write",
          effect: "write",
          resourceClass: "workspace:file:src/**",
        },
        decision: "allow",
        scope: "project",
        source: "manual",
      });
      await saveProjectConfig(path, {
        version: 1,
        approvals: [projectApprovalFromStored(entry)],
      });
      const body = await readFile(path, "utf8");
      assert.match(body, /\[\[approvals\]\]/);
      assert.match(body, /workspace:file:src\/\*\*/);
      const loaded = await loadProjectConfig(path);
      assert.equal(loaded.config.approvals?.length, 1);
      const restored = storedApprovalsFromProject(loaded.config.approvals);
      assert.equal(restored.length, 1);
      assert.equal(restored[0].decision, "allow");
      assert.equal(
        serializeApprovalPattern(restored[0].pattern),
        serializeApprovalPattern(entry.pattern),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
