import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { minimalHostEnvironment, preserveLocalProxyEnvironment } from "../workspace/process.js";
import { parseMarketplaceCatalog } from "./marketplace.js";
import type { KnownMarketplace, MarketplaceCatalog, MarketplaceSource } from "./types.js";

export class MarketplaceRegistry {
  readonly #qiHome: string;
  readonly #knownFile: string;
  readonly #marketplacesRoot: string;

  constructor(qiHome: string) {
    this.#qiHome = resolve(qiHome);
    this.#knownFile = resolve(this.#qiHome, "plugins", "known_marketplaces.json");
    this.#marketplacesRoot = resolve(this.#qiHome, "plugins", "marketplaces");
  }

  async list(): Promise<readonly KnownMarketplace[]> {
    const known = await this.#readKnown();
    return Object.values(known.marketplaces).sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(name: string): Promise<KnownMarketplace> {
    const known = await this.#readKnown();
    const found = known.marketplaces[name];
    if (!found) throw new Error(`Unknown marketplace: ${name}`);
    return found;
  }

  async add(name: string, source: MarketplaceSource): Promise<KnownMarketplace> {
    if (!/^[a-z][a-z0-9_-]{0,127}$/.test(name)) {
      throw new TypeError("marketplace name must match /^[a-z][a-z0-9_-]{0,127}$/");
    }
    const normalizedSource = source.kind === "github"
      ? Object.freeze({ ...source, repo: normalizeGithubMarketplaceRepo(source.repo) })
      : source;
    await mkdir(this.#marketplacesRoot, { recursive: true });
    let installLocation: string;
    let resolvedRevision: string | undefined;
    if (normalizedSource.kind === "local") {
      installLocation = resolve(normalizedSource.path);
      await assertMarketplaceRoot(installLocation);
      resolvedRevision = await readRevision(installLocation);
    } else {
      installLocation = resolve(this.#marketplacesRoot, name);
      resolvedRevision = await syncGithubMarketplace(normalizedSource.repo, installLocation, normalizedSource.ref);
    }
    const declaredName = await readMarketplaceName(installLocation);
    const entry: KnownMarketplace = Object.freeze({
      name,
      enabled: true,
      source: normalizedSource.kind === "local"
        ? Object.freeze({ kind: "local", path: installLocation })
        : normalizedSource,
      installLocation,
      ...(declaredName === undefined ? {} : { declaredName }),
      ...(resolvedRevision === undefined ? {} : { resolvedRevision }),
      lastUpdated: new Date().toISOString(),
    });
    const known = await this.#readKnown();
    known.marketplaces[name] = entry;
    await this.#writeKnown(known);
    return entry;
  }

  async sync(name: string): Promise<KnownMarketplace> {
    const current = await this.get(name);
    if (!current.enabled) throw new Error(`Marketplace ${name} is disabled; enable it before syncing`);
    if (current.source.kind === "local") {
      await assertMarketplaceRoot(current.installLocation);
    } else {
      const resolvedRevision = await syncGithubMarketplace(current.source.repo, current.installLocation, current.source.ref);
      const updated: KnownMarketplace = Object.freeze({
        ...current,
        ...(resolvedRevision === undefined ? {} : { resolvedRevision }),
        lastUpdated: new Date().toISOString(),
      });
      const known = await this.#readKnown();
      known.marketplaces[name] = updated;
      await this.#writeKnown(known);
      return updated;
    }
    const declaredName = await readMarketplaceName(current.installLocation);
    const updated: KnownMarketplace = Object.freeze({
      ...current,
      ...(declaredName === undefined ? {} : { declaredName }),
      lastUpdated: new Date().toISOString(),
    });
    const known = await this.#readKnown();
    known.marketplaces[name] = updated;
    await this.#writeKnown(known);
    return updated;
  }

  async loadCatalog(name: string): Promise<MarketplaceCatalog> {
    const marketplace = await this.get(name);
    if (!marketplace.enabled) throw new Error(`Marketplace ${name} is disabled; enable it before browsing or installing plugins`);
    const raw = JSON.parse(
      await readFile(resolve(marketplace.installLocation, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as unknown;
    return parseMarketplaceCatalog(raw);
  }

  async setEnabled(name: string, enabled: boolean): Promise<KnownMarketplace> {
    const known = await this.#readKnown();
    const current = known.marketplaces[name];
    if (!current) throw new Error(`Unknown marketplace: ${name}`);
    const updated = Object.freeze({ ...current, enabled });
    known.marketplaces[name] = updated;
    await this.#writeKnown(known);
    return updated;
  }

  async #readKnown(): Promise<{ schemaVersion: 1; marketplaces: Record<string, KnownMarketplace> }> {
    try {
      const raw = JSON.parse(await readFile(this.#knownFile, "utf8")) as unknown;
      if (!isRecord(raw) || (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) || !isRecord(raw.marketplaces)) {
        throw new TypeError("known_marketplaces.json schemaVersion must be 1");
      }
      const marketplaces: Record<string, KnownMarketplace> = {};
      for (const [key, value] of Object.entries(raw.marketplaces)) {
        marketplaces[key] = parseKnown(value, key);
      }
      return { schemaVersion: 1, marketplaces };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, marketplaces: {} };
      }
      throw error;
    }
  }

  async #writeKnown(value: { schemaVersion: 1; marketplaces: Record<string, KnownMarketplace> }): Promise<void> {
    await mkdir(resolve(this.#qiHome, "plugins"), { recursive: true });
    await writeFile(this.#knownFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

async function syncGithubMarketplace(repo: string, installLocation: string, ref = "main"): Promise<string | undefined> {
  const normalizedRepo = normalizeGithubMarketplaceRepo(repo);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedRepo)) {
    throw new TypeError(`Invalid GitHub repo: ${repo}`);
  }
  await mkdir(resolve(installLocation, ".."), { recursive: true });
  const url = `https://github.com/${normalizedRepo}.git`;
  try {
    await runGit(["-C", installLocation, "rev-parse", "--is-inside-work-tree"]);
    await runGit(["-C", installLocation, "fetch", "--depth", "1", "origin", ref]);
    await runGit(["-C", installLocation, "checkout", "--detach", "FETCH_HEAD"]);
  } catch {
    await runGit(["clone", "--depth", "1", "--branch", ref, url, installLocation]);
  }

  await assertMarketplaceRoot(installLocation);
  return readRevision(installLocation);
}

/** Normalize GitHub marketplace input to the canonical owner/repository form. */
export function normalizeGithubMarketplaceRepo(value: string): string {
  const trimmed = value.trim().replace(/^github:/i, "");
  if (/^https?:\/\/github\.com\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hostname.toLowerCase() !== "github.com" || url.search || url.hash) return trimmed;
      const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) return trimmed;
      return `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
    } catch {
      return trimmed;
    }
  }
  return trimmed.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
}

async function assertMarketplaceRoot(root: string): Promise<void> {
  await readFile(resolve(root, ".claude-plugin", "marketplace.json"), "utf8");
}

async function runGit(args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn("git", ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: preserveLocalProxyEnvironment(
        minimalHostEnvironment({ GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" }),
      ),
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || code}`));
    });
  });
}

