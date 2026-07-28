import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { findTrustedExecutable, loadVerificationProfiles, type VerificationProfile } from "./builtins.js";
import { ToolFailure } from "@civaapple/qi-agent/tools";
import { resolveWorkspacePath } from "./workspace.js";

export interface VerificationCandidate {
  readonly name: string;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly source: "package.json" | "pom.xml" | "AGENTS.md" | "README.md";
  /** Whether `command` resolves on PATH or in the Workspace; unresolvable candidates should stay unselectable. */
  readonly available: boolean;
  /** Preselected in a guided setup UI. Doc-scanned candidates always start unchecked (lower confidence). */
  readonly recommended: boolean;
}

const docScanSizeLimitBytes = 256 * 1024;
const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const allowedDocCommands = new Set([
  "npm", "pnpm", "yarn", "bun", "node", "mvn", "mvnw", "gradle", "gradlew",
  "go", "cargo", "pytest", "python", "python3", "make", "tox", "dotnet",
]);
const disallowedNpmScripts = new Set(["start", "dev", "serve", "watch"]);

/**
 * Scans package manifests (as `prepareVerificationProfiles` already infers) and, additionally, AGENTS.md and
 * README.md fenced code blocks for candidate verification commands. Nothing here writes a manifest; every
 * candidate is a proposal for a human to review with `writeVerificationManifest`.
 */
export async function scanVerificationCandidates(workspaceRoot: string): Promise<VerificationCandidate[]> {
  const candidates: VerificationCandidate[] = [];
  const seen = new Set<string>();
  const usedNames = new Set<string>();

  const packageManifest = await readPackageManifestCandidates(workspaceRoot);
  if (packageManifest) {
    const manager = await inferPackageManagerCandidates(workspaceRoot, packageManifest.packageManager);
    for (const name of ["test", "typecheck", "lint", "check", "build"] as const) {
      const script = packageManifest.scripts?.[name];
      if (typeof script !== "string" || !script.trim()) continue;
      await pushCandidate(candidates, seen, usedNames, workspaceRoot, {
        name,
        description: `Run the repository "${name}" script inferred from package.json`,
        command: manager,
        args: ["run", name],
        source: "package.json",
        recommended: name !== "build",
      });
    }
  }
  if (await pathExists(resolve(workspaceRoot, "pom.xml"))) {
    await pushCandidate(candidates, seen, usedNames, workspaceRoot, {
      name: "maven-test",
      description: "Run the Maven test lifecycle inferred from pom.xml",
      command: "mvn",
      args: ["-q", "test"],
      source: "pom.xml",
      recommended: true,
    });
  }

  for (const doc of ["AGENTS.md", "README.md"] as const) {
    for (const found of await scanDocument(workspaceRoot, doc)) {
      await pushCandidate(candidates, seen, usedNames, workspaceRoot, found);
    }
  }
  return candidates;
}

interface RawCandidate {
  name: string;
  description: string;
  command: string;
  args: readonly string[];
  source: VerificationCandidate["source"];
  recommended: boolean;
}

async function pushCandidate(
  candidates: VerificationCandidate[],
  seen: Set<string>,
  usedNames: Set<string>,
  workspaceRoot: string,
  raw: RawCandidate,
): Promise<void> {
  const key = `${raw.command} ${raw.args.join(" ")}`;
  if (seen.has(key)) return;
  seen.add(key);
  const name = uniqueName(raw.name, usedNames);
  usedNames.add(name);
  const available = (await findTrustedExecutable(raw.command, workspaceRoot)) !== undefined;
  candidates.push(Object.freeze({
    name,
    description: raw.description,
    command: raw.command,
    args: Object.freeze([...raw.args]),
    source: raw.source,
    available,
    recommended: raw.recommended,
  }));
}

function uniqueName(base: string, used: ReadonlySet<string>): string {
  const normalized = namePattern.test(base) ? base : `doc-${base.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+/, "")}`;
  const safe = namePattern.test(normalized) ? normalized : "doc-command";
  if (!used.has(safe)) return safe;
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${safe}-${index}`;
    if (candidate.length <= 64 && !used.has(candidate)) return candidate;
  }
  return `${safe}-${randomUUID().slice(0, 8)}`;
}

async function scanDocument(
  workspaceRoot: string,
  fileName: "AGENTS.md" | "README.md",
): Promise<RawCandidate[]> {
  const path = resolve(workspaceRoot, fileName);
  let info;
  try {
    info = await lstat(path);
  } catch {
    return [];
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > docScanSizeLimitBytes) return [];
  const content = await readFile(path, "utf8");
  const lines = content.split(/\r\n|\r|\n/);
  const found: RawCandidate[] = [];
  let heading = "";
  let inFence = false;
  let fenceCommandIndex = 0;
  for (const rawLine of lines) {
    const fenceMatch = /^\s*```/.exec(rawLine);
    if (fenceMatch) {
      inFence = !inFence;
      if (inFence) fenceCommandIndex = 0;
      continue;
    }
    if (!inFence) {
      const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(rawLine);
      if (headingMatch?.[1]) heading = headingMatch[1];
      continue;
    }
    const tokens = candidateTokens(rawLine);
    if (!tokens) continue;
    const normalizedCommand = tokens[0]!.replace(/^\.\//, "").replace(/\.(sh|bat|cmd|exe)$/i, "");
    if (!allowedDocCommands.has(normalizedCommand)) continue;
    if (["npm", "pnpm", "yarn", "bun"].includes(normalizedCommand)) {
      const subcommand = tokens[1];
      if (!subcommand) continue;
      if (disallowedNpmScripts.has(subcommand.toLowerCase())) continue;
      if (subcommand === "run" && tokens[2] && disallowedNpmScripts.has(tokens[2].toLowerCase())) continue;
    }
    fenceCommandIndex += 1;
    const slug = slugify(heading) || "doc-command";
    found.push({
      name: fenceCommandIndex > 1 ? `${slug}-${fenceCommandIndex}` : slug,
      description: `Found in ${fileName}${heading ? ` under "${heading}"` : ""}: ${tokens.join(" ")}`,
      command: normalizedCommand,
      args: tokens.slice(1),
      source: fileName,
      recommended: false,
    });
  }
  return found;
}

