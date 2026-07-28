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
    assert.equal(directTools.includes("shell"), true);
    assert.equal(directTools.includes("script"), false);
    assert.equal(directRuntime.shellProfiles.directEnabled, true);
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
    } else {
      assert.equal(scriptTools.includes("script"), false);
    }
  } finally {
    if (directRuntime) await directRuntime.close();
    if (scriptRuntime) await scriptRuntime.close();
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
