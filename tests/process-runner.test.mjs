import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolProcess } from "@civaapple/qi-node/tools";
import { HostProcessSandbox, WinLowIntegritySandbox } from "@civaapple/qi-node/sandbox";

describe("runToolProcess", () => {
  it("falls back to host when context has no runProcess", async () => {
    const context = {
      workspaceRoot: process.cwd(),
      sessionId: "ses_test",
      runId: "run_test",
      stepId: "stp_test",
      actionId: "act_test",
      subject: "test",
      artifactStore: {
        async put() {
          return { ref: "artifact://0".padEnd(75, "0"), size: 0, sha256: "0".repeat(64) };
        },
        async get() {
          return { content: new Uint8Array(), mediaType: "text/plain" };
        },
      },
    };
    const command = process.platform === "win32" ? process.execPath : "node";
    const result = await runToolProcess(context, command, ["-e", "process.stdout.write('ok')"], {
      timeoutMs: 10_000,
      outputLimitBytes: 1024,
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /ok/);
  });

  it("uses injected ProcessSandbox.run when context.runProcess is set", async () => {
    const sandbox = new HostProcessSandbox("test");
    let seen = false;
    const context = {
      workspaceRoot: process.cwd(),
      sessionId: "ses_test",
      runId: "run_test",
      stepId: "stp_test",
      actionId: "act_test",
      subject: "test",
      artifactStore: {
        async put() {
          return { ref: "artifact://0".padEnd(75, "0"), size: 0, sha256: "0".repeat(64) };
        },
        async get() {
          return { content: new Uint8Array(), mediaType: "text/plain" };
        },
      },
      runProcess: async (command, args, options) => {
        seen = true;
        return sandbox.run({
          command,
          args,
          options,
          workspaceRoot: process.cwd(),
        });
      },
    };
    const command = process.platform === "win32" ? process.execPath : "node";
    const result = await runToolProcess(context, command, ["-e", "process.stdout.write('via-sandbox')"], {
      timeoutMs: 10_000,
      outputLimitBytes: 1024,
    });
    assert.equal(seen, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /via-sandbox/);
  });

  it("win-low-il still executes and discloses reduced strength", async () => {
    const sandbox = new WinLowIntegritySandbox();
    assert.equal(sandbox.info.strength, "reduced");
    const command = process.platform === "win32" ? process.execPath : "node";
    const result = await sandbox.run({
      command,
      args: ["-e", "process.stdout.write('low')"],
      workspaceRoot: process.cwd(),
      options: { timeoutMs: 10_000, outputLimitBytes: 1024 },
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /low/);
  });
});
