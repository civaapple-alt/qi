import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EventStore, SessionSummary } from "@civaapple/qi-agent/kernel";
import { SqliteEventStore } from "@civaapple/qi-node/storage";

export const PROJECT_DB_NAME = "state/qi.sqlite";

export interface WebProjectSummary {
  readonly id: string;
  readonly path: string;
  readonly dbPath: string;
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
    const dbPath = join(path, "state", "qi.sqlite");
    try {
      const descriptor = JSON.parse(await readFile(join(path, "project.json"), "utf8")) as {
        projectId?: unknown;
        workspaceRoot?: unknown;
      };
      if (descriptor.projectId !== entry.name || typeof descriptor.workspaceRoot !== "string") continue;
      const info = await stat(dbPath);
      if (!info.isFile()) continue;
      projects.push({
        id: entry.name,
        path,
        dbPath,
        updatedAt: info.mtime.toISOString(),
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
  readonly #stores = new Map<string, SqliteEventStore>();

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
    const projects = await this.list();
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new TypeError(`Unknown project: ${projectId}`);
    const store = new SqliteEventStore(project.dbPath, { readonly: true });
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
