import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  defaultQiHome,
  ensureProjectLayout,
  ensureQiLayout,
  projectPaths,
} from "@civaapple/qi-node/paths";
import {
  DeclarativePackageStore,
  type InstalledDeclarativePackage,
} from "@civaapple/qi-node/extensions";

type PackageScope = "user" | "project";

export async function runPackageCliCommand(
  argv: readonly string[],
  options: {
    readonly cwd?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly write?: (text: string) => void;
  } = {},
): Promise<boolean> {
  const command = argv[0];
  if (!new Set(["install", "update", "remove", "list"]).has(command ?? "")) return false;
  const cwd = resolve(options.cwd ?? process.cwd());
  const environment = options.environment ?? process.env;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const parsed = parsePackageOptions(argv.slice(1), cwd);
  const qiHome = defaultQiHome(environment);
  await ensureQiLayout(qiHome, parsed.workspace ? { workspaceRoot: parsed.workspace } : {});
  const scope = parsed.scope ?? "user";

  if (command === "list") {
    const lock = await readLock(lockPathForScope(qiHome, scope, parsed.workspace));
    const rows = Object.entries(lock.packages)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, value]) => `${id}\t${value.version}\t${value.source.digest}`);
    write(`${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`);
    return true;
  }

  const operand = parsed.operands[0];
  if (!operand) throw new TypeError(`qi ${command} requires a package source or package id`);
  if (parsed.operands.length !== 1) throw new TypeError(`qi ${command} accepts exactly one operand`);

  if (command === "remove") {
    const lockPath = lockPathForScope(qiHome, scope, parsed.workspace);
    const lock = await readLock(lockPath);
    if (!(operand in lock.packages)) throw new Error(`Package is not installed in ${scope} scope: ${operand}`);
    delete lock.packages[operand];
    await writeLockAtomic(lockPath, lock);
    if (scope === "user") await writeInstalledToml(qiHome, lock);
    else await writeActivation(qiHome, parsed.workspace, lock);
    write(`Removed ${operand} from ${scope} scope; shared content remains available for deduplication.\n`);
    return true;
  }

  const store = new DeclarativePackageStore(qiHome);
  const installed = await installSource(store, operand, scope === "user");
  if (scope === "project") {
    const lockPath = lockPathForScope(qiHome, scope, parsed.workspace);
    const lock = await readLock(lockPath);
    lock.packages[installed.manifest.id] = {
      version: installed.manifest.version,
      source: installed.source,
    };
    await writeLockAtomic(lockPath, lock);
    await writeActivation(qiHome, parsed.workspace, lock);
  } else {
    await writeInstalledToml(qiHome, await readLock(resolve(qiHome, "packages", "lock.json")));
  }
  write(
    `${command === "update" ? "Updated" : "Installed"} ${installed.manifest.id}@${installed.manifest.version} ` +
    `(${installed.source.digest}) in ${scope} scope.\n`,
  );
  return true;
}

function parsePackageOptions(argv: readonly string[], cwd: string): {
  readonly scope?: PackageScope;
  readonly workspace?: string;
  readonly operands: readonly string[];
} {
  let scope: PackageScope | undefined;
  let workspace: string | undefined;
  const operands: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--scope") {
      const candidate = argv[++index];
      if (candidate !== "user" && candidate !== "project") {
        throw new TypeError("--scope must be user or project");
      }
      scope = candidate;
    } else if (value === "--workspace") {
      const candidate = argv[++index];
      if (!candidate) throw new TypeError("--workspace requires a path");
      workspace = resolve(cwd, candidate);
    } else if (value.startsWith("-")) {
      throw new TypeError(`Unknown package option: ${value}`);
    } else {
      operands.push(value);
    }
  }
  if (scope === "project" && !workspace) workspace = cwd;
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(workspace === undefined ? {} : { workspace }),
    operands,
  };
}

async function installSource(
  store: DeclarativePackageStore,
  source: string,
  record: boolean,
): Promise<InstalledDeclarativePackage> {
  if (source.startsWith("npm:")) return store.installNpm(source.slice(4), { record });
  if (source.startsWith("git:")) return store.installGit(source.slice(4), { record });
  const local = source.startsWith("local:") ? source.slice(6) : source;
  return store.installLocal(resolve(local), { record });
}

function lockPathForScope(
  qiHome: string,
  scope: PackageScope,
  workspace: string | undefined,
): string {
  if (scope === "user") return resolve(qiHome, "packages", "lock.json");
  if (!workspace) throw new TypeError("Project package scope requires --workspace or a Workspace cwd");
  return resolve(workspace, ".qi", "packages.lock.json");
}

interface PackageLock {
  schemaVersion: 1;
  packages: Record<string, {
    version: string;
    source: InstalledDeclarativePackage["source"];
  }>;
}

async function readLock(path: string): Promise<PackageLock> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as PackageLock;
    if (parsed.schemaVersion !== 1 || !parsed.packages || typeof parsed.packages !== "object") {
      throw new TypeError(`Invalid Qi package lock: ${path}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, packages: {} };
    }
    throw error;
  }
}

async function writeLockAtomic(path: string, lock: PackageLock): Promise<void> {
  await writeJsonAtomic(path, lock);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rm(path, { force: true });
  await rename(temporary, path);
}

async function writeActivation(
  qiHome: string,
  workspace: string | undefined,
  lock: PackageLock,
): Promise<void> {
  if (!workspace) throw new TypeError("Project activation requires a Workspace");
  const paths = projectPaths({ workspaceRoot: workspace, environment: { QI_HOME: qiHome } });
  await ensureProjectLayout(paths);
  const activation = {
    schemaVersion: 1,
    packages: Object.fromEntries(
      Object.entries(lock.packages).map(([id, value]) => [
        id,
        {
          version: value.version,
          digest: value.source.digest,
        },
      ]),
    ),
  };
  await writeJsonAtomic(paths.activationFile, activation);
}

async function writeInstalledToml(qiHome: string, lock: PackageLock): Promise<void> {
  const lines = ["version = 1"];
  for (const [id, value] of Object.entries(lock.packages).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(
      "",
      "[[packages]]",
      `id = ${JSON.stringify(id)}`,
      `version = ${JSON.stringify(value.version)}`,
      `digest = ${JSON.stringify(value.source.digest)}`,
    );
  }
  await writeFile(resolve(qiHome, "packages", "installed.toml"), `${lines.join("\n")}\n`);
}
