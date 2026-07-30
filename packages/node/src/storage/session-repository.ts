import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import {
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  sessionArchiveBlockers,
  type EventStore,
  type EventStream,
  type SessionSummary,
  type SessionView,
} from "@civaapple/qi-agent/kernel";
import { EventWriter } from "@civaapple/qi-agent/loop";
import type { SessionEvent, SessionId } from "@civaapple/qi-protocol";
import {
  projectSessionPaths,
  type ProjectPaths,
  type ProjectSessionPaths,
} from "../paths.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

export interface SessionCatalogEntry extends SessionSummary {
  readonly location: "active" | "archived";
  readonly lifecycle: SessionView["lifecycle"];
}

export interface ArchiveManifest {
  readonly schemaVersion: 1;
  readonly sessionId: SessionId;
  readonly archivedAt: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly size: number; readonly sha256: string }>;
}

export class SessionArchiveBlockedError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly blockers: readonly string[],
  ) {
    super(`Session ${sessionId} cannot be archived: ${blockers.join("; ")}`);
    this.name = "SessionArchiveBlockedError";
  }
}

/**
 * Routes active EventStore calls to one SQLite database per Session and owns
 * verified lifecycle moves between sessions/ and archives/.
 */
export class SessionRepository implements EventStore {
  readonly #paths: ProjectPaths;
  readonly #activeStores = new Map<SessionId, SqliteEventStore>();
  #closed = false;

  constructor(paths: ProjectPaths) {
    this.#paths = paths;
  }

