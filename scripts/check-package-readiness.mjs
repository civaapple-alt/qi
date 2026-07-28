#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = [
  "protocol",
  "ai",
  "agent",
  "node",
  "tui",
];

const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const securityPolicy = await readFile(join(root, "SECURITY.md"), "utf8").catch(() => "");
const governancePolicy = await readFile(join(root, "GOVERNANCE.md"), "utf8").catch(() => "");
const checks = [];
const packageReports = [];
const remotes = await gitRemotes();

checks.push(await fileCheck("license", join(root, "LICENSE"), false));
checks.push(await fileCheck("contributing", join(root, "CONTRIBUTING.md"), false));
checks.push(await fileCheck("security-policy", join(root, "SECURITY.md"), false));
checks.push(await fileCheck("governance", join(root, "GOVERNANCE.md"), false));
checks.push({
  id: "security-reporting-destination",
  requiredForPreview: false,
  pass: /(?:mailto:|https:\/\/\S+)/u.test(securityPolicy)
    && !/absence of a configured private reporting destination is an open-source release blocker/iu.test(securityPolicy),
  detail: "SECURITY.md must name a real private reporting destination",
});
checks.push({
  id: "community-conduct",
  requiredForPreview: false,
  pass: await canRead(join(root, "CODE_OF_CONDUCT.md"))
    || /explicitly do not adopt a separate code of conduct/iu.test(governancePolicy),
  detail: "Add CODE_OF_CONDUCT.md or record an explicit governance decision not to adopt one",
});
checks.push({
  id: "canonical-remote",
  requiredForPreview: false,
  pass: remotes.length > 0,
  detail: remotes.join(", ") || "No Git remote configured",
});

for (const directory of packageDirectories) {
  const packageRoot = join(root, "packages", directory);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const readme = await readFile(join(packageRoot, "README.md"), "utf8");
  const report = {
    directory,
    name: manifest.name,
    checks: [],
  };
  report.checks.push(check("description", Boolean(manifest.description), "description is required"));
  report.checks.push(check("module", manifest.type === "module", "type must be module"));
  report.checks.push(check("main", manifest.main === "./dist/index.js", "main must target dist/index.js"));
  report.checks.push(check("types", manifest.types === "./dist/index.d.ts", "types must target dist/index.d.ts"));
  report.checks.push(check("exports", Boolean(manifest.exports?.["."]), "root exports map is required"));
  report.checks.push(check(
    "files",
    Array.isArray(manifest.files) && manifest.files.includes("dist") && manifest.files.includes("README.md"),
    "files must allowlist dist and README.md",
  ));
  report.checks.push(check(
    "engines",
    manifest.engines?.node === rootManifest.engines?.node,
    `engines.node must match ${rootManifest.engines?.node}`,
  ));
  report.checks.push(await fileCheck("readme", join(packageRoot, "README.md"), true));
  report.checks.push(check(
    "readme-install-example",
    readme.includes(`npm install ${manifest.name}`) && readme.includes(`from "${manifest.name}"`),
    "README must include an install command and import example",
  ));
  report.checks.push(await fileCheck("compiled-js", join(packageRoot, "dist", "index.js"), true));
  report.checks.push(await fileCheck("compiled-types", join(packageRoot, "dist", "index.d.ts"), true));
  report.checks.push({
    id: "publish-private",
    requiredForPreview: false,
    pass: manifest.private !== true,
    detail: manifest.private === true
      ? "private remains true until license, registry scope, and isolated gates are approved"
      : "package is not marked private",
  });
  report.checks.push({
    id: "license-metadata",
    requiredForPreview: false,
    pass: typeof manifest.license === "string" && manifest.license.length > 0,
    detail: manifest.license ?? "license metadata is missing",
  });
  report.checks.push({
    id: "repository-metadata",
    requiredForPreview: false,
    pass: Boolean(manifest.repository?.url && manifest.repository?.directory),
    detail: manifest.repository
      ? JSON.stringify(manifest.repository)
      : "repository metadata is missing",
  });
  packageReports.push(report);
}

const previewFailures = [
  ...checks.filter((item) => item.requiredForPreview && !item.pass),
  ...packageReports.flatMap((report) =>
    report.checks
      .filter((item) => item.requiredForPreview && !item.pass)
      .map((item) => ({ ...item, id: `${report.name}:${item.id}` }))),
];
const releaseBlockers = [
  ...checks.filter((item) => !item.pass),
  ...packageReports.flatMap((report) =>
    report.checks
      .filter((item) => !item.pass)
      .map((item) => ({ ...item, id: `${report.name}:${item.id}` }))),
];

const output = {
  type: "qi.package-readiness",
  schemaVersion: 1,
  release: rootManifest.version,
  preview: previewFailures.length === 0 ? "pass" : "fail",
  publicRelease: releaseBlockers.length === 0 ? "pass" : "blocked",
  checks,
  packages: packageReports,
  blockers: releaseBlockers.map(({ id, detail }) => ({ id, detail })),
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (previewFailures.length > 0) process.exitCode = 1;

function check(id, pass, detail) {
  return { id, requiredForPreview: true, pass, detail };
}

async function fileCheck(id, path, requiredForPreview) {
  try {
    await access(path, constants.R_OK);
    return { id, requiredForPreview, pass: true, detail: path };
  } catch {
    return { id, requiredForPreview, pass: false, detail: `Missing ${path}` };
  }
}

async function canRead(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function gitRemotes() {
  const output = await runCapture("git", ["remote", "-v"], root);
  return [...new Set(output.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean))];
}

function runCapture(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}