function candidateTokens(rawLine: string): string[] | undefined {
  let line = rawLine.trim();
  if (!line || line.startsWith("#")) return undefined;
  if (line.startsWith("$")) line = line.slice(1).trim();
  if (!line) return undefined;
  if (/[|&;<>`]/.test(line) || line.includes("$(")) return undefined;
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  if (tokens.length === 0 || tokens.length > 6) return undefined;
  return tokens;
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "";
  return /^[a-z]/.test(slug) ? slug : `doc-${slug}`;
}

async function readPackageManifestCandidates(workspaceRoot: string): Promise<{
  packageManager?: string;
  scripts?: Record<string, unknown>;
} | undefined> {
  const path = resolve(workspaceRoot, "package.json");
  if (!(await pathExists(path))) return undefined;
  const info = await stat(path);
  if (!info.isFile() || info.size > 1024 * 1024) return undefined;
  try {
    const decoded = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
    const record = decoded as Record<string, unknown>;
    return {
      ...(typeof record.packageManager === "string" ? { packageManager: record.packageManager } : {}),
      ...(typeof record.scripts === "object" && record.scripts !== null && !Array.isArray(record.scripts)
        ? { scripts: record.scripts as Record<string, unknown> }
        : {}),
    };
  } catch {
    return undefined;
  }
}

async function inferPackageManagerCandidates(workspaceRoot: string, declared: string | undefined): Promise<string> {
  const declaredName = declared?.split("@", 1)[0];
  if (declaredName === "npm" || declaredName === "pnpm" || declaredName === "yarn" || declaredName === "bun") {
    return declaredName;
  }
  if (await pathExists(resolve(workspaceRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(resolve(workspaceRoot, "yarn.lock"))) return "yarn";
  if (await pathExists(resolve(workspaceRoot, "bun.lock")) || await pathExists(resolve(workspaceRoot, "bun.lockb"))) {
    return "bun";
  }
  return "npm";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Writes a human-selected set of candidates to `.qi/qi.verify.json` and returns the freshly loaded, frozen
 * profiles (validated identically to the automatic inference path via `loadVerificationProfiles`).
 */
export async function writeVerificationManifest(
  workspaceRoot: string,
  selected: readonly Pick<VerificationCandidate, "name" | "description" | "command" | "args"> [],
): Promise<readonly VerificationProfile[]> {
  if (selected.length === 0) {
    throw new ToolFailure("VERIFY_SETUP_EMPTY", "Select at least one verification profile before applying");
  }
  const names = new Set<string>();
  const profiles: Record<string, { description: string; command: string; args: string[]; timeoutMs: number }> = {};
  for (const candidate of selected) {
    if (!namePattern.test(candidate.name)) {
      throw new ToolFailure("VERIFY_SETUP_INVALID_NAME", `Invalid verification profile name: ${candidate.name}`);
    }
    if (names.has(candidate.name)) {
      throw new ToolFailure("VERIFY_SETUP_DUPLICATE_NAME", `Duplicate verification profile name: ${candidate.name}`);
    }
    names.add(candidate.name);
    profiles[candidate.name] = {
      description: candidate.description,
      command: candidate.command,
      args: [...candidate.args],
      timeoutMs: 120_000,
    };
  }
  await ensurePrivateQiDirectory(workspaceRoot);
  const manifestPath = ".qi/qi.verify.json";
  const target = await resolveWorkspacePath(workspaceRoot, manifestPath, true, true);
  await atomicWriteText(target, `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`);
  return loadVerificationProfiles(workspaceRoot, manifestPath);
}

async function ensurePrivateQiDirectory(workspaceRoot: string): Promise<void> {
  const directory = resolve(workspaceRoot, ".qi");
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ToolFailure("INVALID_QI_DIRECTORY", ".qi must be a real directory, not a file or symbolic link");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(directory, { recursive: false });
      return;
    }
    throw error;
  }
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  const temporary = `${path}.qi-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
