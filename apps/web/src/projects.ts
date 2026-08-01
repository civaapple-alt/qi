import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EventStore, SessionSummary } from "@civaapple/qi-agent/kernel";
import { projectPaths } from "@civaapple/qi-node/paths";
import { SessionRepository } from "@civaapple/qi-node/storage";

export const PROJECT_SESSIONS_DIRECTORY = "sessions";

export interface WebProjectSummary {
  readonly id: string;
  readonly path: string;
  readonly sessionsPath: string;
  readonly updatedAt: string;
}

export async function listWebProjects(projectsRoot: string): Promise<WebProjectSummary[]> {
  const root = resolve(projectsRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const projects: WebProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    try {
      const descriptor = JSON.parse(await readFile(join(path, "project.json"), "utf8")) as {
        schemaVersion?: unknown;
        projectId?: unknown;
        workspaceRoot?: unknown;
      };
      if (
        descriptor.schemaVersion !== 2
        || descriptor.projectId !== entry.name
        || typeof descriptor.workspaceRoot !== "string"
      ) continue;
      const sessionsPath = join(path, PROJECT_SESSIONS_DIRECTORY);
      const databaseFiles = [
        ...await sessionDatabaseFiles(sessionsPath),
        ...await sessionDatabaseFiles(join(path, "archives")),
      ];
      if (databaseFiles.length === 0) continue;
      const mtimes = await Promise.all(databaseFiles.map(async (file) => (await stat(file)).mtimeMs));
      projects.push({
        id: entry.name,
        path,
        sessionsPath,
        updatedAt: new Date(Math.max(...mtimes)).toISOString(),
      });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
  return projects.sort((left, right) => {
    const byTime = right.updatedAt.localeCompare(left.updatedAt);
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });
}

/** Opens and caches read-only Sqlite stores for project databases under one root. */
export class ProjectEventStoreRegistry {
  readonly #root: string;
  readonly #stores = new Map<string, SessionRepository>();

  constructor(projectsRoot: string) {
    this.#root = resolve(projectsRoot);
  }

  get projectsRoot(): string {
    return this.#root;
  }

  async list(): Promise<WebProjectSummary[]> {
    return listWebProjects(this.#root);
  }

  async open(projectId: string): Promise<EventStore> {
    const existing = this.#stores.get(projectId);
    if (existing) return existing;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectId)) {
      throw new TypeError(`Unknown project: ${projectId}`);
    }
    const projectPath = join(this.#root, projectId);
    let descriptor: { schemaVersion?: unknown; projectId?: unknown; workspaceRoot?: unknown };
    try {
      descriptor = JSON.parse(await readFile(join(projectPath, "project.json"), "utf8")) as {
        schemaVersion?: unknown;
        projectId?: unknown;
        workspaceRoot?: unknown;
      };
    } catch (error) {
      if (isMissing(error)) throw new TypeError(`Unknown project: ${projectId}`);
      throw error;
    }
    if (
      descriptor.schemaVersion !== 2
      || descriptor.projectId !== projectId
      || typeof descriptor.workspaceRoot !== "string"
    ) {
      throw new TypeError(`Unknown project: ${projectId}`);
    }
    const store = new SessionRepository(projectPaths({
      workspaceRoot: descriptor.workspaceRoot,
      dataRoot: projectPath,
    }));
    this.#stores.set(projectId, store);
    return store;
  }

  async listSessions(projectId: string): Promise<SessionSummary[]> {
    const store = await this.open(projectId);
    return store.listSessions();
  }

  close(): void {
    for (const store of this.#stores.values()) store.close();
    this.#stores.clear();
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function sessionDatabaseFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("ses_")) continue;
      const file = join(root, entry.name, "state", "qi.sqlite");
      try {
        if ((await stat(file)).isFile()) files.push(file);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return files;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}
