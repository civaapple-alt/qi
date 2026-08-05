import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { x as extractTar } from "tar";
import { minimalHostEnvironment } from "../workspace/process.js";

export type ImmutableSkillSource =
  | { type: "git"; repository: string; commit: string; subdir: string }
  | { type: "github"; url: string; commit: string; subdir?: string }
  | { type: "archive"; url: string; sha256: string; subdir?: string };

export interface SkillSourceProvenance {
  type: "git" | "github" | "archive";
  resolved: string;
  commit?: string;
  sha256?: string;
  subdir: string;
}

export interface AcquiredSkillSource {
  root: string;
  provenance: SkillSourceProvenance;
  cleanup(): Promise<void>;
}

/** A human-selected GitHub Skill, resolved to the commit that will be locked. */
export interface ResolvedGithubSkillSource {
  readonly source: Extract<ImmutableSkillSource, { type: "github" }>;
  readonly skill: string;
}

const commitPattern = /^[0-9a-f]{40}$/i;
const sha256Pattern = /^(?:sha256:)?([0-9a-f]{64})$/i;
const maximumArchiveBytes = 64 * 1024 * 1024;
const maximumArchiveFileBytes = 8 * 1024 * 1024;
const maximumArchiveFiles = 512;
const maximumArchiveDepth = 16;

export async function acquireImmutableSkillSource(source: ImmutableSkillSource): Promise<AcquiredSkillSource> {
  const staging = await mkdtemp(resolve(tmpdir(), "qi-skill-source-"));
  try {
    if (source.type === "archive") return await acquireArchive(source, staging);
    const normalized = source.type === "github" ? githubSource(source) : source;
    if (!commitPattern.test(normalized.commit)) throw new TypeError("Git Skill sources require an exact 40-character commit");
    assertRelativeSubdir(normalized.subdir);
    const checkout = resolve(staging, "checkout");
    await runGit(["clone", "--no-checkout", "--filter=blob:none", "--", normalized.repository, checkout]);
    // Named Skills normally occupy a small directory inside a larger repository. Sparse checkout
    // keeps the immutable acquisition bounded to that declared tree instead of materializing the
    // rest of (for example) a component library repository.
    if (normalized.subdir !== ".") {
      await runGit(["-C", checkout, "sparse-checkout", "init", "--no-cone"]);
      await runGit(["-C", checkout, "sparse-checkout", "set", "--no-cone", `${normalized.subdir}/**`]);
    }
    await runGit(["-C", checkout, "checkout", "--detach", normalized.commit]);
    const actual = (await runGit(["-C", checkout, "rev-parse", "HEAD"])).trim();
    if (actual.toLowerCase() !== normalized.commit.toLowerCase()) throw new Error("Git checkout did not resolve to the pinned commit");
    return {
      root: resolve(checkout, normalized.subdir),
      provenance: {
        type: source.type,
        resolved: normalized.repository,
        commit: normalized.commit.toLowerCase(),
        subdir: normalized.subdir,
      },
      cleanup: () => removeStaging(staging),
    };
  } catch (error) {
    await removeStaging(staging).catch(() => undefined);
    throw error;
  }
}

/**
 * Resolve GitHub HEAD before acquisition. The resulting immutable source is what gets written to
 * the Skill lock, so a later install or Run never follows a moving branch name.
 *
 * The usual Skills layout is `skills/<name>`. A repository with a different layout can supply a
 * contained `subdir`; SkillCatalog still verifies the frontmatter name before it is installed.
 */
export async function resolveGithubSkillSource(
  url: string,
  skill: string,
  options: { subdir?: string } = {},
): Promise<ResolvedGithubSkillSource> {
  const normalized = githubSource({ type: "github", url, commit: "0".repeat(40), subdir: "." });
  if (!skill || /[\\/]/.test(skill) || skill === "." || skill === "..") {
    throw new TypeError("GitHub Skill name must be a single Skill directory name");
  }
  const output = await runGit(["ls-remote", normalized.repository, "HEAD"]);
  const commit = /^([0-9a-f]{40})\s+HEAD\s*$/im.exec(output)?.[1];
  if (!commit) throw new Error("GitHub repository did not return an exact HEAD commit");
  const subdir = options.subdir ?? `skills/${skill}`;
  assertRelativeSubdir(subdir);
  return {
    skill,
    source: { type: "github", url, commit: commit.toLowerCase(), subdir },
  };
}

