import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { OpenAIResponsesModelPort } from "@civaapple/qi-llm";
import { resolveProviderConfig, TuiRuntime } from "@civaapple/qi";
import { assertCodingAcceptance } from "./coding-acceptance-oracle.mjs";

const execFileAsync = promisify(execFile);

if (process.env.QI_REAL_PROVIDER_ACCEPT !== "1") {
  throw new Error(
    "Real-provider acceptance consumes API quota. Set QI_REAL_PROVIDER_ACCEPT=1 to opt in explicitly.",
  );
}

const provider = resolveProviderConfig();
const root = await mkdtemp(join(tmpdir(), "qi-real-coding-acceptance-"));
const keepWorkspace = process.env.QI_KEEP_ACCEPTANCE_WORKSPACE === "1";
const committed = [];
let runtime;

try {
  await writeWorkspaceFile("AGENTS.md", [
    "Fix source code, not tests.",
    "Both files under src contain coupled parts of the regression.",
    "Run the focused verification profile and inspect Git diff before the final response.",
    "",
  ].join("\n"));
  await writeWorkspaceFile(".gitignore", ".qi/\n");
  const taxContent = [
    "export function totalWithTax(subtotalCents, ratePercent) {",
    "  return Math.round(subtotalCents + ratePercent);",
    "}",
    "",
  ].join("\n");
  await writeWorkspaceFile("src/tax.mjs", taxContent);
  const invoiceContent = [
    'import { totalWithTax } from "./tax.mjs";',
    "export function invoiceTotal(subtotalCents, ratePercent) {",
    "  return `${totalWithTax(subtotalCents, ratePercent)}`;",
    "}",
    "",
  ].join("\n");
  await writeWorkspaceFile("src/invoice.mjs", invoiceContent);
  const testContent = [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { invoiceTotal } from "../src/invoice.mjs";',
    'test("invoice applies percentage tax and formats currency", () => {',
    '  assert.equal(invoiceTotal(10000, 8), "$108.00");',
    '  assert.equal(invoiceTotal(2500, 0), "$25.00");',
    '  assert.equal(invoiceTotal(1999, 8.25), "$21.64");',
    "});",
    "",
  ].join("\n");
  await writeWorkspaceFile("test/invoice.test.mjs", testContent);
  await writeWorkspaceFile(".qi/qi.verify.json", JSON.stringify({
    version: 1,
    profiles: {
      focused: {
        description: "Run the invoice regression test",
        command: process.execPath,
        args: ["--test", "test/invoice.test.mjs"],
        timeoutMs: 10_000,
      },
    },
  }));
  await initializeGit();

  runtime = await TuiRuntime.create({
    workspaceRoot: root,
    dataRoot: join(root, ".qi"),
    modelPort: OpenAIResponsesModelPort.fromClientOptions(
      {
        apiKey: provider.apiKey,
        ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
      },
      {
        providerNames: [provider.provider],
        requestMetadata: provider.provider !== "xai",
      },
    ),
    model: { provider: provider.provider, model: provider.model },
    allowWrite: true,
    allowVerify: true,
    onEvent: (event) => committed.push(event),
  });
  const result = await runtime.run(
    "Repair the invoice regression. Do not change tests. Use repository evidence, run the focused verification profile, inspect Git diff, and only then report completion.",
  );
  const acceptance = await assertCodingAcceptance({
    root,
    resultStatus: result.status,
    committed,
    baseline: { tax: taxContent, invoice: invoiceContent, test: testContent },
  });

  process.stdout.write(`${JSON.stringify({
    outcome: "accepted",
    provider: provider.provider,
    model: provider.model,
    sessionId: runtime.sessionId,
    actions: acceptance.actionNames,
    verificationDefinitionSha256: acceptance.verificationDefinitionSha256,
    independentTestPassed: true,
    workspace: keepWorkspace ? root : "cleaned",
  }, null, 2)}\n`);
} finally {
  runtime?.close();
  if (!keepWorkspace) await rm(root, { recursive: true, force: true });
  else process.stderr.write(`Acceptance Workspace preserved at ${root}\n`);
}

async function writeWorkspaceFile(path, content) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function initializeGit() {
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "qi@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Qi Acceptance"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "--quiet", "-m", "acceptance baseline"], { cwd: root });
}
