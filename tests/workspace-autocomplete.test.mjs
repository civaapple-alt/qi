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
