import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostProcessSandbox, SrtCliProcessSandbox, WinLowIntegritySandbox } from "@civaapple/qi-node/sandbox";

describe("MCP stdio wrapCommand (ADR-0041)", () => {
  it("host wrap is identity", async () => {
    const sandbox = new HostProcessSandbox();
    const wrapped = await sandbox.wrapCommand({
      command: "node",
      args: ["mcp-server.js"],
      workspaceRoot: process.cwd(),
      env: { A: "1" },
    });
    assert.equal(wrapped.command, "node");
    assert.deepEqual([...wrapped.args], ["mcp-server.js"]);
    assert.equal(wrapped.env?.A, "1");
  });

  it("srt wrap uses cmd.exe for .cmd shims on Windows", async () => {
    const sandbox = new SrtCliProcessSandbox("C:/tools/srt.cmd", "win32");
    const wrapped = await sandbox.wrapCommand({
      command: "node",
      args: ["server.js", "--flag"],
      workspaceRoot: process.cwd(),
      env: { NO_COLOR: "1" },
    });
    assert.match(wrapped.command.toLowerCase(), /cmd(\.exe)?$/);
    assert.equal(wrapped.windowsVerbatimArguments, true);
    const joined = wrapped.args.join(" ");
    assert.match(joined, /srt\.cmd/i);
    assert.match(joined, /server\.js/);
    assert.equal(wrapped.env?.QI_SANDBOX_BACKEND, "srt-windows");
  });

  it("win-low-il wrap keeps command but marks backend env", async () => {
    const sandbox = new WinLowIntegritySandbox();
    const wrapped = await sandbox.wrapCommand({
      command: "node",
      args: ["x.js"],
      workspaceRoot: process.cwd(),
    });
    assert.equal(wrapped.command, "node");
    assert.equal(wrapped.env?.QI_SANDBOX_BACKEND, "win-low-il");
  });
});