async function readRevision(root: string): Promise<string | undefined> {
  try {
    return (await runGit(["-C", root, "rev-parse", "HEAD"])).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readMarketplaceName(root: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(resolve(root, ".claude-plugin", "marketplace.json"), "utf8")) as unknown;
    return isRecord(raw) && typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function parseKnown(value: unknown, key: string): KnownMarketplace {
  if (!isRecord(value)) throw new TypeError(`known marketplace ${key} must be an object`);
  const name = typeof value.name === "string" ? value.name : key;
  const installLocation = requiredString(value.installLocation, `${key}.installLocation`);
  const source = parseSource(value.source, key);
  return Object.freeze({
    name,
    enabled: value.enabled !== false,
    source,
    installLocation,
    ...(typeof value.declaredName === "string" ? { declaredName: value.declaredName } : {}),
    ...(typeof value.resolvedRevision === "string" ? { resolvedRevision: value.resolvedRevision } : {}),
    ...(typeof value.lastUpdated === "string" ? { lastUpdated: value.lastUpdated } : {}),
  });
}

function parseSource(value: unknown, key: string): MarketplaceSource {
  if (!isRecord(value)) throw new TypeError(`${key}.source must be an object`);
  // Accept Claude Code shape: { source: "github", repo: "..." }
  const kind = typeof value.kind === "string" ? value.kind : typeof value.source === "string" ? value.source : "";
  if (kind === "local") {
    return Object.freeze({ kind: "local", path: requiredString(value.path, `${key}.source.path`) });
  }
  if (kind === "github") {
    return Object.freeze({
      kind: "github",
      repo: normalizeGithubMarketplaceRepo(requiredString(value.repo, `${key}.source.repo`)),
      ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    });
  }
  throw new TypeError(`${key}.source kind must be github or local`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
