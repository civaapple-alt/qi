import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, posix, resolve, sep } from "node:path";

const acceptedDependencyLicenses = new Set([
  "Apache-2.0",
  "Apache-2.0 AND LGPL-3.0-or-later",
  "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "0BSD",
]);

const credentialPatterns = [
  {
    id: "private-key",
    pattern: new RegExp(["-----BEGIN", "(?: RSA| EC| OPENSSH)?", " PRIVATE KEY-----"].join(""), "u"),
  },
  {
    id: "aws-access-key",
    pattern: new RegExp(["\\bAK", "IA[0-9A-Z]{16}\\b"].join(""), "u"),
  },
  {
    id: "github-token",
    pattern: new RegExp(["\\bgh", "[oprsu]_[A-Za-z0-9]{36,255}\\b"].join(""), "u"),
  },
  {
    id: "npm-token",
    pattern: new RegExp(["\\bnpm", "_[A-Za-z0-9]{36}\\b"].join(""), "u"),
  },
  {
    id: "openai-key",
    pattern: new RegExp(["\\bsk", "-[A-Za-z0-9_-]{40,}\\b"].join(""), "u"),
  },
];

export async function auditSourceRelease(rootPath) {
  const root = resolve(rootPath);
  const manifest = await readJson(join(root, "package.json"));
  const lock = await readJson(join(root, "package-lock.json"));
  const candidateFiles = await gitLines(
    root,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    "\0",
  );
  const remotes = await gitLines(root, ["remote", "-v"]);
  const status = await gitLines(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const dependencies = dependencyLicenseInventory(lock);
  const protectedPaths = candidateFiles.filter(isProtectedTrackedPath);
  const credentialFindings = await scanCandidateCredentials(root, candidateFiles);
  const packageMetadata = await packageReleaseMetadata(root);
  const licenseText = await readOptional(join(root, "LICENSE"));
  const contributing = await readOptional(join(root, "CONTRIBUTING.md"));
  const security = await readOptional(join(root, "SECURITY.md"));
  const governance = await readOptional(join(root, "GOVERNANCE.md"));
  const conduct = await readOptional(join(root, "CODE_OF_CONDUCT.md"));

  const engineeringChecks = [
    check(
      "root-private",
      manifest.private === true,
      manifest.private === true
        ? "root package is protected by private: true"
        : "root package must remain private to prevent accidental monorepo publication",
    ),
    check(
      "lockfile-version",
      Number(lock.lockfileVersion) >= 3 && lock.version === manifest.version,
      `lockfileVersion=${lock.lockfileVersion ?? "missing"}; root=${manifest.version}; lock=${lock.version ?? "missing"}`,
    ),
    check(
      "tracked-protected-state",
      protectedPaths.length === 0,
      protectedPaths.length === 0
        ? `${candidateFiles.length} candidate files contain no protected runtime or generated paths`
        : `protected tracked paths: ${protectedPaths.join(", ")}`,
    ),
    check(
      "tracked-credential-material",
      credentialFindings.length === 0,
      credentialFindings.length === 0
        ? "no high-confidence credential material found in candidate text files"
        : `credential-shaped material: ${credentialFindings.map((finding) => `${finding.path} (${finding.kind})`).join(", ")}`,
    ),
    check(
      "dependency-license-inventory",
      dependencies.every((dependency) => dependency.accepted),
      dependencies.every((dependency) => dependency.accepted)
        ? `${dependencies.length} external lockfile packages use reviewed SPDX licenses`
        : `unreviewed dependency licenses: ${dependencies
          .filter((dependency) => !dependency.accepted)
          .map((dependency) => `${dependency.name}@${dependency.version} (${dependency.license ?? "missing"})`)
          .join(", ")}`,
    ),
  ];

  const sourceOpenChecks = [
    check("license-file", licenseText.trim().length > 0, "maintainer-approved LICENSE must be present and non-empty"),
    check(
      "license-metadata",
      typeof manifest.license === "string"
        && manifest.license.length > 0
        && packageMetadata.every((entry) => entry.license === manifest.license),
      manifest.license
        ? `root license=${manifest.license}; package metadata must match`
        : "root and public package manifests need the approved license identifier",
    ),
    check(
      "repository-metadata",
      Boolean(manifest.repository?.url)
        && packageMetadata.every((entry) => entry.repository?.url && entry.repository?.directory),
      manifest.repository?.url
        ? `${manifest.repository.url}; every package needs repository.url and repository.directory`
        : "root and public package manifests need canonical repository metadata",
    ),
    check(
      "canonical-remote",
      remotes.length > 0,
      remotes.length > 0 ? [...new Set(remotes)].join(", ") : "no Git remote configured",
    ),
    check("contributing", contributing.trim().length > 0, "CONTRIBUTING.md must be present and non-empty"),
    check("security-policy", security.trim().length > 0, "SECURITY.md must be present and non-empty"),
    check(
      "security-reporting-destination",
      hasRealSecurityDestination(security),
      "SECURITY.md must name a real private mailto: or HTTPS reporting destination",
    ),
    check("governance", governance.trim().length > 0, "GOVERNANCE.md must be present and non-empty"),
    check(
      "community-conduct",
      conduct.trim().length > 0 || /explicitly do not adopt a separate code of conduct/iu.test(governance),
      "add CODE_OF_CONDUCT.md or record an explicit governance decision not to adopt one",
    ),
  ];

  const candidateChecks = [
    check(
      "clean-candidate",
      status.length === 0,
      status.length === 0
        ? "candidate commit has no tracked or untracked worktree changes"
        : `${status.length} worktree entries must be committed or intentionally removed before archiving`,
    ),
  ];
  const engineeringReady = engineeringChecks.every(({ pass }) => pass);
  const sourceOpenReady = engineeringReady && sourceOpenChecks.every(({ pass }) => pass);
  const archiveReady = sourceOpenReady && candidateChecks.every(({ pass }) => pass);

  return {
    type: "qi.source-release-audit",
    schemaVersion: 1,
    release: manifest.version,
    engineeringReady,
    sourceOpen: sourceOpenReady ? "ready" : "blocked",
    archive: archiveReady ? "ready" : "blocked",
    checks: {
      engineering: engineeringChecks,
      sourceOpen: sourceOpenChecks,
      candidate: candidateChecks,
    },
    dependencies,
    blockers: [...engineeringChecks, ...sourceOpenChecks, ...candidateChecks]
      .filter(({ pass }) => !pass)
      .map(({ id, detail }) => ({ id, detail })),
  };
}

export function dependencyLicenseInventory(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => path.startsWith("node_modules/") && entry?.link !== true)
    .map(([path, entry]) => ({
      name: path.slice("node_modules/".length),
      version: entry.version ?? "unknown",
      license: typeof entry.license === "string" ? entry.license : null,
      development: entry.dev === true,
      optional: entry.optional === true,
      accepted: typeof entry.license === "string" && acceptedDependencyLicenses.has(entry.license),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function packageReleaseMetadata(root) {
  const packageRoot = join(root, "packages");
  const directories = (await readdir(packageRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(directories.map(async (directory) => {
    const path = `packages/${directory}/package.json`;
    const manifest = await readJson(join(packageRoot, directory, "package.json"));
    return {
      name: manifest.name,
      license: manifest.license,
      repository: manifest.repository,
      path,
    };
  }));
}

async function scanCandidateCredentials(root, paths) {
  const findings = [];
  for (const path of paths) {
    if (!path || isCredentialScanExcluded(path)) continue;
    const absolute = join(root, fromGitPath(path));
    let bytes;
    try {
      bytes = await readFile(absolute);
    } catch {
      continue;
    }
    if (bytes.byteLength > 4 * 1024 * 1024 || bytes.includes(0)) continue;
    const content = bytes.toString("utf8");
    for (const { id, pattern } of credentialPatterns) {
      if (pattern.test(content)) findings.push({ path, kind: id });
    }
  }
  return findings;
}

function isProtectedTrackedPath(path) {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith(".qi/skills/")) return false;
  if (normalized === ".env.example") return false;
  if (/(^|\/)(?:node_modules|dist|coverage|\.artifacts|\.cli-package|\.release)(?:\/|$)/u.test(normalized)) {
    return true;
  }
  if (normalized === ".qi" || normalized.startsWith(".qi/")) return true;
  if (/(^|\/)\.env(?:\.|$)/u.test(normalized)) return true;
  return /(?:\.tsbuildinfo|\.sqlite(?:3)?|\.db|\.pem|\.p12|\.pfx|\.key)$/iu.test(normalized);
}

function isCredentialScanExcluded(path) {
  const extension = posix.extname(path.toLowerCase());
  return new Set([
    ".avif", ".gif", ".gz", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".tar", ".webp", ".zip",
  ]).has(extension);
}

function hasRealSecurityDestination(content) {
  const destination = content.match(/(?:mailto:[^\s)>]+|https:\/\/[^\s)>]+)/iu)?.[0];
  if (!destination) return false;
  return !/(?:example\.(?:com|org|net)|example\.invalid|localhost|your[-_. ]|todo|tbd)/iu.test(destination)
    && !/absence of a configured private reporting destination is an open-source release blocker/iu.test(content);
}

function fromGitPath(path) {
  return sep === "/" ? path : path.replaceAll("/", sep);
}

function check(id, pass, detail) {
  return { id, pass, detail };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readOptional(path) {
  try {
    await access(path, constants.R_OK);
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function gitLines(root, args, separator = /\r?\n/u) {
  const { stdout } = await run("git", args, root);
  return stdout.split(separator).map((line) => line.trim()).filter(Boolean);
}

export function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
  });
}
