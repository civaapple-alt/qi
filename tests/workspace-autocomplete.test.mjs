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

test("/plugin and /agent completion do not double the leading slash", async () => {
  const provider = new WorkspaceAutocompleteProvider(
    [{ name: "plugins", description: "plugins" }],
    process.cwd(),
    undefined,
    new Set(),
    [],
    ["frontend-design", "code-review"],
    ["pr-review-toolkit:code-reviewer"],
  );
  const pluginSuggestions = await provider.getSuggestions(["/plugin:front"], 0, "/plugin:front".length, {
    signal: new AbortController().signal,
  });
  assert.deepEqual(pluginSuggestions?.items.map((item) => item.value), ["/plugin:frontend-design"]);
  assert.deepEqual(
    provider.applyCompletion(
      ["/plugin:front sketch a page"],
      0,
      "/plugin:front".length,
      pluginSuggestions.items[0],
      "/plugin:front",
    ),
    { lines: ["/plugin:frontend-design sketch a page"], cursorLine: 0, cursorCol: "/plugin:frontend-design".length },
  );

  const agentSuggestions = await provider.getSuggestions(["/agent:pr"], 0, "/agent:pr".length, {
    signal: new AbortController().signal,
  });
  assert.deepEqual(agentSuggestions?.items.map((item) => item.value), [
    "/agent:pr-review-toolkit:code-reviewer",
  ]);
  assert.deepEqual(
    provider.applyCompletion(
      ["/agent:pr review auth"],
      0,
      "/agent:pr".length,
      agentSuggestions.items[0],
      "/agent:pr",
    ),
    {
      lines: ["/agent:pr-review-toolkit:code-reviewer review auth"],
      cursorLine: 0,
      cursorCol: "/agent:pr-review-toolkit:code-reviewer".length,
    },
  );
});

test("long dynamic slash names keep an exact value and compact source description", async () => {
  const provider = new WorkspaceAutocompleteProvider(
    [],
    process.cwd(),
    undefined,
    new Set(),
    [],
    ["superpowers:receiving-code-review"],
    ["superpowers:receiving-code-review"],
  );
  const prefix = "/plugin:superpowers:receiving-";
  const suggestions = await provider.getSuggestions([prefix], 0, prefix.length, {
    signal: new AbortController().signal,
  });
  assert.equal(suggestions?.items[0]?.value, "/plugin:superpowers:receiving-code-review");
  assert.equal(suggestions?.items[0]?.label, "/plugin:receiving-code-review");
  assert.equal(suggestions?.items[0]?.description, "superpowers · receiving-code-review");
  assert.equal(suggestions?.items[0]?.label.includes("…"), false);
});

test("/skill marketplace rows complete short unique names and show source", async () => {
  const provider = new WorkspaceAutocompleteProvider(
    [],
    process.cwd(),
    undefined,
    new Set(),
    ["prompting-guide"],
    [],
    [],
    [
      {
        id: "mattpocock:mattpocock-skills:grill-me",
        name: "grill-me",
        marketplace: "mattpocock",
        plugin: "mattpocock-skills",
      },
      {
        id: "taste-skill:taste-skill:taste-skill",
        name: "taste-skill",
        marketplace: "taste-skill",
        plugin: "taste-skill",
        declaredName: "design-taste-frontend",
      },
      {
        id: "taste-skill:taste-skill:image-to-code-skill",
        name: "image-to-code-skill",
        marketplace: "taste-skill",
        plugin: "taste-skill",
        declaredName: "image-to-code",
      },
    ],
  );
  const all = await provider.getSuggestions(["/skill:"], 0, "/skill:".length, {
    signal: new AbortController().signal,
  });
  assert.ok(all?.items.some((item) => item.value === "/skill:prompting-guide" && item.description === "Native Skill"));
  const grill = all?.items.find((item) => item.label === "/skill:grill-me");
  assert.equal(grill?.value, "/skill:grill-me");
  assert.equal(grill?.description, "mattpocock · mattpocock-skills");
  assert.doesNotMatch(grill?.description ?? "", /Enabled/);

  const taste = all?.items.find((item) => item.label === "/skill:taste-skill");
  assert.equal(taste?.value, "/skill:taste-skill");
  assert.equal(taste?.description, "taste-skill · design-taste-frontend");

  const byMd = await provider.getSuggestions(["/skill:image-to-code"], 0, "/skill:image-to-code".length, {
    signal: new AbortController().signal,
  });
  const image = byMd?.items.find((item) => item.label.includes("image-to-code"));
  assert.equal(image?.value, "/skill:image-to-code-skill");
  assert.equal(image?.description, "taste-skill · image-to-code");
});

test("/skill short completion disambiguates colliding skill names", async () => {
  const provider = new WorkspaceAutocompleteProvider(
    [],
    process.cwd(),
    undefined,
    new Set(),
    [],
    [],
    [],
    [
      {
        id: "alpha:plug:shared",
        name: "shared",
        marketplace: "alpha",
        plugin: "plug",
      },
      {
        id: "beta:plug:shared",
        name: "shared",
        marketplace: "beta",
        plugin: "plug",
      },
    ],
  );
  const suggestions = await provider.getSuggestions(["/skill:shared"], 0, "/skill:shared".length, {
    signal: new AbortController().signal,
  });
  const values = suggestions?.items.map((item) => item.value).sort() ?? [];
  assert.deepEqual(values, ["/skill:alpha:shared", "/skill:beta:shared"]);
});