  async recover(): Promise<void> {
    this.#assertOpen();
    for (const sessionId of this.#directorySessionIds(this.#paths.sessionsRoot)) {
      const view = this.load(sessionId);
      if (view?.lifecycle === "archive_pending" && view.lifecycleOperationId) {
        await this.#finishArchive(sessionId, view.lifecycleOperationId);
      } else if (view?.lifecycle === "restore_pending" && view.lifecycleOperationId) {
        new EventWriter(this, sessionId).append(
          "session.restored",
          { operationId: view.lifecycleOperationId },
          { kind: "runtime", id: "session-repository-recovery" },
        );
      }
    }
    for (const sessionId of this.#directorySessionIds(this.#paths.archivesRoot)) {
      const view = this.#loadAt(projectSessionPaths(this.#paths, sessionId, "archived"));
      if (view?.lifecycle === "restore_pending" && view.lifecycleOperationId) {
        await this.#finishRestore(sessionId, view.lifecycleOperationId);
      } else if (view?.lifecycle === "archive_pending" && view.lifecycleOperationId) {
        await this.#completeArchivedStream(sessionId, view.lifecycleOperationId);
      } else if (view?.lifecycle === "archived") {
        const paths = projectSessionPaths(this.#paths, sessionId, "archived");
        if (!existsSync(paths.archiveManifestFile)) await writeArchiveManifest(paths, sessionId);
      }
    }
    await this.#recoverReset();
  }

  append(sessionId: SessionId, expectedVersion: number, newEvents: readonly SessionEvent[]): SessionView {
    return this.#activeStore(sessionId).append(sessionId, expectedVersion, newEvents);
  }

  read(sessionId: SessionId, afterVersion = 0): EventStream {
    const directory = projectSessionPaths(this.#paths, sessionId);
    if (!existsSync(directory.databaseFile)) return { sessionId, version: 0, events: [] };
    return this.#activeStore(sessionId).read(sessionId, afterVersion);
  }

  load(sessionId: SessionId): SessionView | undefined {
    const directory = projectSessionPaths(this.#paths, sessionId);
    if (!existsSync(directory.databaseFile)) return undefined;
    return this.#activeStore(sessionId).load(sessionId);
  }

  listSessions(): SessionSummary[] {
    return this.listCatalog("active").map(({ location: _location, lifecycle: _lifecycle, ...summary }) => summary);
  }

  listCatalog(location?: "active" | "archived"): SessionCatalogEntry[] {
    const locations = location ? [location] as const : ["active", "archived"] as const;
    const entries: SessionCatalogEntry[] = [];
    for (const candidate of locations) {
      const root = candidate === "active" ? this.#paths.sessionsRoot : this.#paths.archivesRoot;
      for (const sessionId of this.#directorySessionIds(root)) {
        const paths = projectSessionPaths(this.#paths, sessionId, candidate);
        const store = candidate === "active"
          ? this.#activeStore(sessionId)
          : new SqliteEventStore(paths.databaseFile, { readonly: true });
        try {
          const summary = store.listSessions().find((item) => item.sessionId === sessionId);
          const view = store.load(sessionId);
          if (summary && view) entries.push({ ...summary, location: candidate, lifecycle: view.lifecycle });
        } finally {
          if (candidate === "archived") store.close();
        }
      }
    }
    return entries.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId));
  }

  readArchived(sessionId: SessionId): EventStream {
    const paths = projectSessionPaths(this.#paths, sessionId, "archived");
    if (!existsSync(paths.databaseFile)) return { sessionId, version: 0, events: [] };
    const store = new SqliteEventStore(paths.databaseFile, { readonly: true });
    try {
      return store.read(sessionId);
    } finally {
      store.close();
    }
  }

  archiveBlockers(sessionId: SessionId): string[] {
    const view = this.load(sessionId);
    if (!view) return [`Session ${sessionId} does not exist`];
    const blockers = sessionArchiveBlockers(view);
    blockers.push(...this.#activeWatcherBlockers(sessionId));
    return blockers;
  }

  async archive(sessionId: SessionId, reason = "Archived by user"): Promise<SessionCatalogEntry> {
    this.#assertOpen();
    const blockers = this.archiveBlockers(sessionId);
    if (blockers.length > 0) throw new SessionArchiveBlockedError(sessionId, blockers);
    const target = projectSessionPaths(this.#paths, sessionId, "archived");
    if (existsSync(target.root)) throw new Error(`Archive already exists: ${target.root}`);
    const operationId = `archive_${randomUUID()}`;
    new EventWriter(this, sessionId).append(
      "session.archive.requested",
      { operationId, reason },
      { kind: "user", id: "tui-user" },
    );
    await this.#finishArchive(sessionId, operationId);
    return this.listCatalog("archived").find((entry) => entry.sessionId === sessionId)!;
  }

  async restore(sessionId: SessionId): Promise<SessionCatalogEntry> {
    this.#assertOpen();
    const archived = projectSessionPaths(this.#paths, sessionId, "archived");
    const active = projectSessionPaths(this.#paths, sessionId, "active");
    if (!existsSync(archived.root)) throw new Error(`Archived Session not found: ${sessionId}`);
    if (existsSync(active.root)) throw new Error(`Active Session already exists: ${sessionId}`);
    await verifyArchiveManifest(archived);
    const operationId = `restore_${randomUUID()}`;
    const store = new SqliteEventStore(archived.databaseFile);
    try {
      new EventWriter(store, sessionId).append(
        "session.restore.requested",
        { operationId },
        { kind: "user", id: "tui-user" },
      );
    } finally {
      store.close();
    }
    await this.#finishRestore(sessionId, operationId);
    return this.listCatalog("active").find((entry) => entry.sessionId === sessionId)!;
  }

  async resetWorkspace(): Promise<readonly SessionId[]> {
    this.#assertOpen();
    const sessionIds = this.listSessions().map((entry) => entry.sessionId);
    const blocked = sessionIds.flatMap((sessionId) =>
      this.archiveBlockers(sessionId).map((reason) => `${sessionId}: ${reason}`));
    if (blocked.length > 0) throw new SessionArchiveBlockedError(sessionIds[0]!, blocked);
    const journal = {
      schemaVersion: 1,
      operationId: `reset_${randomUUID()}`,
      sessionIds,
      completed: [] as SessionId[],
    };
    await writeJsonAtomic(this.#resetJournalFile(), journal);
    for (const sessionId of sessionIds) {
      await this.archive(sessionId, "Workspace reset");
      journal.completed.push(sessionId);
      await writeJsonAtomic(this.#resetJournalFile(), journal);
    }
    await rm(this.#resetJournalFile(), { force: true });
    return sessionIds;
  }

  release(sessionId: SessionId): void {
    const store = this.#activeStores.get(sessionId);
    store?.close();
    this.#activeStores.delete(sessionId);
  }

  close(): void {
    if (this.#closed) return;
    for (const store of this.#activeStores.values()) store.close();
    this.#activeStores.clear();
    this.#closed = true;
  }

  #activeStore(sessionId: SessionId): SqliteEventStore {
    this.#assertOpen();
    const existing = this.#activeStores.get(sessionId);
    if (existing) return existing;
    const paths = projectSessionPaths(this.#paths, sessionId);
    mkdirSync(paths.stateRoot, { recursive: true });
    const store = new SqliteEventStore(paths.databaseFile);
    this.#activeStores.set(sessionId, store);
    return store;
  }

  async #finishArchive(sessionId: SessionId, operationId: string): Promise<void> {
    const active = projectSessionPaths(this.#paths, sessionId, "active");
    const archived = projectSessionPaths(this.#paths, sessionId, "archived");
    this.release(sessionId);
    if (existsSync(active.root) && !existsSync(archived.root)) {
      await rename(active.root, archived.root);
    }
    if (!existsSync(archived.root)) throw new Error(`Archive move lost Session ${sessionId}`);
    await this.#completeArchivedStream(sessionId, operationId);
  }

  async #completeArchivedStream(sessionId: SessionId, operationId: string): Promise<void> {
    const archived = projectSessionPaths(this.#paths, sessionId, "archived");
    const store = new SqliteEventStore(archived.databaseFile);
    try {
      const view = store.load(sessionId);
      if (view?.lifecycle === "archive_pending") {
        new EventWriter(store, sessionId).append(
          "session.archived",
          { operationId },
          { kind: "runtime", id: "session-repository" },
        );
      }
    } finally {
      store.close();
    }
    await writeArchiveManifest(archived, sessionId);
  }

  async #finishRestore(sessionId: SessionId, operationId: string): Promise<void> {
    const archived = projectSessionPaths(this.#paths, sessionId, "archived");
    const active = projectSessionPaths(this.#paths, sessionId, "active");
    if (existsSync(archived.root) && !existsSync(active.root)) {
      await rename(archived.root, active.root);
    }
    if (!existsSync(active.root)) throw new Error(`Restore move lost Session ${sessionId}`);
    await rm(active.archiveManifestFile, { force: true });
    const writer = new EventWriter(this, sessionId);
    if (writer.view?.lifecycle === "restore_pending") {
      writer.append(
        "session.restored",
        { operationId },
        { kind: "runtime", id: "session-repository" },
      );
    }
  }

  async #recoverReset(): Promise<void> {
    if (!existsSync(this.#resetJournalFile())) return;
    const journal = JSON.parse(await readFile(this.#resetJournalFile(), "utf8")) as {
      operationId: string;
      sessionIds: SessionId[];
      completed: SessionId[];
    };
    for (const sessionId of journal.sessionIds) {
      if (journal.completed.includes(sessionId)) continue;
      if (existsSync(projectSessionPaths(this.#paths, sessionId, "active").root)) {
        await this.archive(sessionId, "Workspace reset recovery");
      }
      journal.completed.push(sessionId);
      await writeJsonAtomic(this.#resetJournalFile(), { schemaVersion: 1, ...journal });
    }
    await rm(this.#resetJournalFile(), { force: true });
  }

  #activeWatcherBlockers(sessionId: SessionId): string[] {
    if (!existsSync(this.#paths.schedulerFile)) return [];
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.#paths.schedulerFile, { readOnly: true });
      const table = database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='watchers'",
      ).get();
      if (!table) return [];
      const rows = database.prepare(
        "SELECT watcher_id FROM watchers WHERE session_id=? AND state='active' ORDER BY watcher_id",
      ).all(sessionId) as unknown as Array<{ watcher_id: string }>;
      return rows.map((row) => `Watcher ${row.watcher_id} is active`);
    } catch {
      return ["Watcher state could not be verified"];
    } finally {
      database?.close();
    }
  }

  #directorySessionIds(root: string): SessionId[] {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^ses_/.test(entry.name))
      .map((entry) => entry.name as SessionId)
      .sort();
  }

  #loadAt(paths: ProjectSessionPaths): SessionView | undefined {
    if (!existsSync(paths.databaseFile)) return undefined;
    const store = new SqliteEventStore(paths.databaseFile, { readonly: true });
    try {
      return store.load(paths.sessionId as SessionId);
    } finally {
      store.close();
    }
  }

  #resetJournalFile(): string {
    return resolve(this.#paths.stateRoot, "reset-operation.json");
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SessionRepository is closed");
  }
}

async function writeArchiveManifest(paths: ProjectSessionPaths, sessionId: SessionId): Promise<void> {
  const files = await inventory(paths.root, paths.archiveManifestFile);
  await writeJsonAtomic(paths.archiveManifestFile, {
    schemaVersion: 1,
    sessionId,
    archivedAt: new Date().toISOString(),
    files,
  } satisfies ArchiveManifest);
}

async function verifyArchiveManifest(paths: ProjectSessionPaths): Promise<void> {
  const manifest = JSON.parse(await readFile(paths.archiveManifestFile, "utf8")) as ArchiveManifest;
  if (manifest.schemaVersion !== 1 || manifest.sessionId !== paths.sessionId) {
    throw new Error(`Archive manifest does not match Session ${paths.sessionId}`);
  }
  const actual = await inventory(paths.root, paths.archiveManifestFile);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error(`Archive ${paths.sessionId} failed file integrity validation`);
  }
  const store = new SqliteEventStore(paths.databaseFile, { readonly: true });
  try {
    if (store.load(paths.sessionId as SessionId)?.lifecycle !== "archived") {
      throw new Error(`Archive ${paths.sessionId} is not in archived lifecycle state`);
    }
  } finally {
    store.close();
  }
}

async function inventory(root: string, manifestFile: string): Promise<Array<{ path: string; size: number; sha256: string }>> {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (path === manifestFile) continue;
      if (entry.name.endsWith("-wal") || entry.name.endsWith("-shm")) continue;
      if (entry.isSymbolicLink()) throw new Error(`Session package contains a symbolic link: ${path}`);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(path);
      const content = await readFile(path);
      files.push({
        path: relative(root, path).split(sep).join("/"),
        size: info.size,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}
