import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HostProcessSandbox,
  SrtCliProcessSandbox,
  WinLowIntegritySandbox,
  clearSandboxSmokeCache,
  probeSrtAvailable,
  resolveSandboxBackend,
  sandboxSmokeCacheSizeForTests,
} from "@civaapple/qi-node/sandbox";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("resolveSandboxBackend (ADR-0041)", () => {
  it("never policy forces host", async () => {
    const sandbox = await resolveSandboxBackend({ policy: "never", platform: "linux" });
    assert.equal(sandbox.info.backend, "host");
    assert.equal(sandbox.info.strength, "none");
  });

  it("auto on Windows without srt uses win-low-il", async () => {
    const sandbox = await resolveSandboxBackend({
      policy: "auto",
      platform: "win32",
      srtAvailable: () => false,
    });
    assert.equal(sandbox.info.backend, "win-low-il");
    assert.equal(sandbox.info.strength, "reduced");
    assert.ok(sandbox.info.wraps.includes("shell"));
    assert.ok(sandbox.info.wraps.includes("mcp-stdio"));
  });

  it("auto on Linux without srt uses host", async () => {
    const sandbox = await resolveSandboxBackend({
      policy: "auto",
      platform: "linux",
      srtAvailable: () => false,
    });
    assert.equal(sandbox.info.backend, "host");
  });

  it("SrtCliProcessSandbox wraps via cmd.exe on Windows .cmd shims", async () => {
    const sandbox = new SrtCliProcessSandbox("C:\\tools\\srt.cmd", "win32");
    assert.equal(sandbox.info.backend, "srt-windows");
    const wrapped = await sandbox.wrapCommand({
      command: "node",
      args: ["server.js"],
      workspaceRoot: process.cwd(),
      env: { FOO: "1" },
    });
    // Must not spawn .cmd directly (Node EINVAL); go through ComSpec.
    assert.match(wrapped.command.toLowerCase(), /cmd(\.exe)?$/);
    assert.equal(wrapped.windowsVerbatimArguments, true);
    assert.ok(wrapped.args.some((a) => String(a).includes("srt.cmd") || String(a).includes("server.js")));
  });

  it("SrtCliProcessSandbox uses srt binary directly on POSIX", async () => {
    const sandbox = new SrtCliProcessSandbox("/usr/bin/srt", "linux");
    const wrapped = await sandbox.wrapCommand({
      command: "node",
      args: ["server.js"],
      workspaceRoot: process.cwd(),
    });
    assert.equal(wrapped.command, "/usr/bin/srt");
    assert.ok(wrapped.args.includes("node"));
    assert.ok(wrapped.args.includes("-s"));
  });

  it("low-il on non-Windows falls back to host", async () => {
    const sandbox = await resolveSandboxBackend({
      policy: "low-il",
      platform: "darwin",
    });
    assert.equal(sandbox.info.backend, "host");
  });

  it("constructors expose honest disclosure and wrapCommand identity on host", async () => {
    const host = new HostProcessSandbox();
    assert.equal(host.info.status, "unavailable");
    const wrapped = await host.wrapCommand({
      command: "node",
      args: ["x.js"],
      workspaceRoot: process.cwd(),
    });
    assert.equal(wrapped.command, "node");
    assert.deepEqual([...wrapped.args], ["x.js"]);
    assert.equal(new WinLowIntegritySandbox().info.status, "reduced");
  });

  it("probeSrtAvailable reports structured result", async () => {
    const probe = await probeSrtAvailable({ PATH: "" }, "linux");
    assert.equal(probe.available, false);
    assert.match(probe.reason, /srt/i);
  });

  it("probe finds srt when a stub is on PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qi-srt-probe-"));
    try {
      const name = process.platform === "win32" ? "srt.cmd" : "srt";
      const path = join(dir, name);
      await writeFile(path, process.platform === "win32" ? "@echo off\n" : "#!/bin/sh\n", {
        mode: 0o755,
      });
      const probe = await probeSrtAvailable({ PATH: dir }, process.platform);
      assert.equal(probe.available, true);
      assert.equal(probe.kind, "cli");
      assert.ok(probe.path?.includes("srt"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("SrtWinProcessSandbox wraps via srt-win exec", async () => {
    const { SrtWinProcessSandbox } = await import("@civaapple/qi-node/sandbox");
    const sandbox = new SrtWinProcessSandbox("C:\\ProgramData\\qi\\srt-win\\srt-win.exe");
    assert.equal(sandbox.info.backend, "srt-windows");
    const wrapped = await sandbox.wrapCommand({
      command: "node",
      args: ["-e", "1"],
      workspaceRoot: process.cwd(),
    });
    assert.equal(wrapped.command, "C:\\ProgramData\\qi\\srt-win\\srt-win.exe");
    assert.deepEqual([...wrapped.args.slice(0, 3)], ["exec", "--quiet", "--"]);
    assert.ok(wrapped.args.includes("node"));
    assert.equal(typeof sandbox.prewarm, "function");
  });

  it("smokeSrt=false skips live smoke and does not grow smoke cache", async () => {
    clearSandboxSmokeCache();
    assert.equal(sandboxSmokeCacheSizeForTests(), 0);
    const sandbox = await resolveSandboxBackend({
      policy: "never",
      smokeSrt: false,
      platform: "linux",
    });
    assert.equal(sandbox.info.backend, "host");
    assert.equal(sandboxSmokeCacheSizeForTests(), 0);
  });

  it("second resolve after a successful smoke reuses process cache (Windows + srt only)", async function () {
    if (process.platform !== "win32") {
      this.skip();
      return;
    }
    const probe = await probeSrtAvailable();
    if (!probe.available) {
      this.skip();
      return;
    }
    clearSandboxSmokeCache();
    const root = await mkdtemp(join(tmpdir(), "qi-srt-smoke-cache-"));
    try {
      const first = await resolveSandboxBackend({
        policy: "auto",
        workspaceRoot: root,
        platform: "win32",
      });
      if (first.info.backend !== "srt-windows") {
        this.skip();
        return;
      }
      assert.ok(sandboxSmokeCacheSizeForTests() >= 1);
      const t0 = Date.now();
      const second = await resolveSandboxBackend({
        policy: "auto",
        workspaceRoot: root,
        platform: "win32",
      });
      const elapsed = Date.now() - t0;
      assert.equal(second.info.backend, "srt-windows");
      // Cached smoke should skip CreateProcessWithLogon (~10s+ cold path).
      assert.ok(elapsed < 5_000, `expected cached resolve <5s, took ${elapsed}ms`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
