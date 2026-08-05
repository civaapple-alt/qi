import { resolve } from "node:path";
import {
  MarketplaceRegistry,
  PluginCatalog,
  PluginInstaller,
  type MarketplaceSource,
} from "@civaapple/qi-node/plugins";
import { projectPaths } from "@civaapple/qi-node/paths";

/** Credential-free marketplace / plugin management commands. */
export async function runPluginCliCommand(args: readonly string[]): Promise<boolean> {
  if (args[0] !== "marketplace" && args[0] !== "plugin" && args[0] !== "plugins" && args[0] !== "agent" && args[0] !== "agents") {
    return false;
  }
  const parsed = parse(args.slice(1));
  const workspaceRoot = resolve(parsed.values.get("workspace") ?? ".");
  const paths = projectPaths({ workspaceRoot });
  const registry = new MarketplaceRegistry(paths.qiHome);
  const installer = new PluginInstaller(paths.qiHome, registry);
  const catalog = new PluginCatalog(paths.qiHome, registry, installer);

  if (args[0] === "marketplace") {
    const operation = parsed.positionals.shift() ?? "list";
    if (operation === "list") return output(await registry.list(), parsed.json);
    if (operation === "add") {
      const name = required(parsed.positionals.shift(), "marketplace name");
      const source = required(parsed.positionals.shift(), "github:owner/repo | local:PATH");
      const parsedSource = parseMarketplaceSource(source);
      const ref = parsed.values.get("ref");
      const withRef = parsedSource.kind === "github" && ref
        ? { ...parsedSource, ref }
        : parsedSource;
      return output(await registry.add(name, withRef), parsed.json);
    }
    if (operation === "sync") {
      const name = required(parsed.positionals.shift(), "marketplace name");
      return output(await registry.sync(name), parsed.json);
    }
    if (operation === "search") {
      const name = required(parsed.positionals.shift(), "marketplace name");
      const query = parsed.positionals.join(" ");
      return output(await catalog.searchMarketplace(name, query), parsed.json);
    }
    throw new TypeError("Usage: qi marketplace list|add|sync|search ...");
  }

  if (args[0] === "agent" || args[0] === "agents") {
    const operation = parsed.positionals.shift() ?? "list";
    if (operation === "list") {
      return output(await catalog.listAgents(parsed.positionals.join(" ")), parsed.json);
    }
    throw new TypeError("Usage: qi agent list [query]");
  }

  const operation = parsed.positionals.shift() ?? "list";
  if (operation === "list") {
    const installed = await installer.listInstalled();
    const enabled = new Set(await catalog.listEnabled());
    return output(installed.map((entry) => ({ ...entry, enabled: enabled.has(entry.key) })), parsed.json);
  }
  if (operation === "commands") {
    return output(await catalog.listCommands(parsed.positionals.join(" ")), parsed.json);
  }
  if (operation === "install") {
    const first = required(parsed.positionals.shift(), "marketplace or plugin@marketplace");
    const second = parsed.positionals.shift();
    const [marketplace, plugin] = second === undefined ? parsePluginSelector(first) : [first, required(second, "plugin")];
    const record = await installer.install(marketplace, plugin);
    const mcpFiles = await installer.materializeMcpDeclarations(record.key);
    return output({ ...record, mcpDeclarations: mcpFiles }, parsed.json);
  }
  if (operation === "enable") {
    const key = required(parsed.positionals.shift(), "plugin@marketplace");
    return output(await catalog.enable(key), parsed.json);
  }
  if (operation === "disable") {
    const key = required(parsed.positionals.shift(), "plugin@marketplace");
    return output(await catalog.disable(key), parsed.json);
  }
  if (operation === "inspect") {
    const key = required(parsed.positionals.shift(), "plugin@marketplace");
    return output(await catalog.inspectInstalled(key), parsed.json);
  }
  throw new TypeError("Usage: qi plugin list|commands|install|enable|disable|inspect ...");
}

function parseMarketplaceSource(value: string): MarketplaceSource {
  if (value.startsWith("local:")) {
    return { kind: "local", path: resolve(value.slice("local:".length)) };
  }
  if (value.startsWith("github:")) {
    return { kind: "github", repo: value.slice("github:".length) };
  }
  if (/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/i.test(value)) {
    const url = new URL(value);
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    return { kind: "github", repo: `${parts[0]}/${parts[1]!.replace(/\.git$/i, "")}` };
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    return { kind: "github", repo: value };
  }
  throw new TypeError("marketplace source must be github:owner/repo or local:PATH");
}

function parsePluginSelector(value: string): [marketplace: string, plugin: string] {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) throw new TypeError("Plugin selector must be plugin@marketplace");
  return [value.slice(at + 1), value.slice(0, at)];
}

function parse(args: readonly string[]): {
  positionals: string[];
  values: Map<string, string>;
  json: boolean;
} {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new TypeError(`Missing value for --${key}`);
      values.set(key, next);
      index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, values, json };
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new TypeError(`Missing ${label}`);
  return value.trim();
}

function output(value: unknown, json: boolean): true {
  process.stdout.write(`${json ? JSON.stringify(value, null, 2) : format(value)}\n`);
  return true;
}

function format(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    return value.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n");
  }
  return JSON.stringify(value, null, 2);
}
