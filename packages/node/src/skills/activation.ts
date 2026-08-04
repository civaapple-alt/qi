import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AgentSkillLockEntry {
  readonly skillPath: string;
  readonly skillFolderHash?: string;
  readonly [key: string]: unknown;
}

export interface AgentSkillLock {
  readonly version?: number;
  readonly skills?: Readonly<Record<string, AgentSkillLockEntry>>;
}

export interface AgentSkillActivation {
  readonly lockHash: string;
  readonly activatedAt: string;
}

export interface AgentSkillActivationState {
  readonly version: 1;
  readonly active: Readonly<Record<string, AgentSkillActivation>>;
}

export async function readAgentSkillLock(path: string): Promise<Readonly<Record<string, AgentSkillLockEntry>>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as AgentSkillLock;
    if (!parsed || typeof parsed !== "object" || !parsed.skills || typeof parsed.skills !== "object") return {};
    return Object.fromEntries(Object.entries(parsed.skills).filter(([, entry]) => isLockEntry(entry)));
  } catch {
    return {};
  }
}

export async function readAgentSkillActivations(path: string): Promise<Readonly<Record<string, AgentSkillActivation>>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AgentSkillActivationState>;
    if (parsed.version !== 1 || !parsed.active || typeof parsed.active !== "object") return {};
    return Object.fromEntries(Object.entries(parsed.active).filter(([, value]) => isActivation(value)));
  } catch {
    return {};
  }
}

export function agentSkillLockHash(entry: AgentSkillLockEntry): string {
  if (typeof entry.skillFolderHash === "string" && entry.skillFolderHash.length > 0) {
    return entry.skillFolderHash;
  }
  return `sha256:${createHash("sha256").update(stableJson(entry)).digest("hex")}`;
}

export async function writeAgentSkillActivations(
  path: string,
  active: Readonly<Record<string, AgentSkillActivation>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, active }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function isLockEntry(value: unknown): value is AgentSkillLockEntry {
  return Boolean(value && typeof value === "object" && typeof (value as { skillPath?: unknown }).skillPath === "string");
}

function isActivation(value: unknown): value is AgentSkillActivation {
  return Boolean(
    value && typeof value === "object" &&
      typeof (value as { lockHash?: unknown }).lockHash === "string" &&
      typeof (value as { activatedAt?: unknown }).activatedAt === "string",
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