/** Git may briefly retain a pack handle on Windows after checkout. Let the OS release it before retrying. */
async function removeStaging(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

async function acquireArchive(source: Extract<ImmutableSkillSource, { type: "archive" }>, staging: string): Promise<AcquiredSkillSource> {
  const url = new URL(source.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new TypeError("Skill archive URL must be credential-free HTTPS");
  const match = sha256Pattern.exec(source.sha256);
  if (!match) throw new TypeError("Skill archives require an exact SHA-256");
  const subdir = source.subdir ?? ".";
  assertRelativeSubdir(subdir);
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`Skill archive request failed: ${response.status}`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumArchiveBytes) throw new Error(`Skill archive exceeds ${maximumArchiveBytes} bytes`);
    chunks.push(buffer);
  }
  const archive = Buffer.concat(chunks);
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== match[1]!.toLowerCase()) throw new Error("Skill archive SHA-256 mismatch");
  const archivePath = resolve(staging, `${randomUUID()}.tgz`);
  const unpacked = resolve(staging, "unpacked");
  await mkdir(unpacked);
  await writeFile(archivePath, archive, { flag: "wx" });
  let expandedBytes = 0;
  let expandedFiles = 0;
  await extractTar({
    file: archivePath,
    cwd: unpacked,
    strict: true,
    preservePaths: false,
    filter: (path, entry) => {
      assertArchivePath(path);
      const type = (entry as { type?: string }).type;
      if (type !== "File" && type !== "Directory") throw new Error(`Skill archive refuses ${type ?? "unknown"} entry ${path}`);
      if (type === "File") {
        const size = Number((entry as { size?: number }).size ?? 0);
        if (!Number.isSafeInteger(size) || size < 0 || size > maximumArchiveFileBytes) throw new Error(`Skill archive entry ${path} exceeds its size bound`);
        expandedFiles += 1; expandedBytes += size;
        if (expandedFiles > maximumArchiveFiles || expandedBytes > maximumArchiveBytes) throw new Error("Skill archive expanded tree exceeds its bound");
      }
      return true;
    },
  });
  return {
    root: resolve(unpacked, subdir),
    provenance: { type: "archive", resolved: url.toString(), sha256: digest, subdir },
    cleanup: () => removeStaging(staging),
  };
}

function githubSource(source: Extract<ImmutableSkillSource, { type: "github" }>): Extract<ImmutableSkillSource, { type: "git" }> {
  const url = new URL(source.url);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password) {
    throw new TypeError("GitHub Skill source must be a credential-free https://github.com URL");
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) throw new TypeError("GitHub Skill source must identify owner/repository");
  return {
    type: "git",
    repository: `https://github.com/${parts[0]}/${parts[1]!.replace(/\.git$/i, "")}.git`,
    commit: source.commit,
    subdir: source.subdir ?? ".",
  };
}

function assertRelativeSubdir(subdir: string): void {
  if (!subdir || subdir.startsWith("/") || /^[A-Za-z]:/.test(subdir) || subdir.split(/[\\/]/).includes("..")) {
    throw new TypeError("Skill source subdir must be a contained relative path");
  }
}

function assertArchivePath(path: string): void {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || parts.includes("..") || parts.length > maximumArchiveDepth) {
    throw new Error(`Skill archive contains unsafe path: ${path}`);
  }
  for (const part of parts) {
    if (!part || part === "." || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part)) throw new Error(`Skill archive contains non-portable path: ${path}`);
    const stem = part.split(".")[0]!.toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) throw new Error(`Skill archive contains Windows reserved path: ${path}`);
  }
}

function runGit(args: readonly string[]): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const environment = minimalHostEnvironment({ GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
    // GitHub access is commonly routed through a local desktop proxy on Windows. Preserve only
    // credential-free loopback proxy URLs; the general child environment remains scrubbed.
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const) {
      const value = process.env[name];
      if (value !== undefined && isSafeLocalProxySetting(name, value)) environment[name] = value;
    }
    const child = spawn("git", ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (operation: () => void) => { if (settled) return; settled = true; clearTimeout(timer); operation(); };
    const timer = setTimeout(() => { child.kill(); finish(() => reject(new Error("Git Skill acquisition timed out after 120000 ms"))); }, 120_000);
    timer.unref();
    const append = (target: Buffer[], chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > 4 * 1024 * 1024) { child.kill(); finish(() => reject(new Error("Git Skill acquisition output exceeded its bound"))); return; }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => code === 0
      ? resolveRun(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(`git exited ${String(code)}: ${Buffer.concat(stderr).toString("utf8").slice(-4_096)}`))));
  });
}

function isSafeLocalProxySetting(name: string, value: string): boolean {
  if (name === "NO_PROXY") return true;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
