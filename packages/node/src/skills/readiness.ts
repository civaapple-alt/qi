import { delimiter, extname, isAbsolute, resolve } from "node:path";
import { access } from "node:fs/promises";
import type { LoadedSkill } from "./skill-loader.js";

export interface SkillRequirementStatus {
  kind: "executable" | "mcp" | "compatibility";
  id: string;
  available: boolean;
  source: "metadata" | "allowed-tools" | "frontmatter";
  message: string;
}

export async function evaluateSkillReadiness(
  skill: Pick<LoadedSkill, "compatibility" | "metadata" | "allowedTools">,
  options: {
    environment?: Readonly<Record<string, string | undefined>>;
    mcpBindings?: readonly string[];
  } = {},
): Promise<readonly SkillRequirementStatus[]> {
  const environment = options.environment ?? process.env;
  const executableNames = new Set<string>();
  for (const name of splitRequirements(skill.metadata["qi.required-executables"])) executableNames.add(name);
  for (const name of extractAllowedToolExecutables(skill.allowedTools)) executableNames.add(name);
  const mcpNames = new Set(splitRequirements(skill.metadata["qi.required-mcp"]));
  for (const name of extractAllowedMcpTools(skill.allowedTools)) mcpNames.add(name);
  const bound = new Set(options.mcpBindings ?? []);
  const statuses: SkillRequirementStatus[] = [];
  for (const id of [...executableNames].sort()) {
    const available = await executableOnPath(id, environment);
    statuses.push({
      kind: "executable", id, available,
      source: skill.metadata["qi.required-executables"]?.includes(id) ? "metadata" : "allowed-tools",
      message: available ? `${id} is available` : `${id} is not available; Qi will not install it automatically`,
    });
  }
  for (const id of [...mcpNames].sort()) {
    const available = bound.has(id);
    statuses.push({
      kind: "mcp", id, available,
      source: skill.metadata["qi.required-mcp"]?.includes(id) ? "metadata" : "allowed-tools",
      message: available ? `${id} is reviewed and bound` : `${id} is not reviewed and bound`,
    });
  }
  if (skill.compatibility) {
    statuses.push({
      kind: "compatibility", id: "declared", available: true, source: "frontmatter",
      message: skill.compatibility,
    });
  }
  return statuses;
}

function splitRequirements(value: string | undefined): string[] {
  return value?.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean) ?? [];
}

function extractAllowedToolExecutables(value: string | undefined): string[] {
  if (!value) return [];
  const found = new Set<string>();
  for (const match of value.matchAll(/\b(?:Bash|Shell)\(([^:()\s]+)(?::[^)]*)?\)/g)) {
    const command = match[1]!;
    if (!new Set(["npx", "npm", "pnpm", "yarn", "bash", "sh", "pwsh", "powershell", "cmd"]).has(command)) found.add(command);
  }
  return [...found];
}

function extractAllowedMcpTools(value: string | undefined): string[] {
  return value?.match(/\bmcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+\b/g) ?? [];
}

async function executableOnPath(command: string, environment: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  if (command === "agent-browser" && environment.QI_AGENT_BROWSER_BIN) {
    return access(resolve(environment.QI_AGENT_BROWSER_BIN)).then(() => true, () => false);
  }
  if (isAbsolute(command)) return access(command).then(() => true, () => false);
  const path = environment.PATH ?? environment.Path ?? "";
  const extensions = process.platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const suffix = extname(command) ? "" : extension.toLowerCase();
      if (await access(resolve(directory, `${command}${suffix}`)).then(() => true, () => false)) return true;
    }
  }
  return false;
}
