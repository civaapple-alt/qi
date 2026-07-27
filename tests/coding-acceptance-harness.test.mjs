import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { assertCodingAcceptance } from "../scripts/coding-acceptance-oracle.mjs";

const execFileAsync = promisify(execFile);

test("coding acceptance judges equivalent implementations by behavior and evidence, not source shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-acceptance-oracle-"));
  const baseline = {
    tax: [
      "export function totalWithTax(subtotalCents, ratePercent) {",
      "  return Math.round(subtotalCents + ratePercent);",
      "}",
      "",
    ].join("\n"),
    invoice: [
      'import { totalWithTax } from "./tax.mjs";',
      "export function invoiceTotal(subtotalCents, ratePercent) {",
      "  return `${totalWithTax(subtotalCents, ratePercent)}`;",
      "}",
      "",
    ].join("\n"),
    test: [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { invoiceTotal } from "../src/invoice.mjs";',
      'test("invoice behavior", () => {',
      '  assert.equal(invoiceTotal(10000, 8), "$108.00");',
      '  assert.equal(invoiceTotal(2500, 0), "$25.00");',
      '  assert.equal(invoiceTotal(1999, 8.25), "$21.64");',
      "});",
      "",
    ].join("\n"),
  };
  try {
    await writeFixture(root, "src/tax.mjs", baseline.tax);
    await writeFixture(root, "src/invoice.mjs", baseline.invoice);
    await writeFixture(root, "test/invoice.test.mjs", baseline.test);
    await initializeGit(root);
    await writeFixture(root, "src/tax.mjs", [
      "export function totalWithTax(subtotalCents, ratePercent) {",
      "  return Math.round(subtotalCents + (subtotalCents * ratePercent) / 100);",
      "}",
      "",
    ].join("\n"));
    await writeFixture(root, "src/invoice.mjs", [
      'import { totalWithTax } from "./tax.mjs";',
      "export function invoiceTotal(subtotalCents, ratePercent) {",
      "  return `$${(totalWithTax(subtotalCents, ratePercent) / 100).toFixed(2)}`;",
      "}",
      "",
    ].join("\n"));

    const committed = [
      proposed("act_edit_tax", "edit"),
      proposed("act_edit_invoice", "edit"),
      proposed("act_verify", "verify"),
      completed("act_verify", { exitCode: 0, timedOut: false, definitionSha256: "a".repeat(64) }),
      proposed("act_git", "git"),
    ];
    const acceptance = await assertCodingAcceptance({ root, resultStatus: "completed", committed, baseline });
    assert.deepEqual(acceptance.actionNames, ["edit", "edit", "verify", "git"]);
    assert.equal(acceptance.verificationDefinitionSha256, "a".repeat(64));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function proposed(actionId, toolName) {
  return { type: "action.proposed", data: { actionId, toolName } };
}

function completed(actionId, output) {
  return {
    type: "action.completed",
    data: { actionId, modelOutput: [{ type: "text", text: JSON.stringify(output) }] },
  };
}

async function writeFixture(root, path, content) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function initializeGit(root) {
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "qi@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Qi Acceptance Test"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture baseline"], { cwd: root });
}
