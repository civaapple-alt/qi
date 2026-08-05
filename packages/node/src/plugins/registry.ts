import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
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
    await mkdir(this.#marketplacesRoot, { recursive: true });
    let installLocation: string;
    if (source.kind === "local") {
      installLocation = resolve(source.path);
      await assertMarketplaceRoot(installLocation);
    } else {
      installLocation = resolve(this.#marketplacesRoot, name);
      await syncGithubMarketplace(source.repo, installLocation, source.ref);
    }
    const entry: KnownMarketplace = Object.freeze({
      name,
      source: source.kind === "local" ? Object.freeze({ kind: "local", path: installLocation }) : source,
      installLocation,
      lastUpdated: new Date().toISOString(),
    });
    const known = await this.#readKnown();
    known.marketplaces[name] = entry;
    await this.#writeKnown(known);
    return entry;
  }

  async sync(name: string): Promise<KnownMarketplace> {
    const current = await this.get(name);
    if (current.source.kind === "local") {
      await assertMarketplaceRoot(current.installLocation);
    } else {
      await syncGithubMarketplace(current.source.repo, current.installLocation, current.source.ref);
    }
    const updated: KnownMarketplace = Object.freeze({
      ...current,
      lastUpdated: new Date().toISOString(),
    });
    const known = await this.#readKnown();
    known.marketplaces[name] = updated;
    await this.#writeKnown(known);
    return updated;
  }

  async loadCatalog(name: string): Promise<MarketplaceCatalog> {
    const marketplace = await this.get(name);
    const raw = JSON.parse(
      await readFile(resolve(marketplace.installLocation, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as unknown;
    return parseMarketplaceCatalog(raw);
  }

  async #readKnown(): Promise<{ schemaVersion: 1; marketplaces: Record<string, KnownMarketplace> }> {
    try {
      const raw = JSON.parse(await readFile(this.#knownFile, "utf8")) as unknown;
      if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.marketplaces)) {
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

async function syncGithubMarketplace(repo: string, installLocation: string, ref = "main"): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new TypeError(`Invalid GitHub repo: ${repo}`);
  }
  await mkdir(resolve(installLocation, ".."), { recursive: true });
  const url = `https://github.com/${repo}.git`;
  try {
    await runGit(["-C", installLocation, "rev-parse", "--is-inside-work-tree"]);
    await runGit(["-C", installLocation, "fetch", "--depth", "1", "origin", ref]);
    await runGit(["-C", installLocation, "checkout", "FETCH_HEAD"]);
  } catch {
    await runGit(["clone", "--depth", "1", "--branch", ref, url, installLocation]);
  }
  await assertMarketplaceRoot(installLocation);
}

async function assertMarketplaceRoot(root: string): Promise<void> {
  await readFile(resolve(root, ".claude-plugin", "marketplace.json"), "utf8");
}

async function runGit(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || code}`));
    });
  });
}

function parseKnown(value: unknown, key: string): KnownMarketplace {
  if (!isRecord(value)) throw new TypeError(`known marketplace ${key} must be an object`);
  const name = typeof value.name === "string" ? value.name : key;
  const installLocation = requiredString(value.installLocation, `${key}.installLocation`);
  const source = parseSource(value.source, key);
  return Object.freeze({
    name,
    source,
    installLocation,
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
      repo: requiredString(value.repo, `${key}.source.repo`),
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
