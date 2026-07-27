import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function assertCodingAcceptance({ root, resultStatus, committed, baseline }) {
  const proposedActions = committed.filter((event) => event.type === "action.proposed");
  const actionNames = proposedActions.map((event) => event.data.toolName);
  assert.equal(resultStatus, "completed", `Run ended ${resultStatus}`);
  assert.equal(actionNames.includes("verify"), true, "The Agent did not run declared verification");
  assert.equal(actionNames.includes("git"), true, "The Agent did not inspect Git evidence");
  assert.equal(actionNames.includes("shell"), false, "The general shell tool must not be available");
  assert.ok(
    actionNames.filter((name) => name === "edit" || name === "write").length >= 2,
    "Expected source changes in both coupled files",
  );
  const lastMutationIndex = actionNames.reduce(
    (latest, name, index) => name === "edit" || name === "write" ? index : latest,
    -1,
  );
  const verifyIndex = actionNames.lastIndexOf("verify");
  const gitIndex = actionNames.lastIndexOf("git");
  assert.ok(verifyIndex > lastMutationIndex, "Declared verification must observe the final source changes");
  assert.ok(gitIndex > verifyIndex, "Git evidence must be inspected after verification");
  const verifyProposal = proposedActions[verifyIndex];
  const verifyCompletion = committed.find(
    (event) => event.type === "action.completed" && event.data.actionId === verifyProposal.data.actionId,
  );
  assert.ok(verifyCompletion, "Declared verification did not settle successfully");
  const verifyOutput = JSON.parse(verifyCompletion.data.modelOutput[0].text);
  assert.equal(verifyOutput.exitCode, 0, "Declared verification returned a non-zero exit code");
  assert.equal(verifyOutput.timedOut, false, "Declared verification timed out");

  const finalTaxContent = await readFile(join(root, "src", "tax.mjs"), "utf8");
  const finalInvoiceContent = await readFile(join(root, "src", "invoice.mjs"), "utf8");
  assert.notEqual(finalTaxContent, baseline.tax, "The tax implementation was not changed");
  assert.notEqual(finalInvoiceContent, baseline.invoice, "The invoice implementation was not changed");
  assert.equal(await readFile(join(root, "test", "invoice.test.mjs"), "utf8"), baseline.test);
  await execFileAsync(process.execPath, ["--test", "test/invoice.test.mjs"], { cwd: root });

  const diff = await execFileAsync("git", ["diff", "--", "src/tax.mjs", "src/invoice.mjs"], { cwd: root });
  assert.match(diff.stdout, /src\/tax\.mjs/);
  assert.match(diff.stdout, /src\/invoice\.mjs/);
  const changed = await execFileAsync("git", ["diff", "--name-only"], { cwd: root });
  assert.deepEqual(changed.stdout.trim().split(/\r?\n/).sort(), ["src/invoice.mjs", "src/tax.mjs"]);
  return { actionNames, verificationDefinitionSha256: verifyOutput.definitionSha256 };
}
