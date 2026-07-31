import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { TuiRuntime } from "../apps/cli/dist/index.js";

test("TUI advertises shell and script only for authorized probed profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-shell-"));
  const directModel = responseModel();
  const scriptModel = responseModel();
  let directRuntime;
  let scriptRuntime;
  try {
    directRuntime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "direct-only"),
      modelPort: directModel,
      model: { provider: "fake", model: "shell-direct" },
      allowExecute: true,
      shell: { default: "direct", allowed: ["direct"] },
    });
    await directRuntime.run("Inspect tools");
    const directTools = directModel.requests[0].tools.map((tool) => tool.name);
    const directPrompt = directModel.requests[0].messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert.equal(directTools.includes("shell"), true);
    assert.equal(directTools.includes("script"), false);
    assert.equal(directRuntime.shellProfiles.directEnabled, true);
    assert.match(directPrompt, new RegExp(`platform=.*${process.platform}`));
    assert.match(directPrompt, /bash=disallowed/);
    assert.match(directPrompt, /Authorized shell profiles \(config\/probe units, not a single tool\)/);
    assert.match(directPrompt, /The shell tool is separate:.*does not interpret pipes/);
    assert.match(directPrompt, /The script tool is separate:.*never treat an argv-only shell limit/);
    assert.match(directPrompt, /Multiple shell or script Actions may share a workdir/);
    assert.match(directPrompt, /BATCH_WRITE_CONFLICT/);
    assert.match(directPrompt, /do not repeat the same unsupported assumption/);
    const shellDescription = directModel.requests[0].tools.find((tool) => tool.name === "shell")?.description ?? "";
    assert.match(shellDescription, /Multiple shell Actions may share a workdir/);
    assert.match(shellDescription, /one authorized script Action/);
    if (process.platform === "win32") {
      assert.match(directPrompt, /Do not attempt POSIX-only bash, lsof, xargs/);
      assert.match(directPrompt, /non-ASCII text/);
      assert.match(directPrompt, /git commit -F/);
    }
    await directRuntime.close();
    directRuntime = undefined;

    scriptRuntime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "with-script"),
      modelPort: scriptModel,
      model: { provider: "fake", model: "shell-script" },
      allowExecute: true,
      shell: {
        default: process.platform === "win32" ? "pwsh" : "bash",
        allowed: process.platform === "win32" ? ["direct", "pwsh", "cmd"] : ["direct", "bash"],
      },
    });
    await scriptRuntime.run("Inspect tools");
    const scriptTools = scriptModel.requests[0].tools.map((tool) => tool.name);
    assert.equal(scriptTools.includes("shell"), true);
    if (scriptRuntime.shellProfiles.available.length > 0) {
      assert.equal(scriptTools.includes("script"), true);
      const scriptPrompt = scriptModel.requests[0].messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.match(scriptPrompt, /prefer one script for builtins, pipes, or multi-statement logic/);
      assert.match(scriptPrompt, /The script tool is separate:/);
      const scriptDescription = scriptModel.requests[0].tools.find((tool) => tool.name === "script")?.description ?? "";
      assert.match(scriptDescription, /multi-statement logic/);
      assert.match(scriptDescription, /may share a workdir/);
    } else {
      assert.equal(scriptTools.includes("script"), false);
    }
  } finally {
    if (directRuntime) await directRuntime.close();
    if (scriptRuntime) await scriptRuntime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan mode guidance keeps shell argv-only limits separate from script profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-plan-shell-"));
  const model = responseModel();
  let runtime;
  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "plan-shell"),
      modelPort: model,
      model: { provider: "fake", model: "plan-shell" },
      allowExecute: true,
      shell: {
        default: "direct",
        allowed: process.platform === "win32" ? ["direct", "pwsh", "cmd"] : ["direct", "bash"],
      },
    });
    runtime.changeMode("plan");
    await runtime.run("Draft a Formal Plan for a small fix.");
    const prompt = model.requests[0].messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert.match(prompt, /Session mode is Plan/);
    assert.match(prompt, /defer host-execution detail to this Run's host:environment/);
    assert.match(prompt, /shell is direct argv-only spawn; script uses probed pwsh\/cmd\/bash profiles/);
    assert.match(prompt, /Never collapse an argv-only shell limit/);
    assert.match(prompt, /The shell tool is separate:/);
    assert.match(prompt, /The script tool is separate:/);
  } finally {
    if (runtime) await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

function responseModel() {
  return new ScriptedModelPort([
    {
      events: [
        { type: "text.delta", delta: "ok" },
        { type: "completed", finishReason: "stop" },
      ],
    },
  ]);
}
