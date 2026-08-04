import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  validateWorkspaceMentions,
  WorkspaceAutocompleteProvider,
} from "../apps/cli/dist/workspace-autocomplete.js";

test("@ mentions normalize files/directories and reject missing, escaping, and protected paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-mentions-"));
  try {
    await mkdir(join(root, "docs", "with space"), { recursive: true });
    await mkdir(join(root, ".qi"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), "guide");
    assert.equal(
      await validateWorkspaceMentions('read @docs\\guide.md and @"docs/with space"', root),
      'read @docs/guide.md and @"docs/with space/"',
    );
    await assert.rejects(() => validateWorkspaceMentions("@missing.md", root), /does not exist/);
    await assert.rejects(() => validateWorkspaceMentions("@../outside", root), /escapes/);
    await assert.rejects(() => validateWorkspaceMentions("@.qi", root), /protected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("@ mentions leave absent npm-style @scope/pkg tokens as plain text", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-mentions-pkg-"));
  try {
    await mkdir(join(root, "packages", "shared-types"), { recursive: true });
    assert.equal(
      await validateWorkspaceMentions(
        "接入 workspace 与 @memo/shared-types；再看 @packages/shared-types",
        root,
      ),
      "接入 workspace 与 @memo/shared-types；再看 @packages/shared-types/",
    );
    await assert.rejects(
      () => validateWorkspaceMentions("typo @packages/missing-pkg", root),
      /does not exist/,
    );
    await assert.rejects(
      () => validateWorkspaceMentions("missing file @docs/guide.md", root),
      /does not exist/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slash completion before existing text inserts a command line and preserves the draft", () => {
  const provider = new WorkspaceAutocompleteProvider(
    [{ name: "model", description: "model" }],
    process.cwd(),
    undefined,
    new Set(["model"]),
  );
  assert.deepEqual(
    provider.applyCompletion(["/moexisting draft"], 0, 3, { value: "model", label: "model" }, "/mo"),
    { lines: ["/model", "existing draft"], cursorLine: 0, cursorCol: 6 },
  );
});

test("/skill completion lists active Skill names and preserves the task suffix", async () => {
  const provider = new WorkspaceAutocompleteProvider(
    [{ name: "skills", description: "skills" }],
    process.cwd(),
    undefined,
    new Set(),
    ["qianwen-model-selector", "qianwen-text", "web-design-guidelines"],
  );
  const suggestions = await provider.getSuggestions(["/skill:qian"], 0, 11, {
    signal: new AbortController().signal,
  });
  assert.deepEqual(suggestions?.items.map((item) => item.value), [
    "/skill:qianwen-model-selector",
    "/skill:qianwen-text",
  ]);
  assert.deepEqual(
    provider.applyCompletion(
      ["/skill:qian review this"],
      0,
      "/skill:qian".length,
      suggestions.items[1],
      "/skill:qian",
    ),
    { lines: ["/skill:qianwen-text review this"], cursorLine: 0, cursorCol: "/skill:qianwen-text".length },
  );
});
