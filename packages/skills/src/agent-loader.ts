import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseFrontmatter, requireString } from "./frontmatter.js";
import { SkillLoader, type SkillSummary } from "./skill-loader.js";

export interface AgentDefinition {
  root: string;
  name: string;
  version: string;
  defaultModel: string;
  memoryScope: string;
  constitution: string;
  estimatedPromptTokens: number;
  dynamicConfigPath?: string;
  skills: SkillSummary[];
  evals: string[];
  policies: string[];
  fixtures: string[];
}

export async function loadAgentDefinition(root: string, skillLoader = new SkillLoader()): Promise<AgentDefinition> {
  const requestedRoot = resolve(root);
  if ((await lstat(requestedRoot)).isSymbolicLink()) throw new Error("Agent root must not be a symbolic link");
  const actualRoot = await realpath(requestedRoot);
  const markdownPath = resolve(actualRoot, "agent.md");
  const info = await stat(markdownPath);
  if (info.size > 1_000_000) throw new Error("agent.md exceeds 1 MB");
  const content = await readFile(markdownPath, "utf8");
  const parsed = parseFrontmatter<Record<string, unknown>>(content, "agent.md");
  const name = requireString(parsed.metadata.name, "name", "agent.md");
  const version = String(parsed.metadata.version ?? "").trim();
  if (!version) throw new TypeError("agent.md.version is required");
  const defaultModel = requireString(parsed.metadata.default_model, "default_model", "agent.md");
  const memoryScope = requireString(parsed.metadata.memory_scope, "memory_scope", "agent.md");
  const skillsRoot = resolve(actualRoot, "skills");
  const skills = await skillLoader.discover(skillsRoot).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const dynamicConfigPath = await exists(resolve(actualRoot, "agent.ts")) ? resolve(actualRoot, "agent.ts") : undefined;
  return {
    root: actualRoot,
    name,
    version,
    defaultModel,
    memoryScope,
    constitution: parsed.body,
    estimatedPromptTokens: Math.ceil(parsed.body.length / 4),
    ...(dynamicConfigPath === undefined ? {} : { dynamicConfigPath }),
    skills,
    evals: await listFiles(resolve(actualRoot, "evals"), actualRoot),
    policies: await listFiles(resolve(actualRoot, "policies"), actualRoot),
    fixtures: await listFiles(resolve(actualRoot, "fixtures"), actualRoot),
  };
}

async function listFiles(directory: string, root: string): Promise<string[]> {
  return readdir(directory, { withFileTypes: true }).then(
    (entries) => entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink()).map((entry) => resolve(directory, entry.name).slice(root.length + 1).replaceAll("\\", "/")).sort(),
    (error: unknown) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}
