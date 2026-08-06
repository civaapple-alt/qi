import { resolve } from "node:path";
import type { Effect } from "@civaapple/qi-agent/capability";
import {
  EncryptedFileCredentialStore,
} from "@civaapple/qi-node/storage";
import {
  McpConnectionManager,
  McpDeclarationCatalog,
  McpReviewStore,
  SealedMcpOAuthProviderFactory,
  type McpBinding,
} from "@civaapple/qi-node/mcp";
import { projectPaths } from "@civaapple/qi-node/paths";
import { SkillCatalog, type ImmutableSkillSource, type SkillScope } from "@civaapple/qi-node/skills";
import { MarketplaceRegistry, PluginCatalog, PluginInstaller } from "@civaapple/qi-node/plugins";

/** Credential-free, non-interactive Skill/MCP management commands. */
export async function runExtensionCliCommand(args: readonly string[]): Promise<boolean> {
  if (args[0] !== "skill" && args[0] !== "mcp") return false;
  const parsed = parse(args.slice(1));
  const workspaceRoot = resolve(parsed.values.get("workspace") ?? ".");
  const paths = projectPaths({ workspaceRoot });
  if (args[0] === "skill") {
    const catalog = new SkillCatalog({ workspaceRoot, userSkillsRoot: resolve(paths.qiHome, "resources", "skills") });
    const registry = new MarketplaceRegistry(paths.qiHome);
    const pluginCatalog = new PluginCatalog(paths.qiHome, registry, new PluginInstaller(paths.qiHome, registry));
    const operation = parsed.positionals.shift() ?? "list";
    if (operation === "list") return output({ native: await catalog.discover(), marketplace: await pluginCatalog.listInstalledSkills() }, parsed.json);
    if (operation === "enable") {
      const name = required(parsed.positionals.shift(), "Skill name");
      const plugin = await pluginCatalog.listInstalledSkills(name);
      const native = (await catalog.discover()).some((entry) => entry.name === name);
      return output(!native && (plugin.length > 0 || name.includes(":"))
        ? await pluginCatalog.enableSkill(name)
        : await catalog.activateAgentSkill(name), parsed.json);
    }
    if (operation === "disable") {
      const name = required(parsed.positionals.shift(), "Skill name");
      const plugin = await pluginCatalog.listInstalledSkills(name);
      const native = (await catalog.discover()).some((entry) => entry.name === name);
      return output(!native && (plugin.length > 0 || name.includes(":"))
        ? await pluginCatalog.disableSkill(name)
        : { name, disabled: await catalog.deactivateAgentSkill(name) }, parsed.json);
    }
    if (operation === "remove" || operation === "uninstall") {
      const name = required(parsed.positionals.shift(), "Skill name");
      const scopeValue = parsed.values.get("scope");
      if (scopeValue !== undefined && scopeValue !== "user" && scopeValue !== "workspace") {
        throw new TypeError("--scope must be user or workspace");
      }
      const scope = scopeValue as SkillScope | undefined;
      return output(await catalog.remove(name, scope === undefined ? {} : { scope }), parsed.json);
    }
    if (operation !== "install") {
      throw new TypeError(
        "Usage: qi skill list|enable|disable|install SOURCE [--skill NAME | --scope user|workspace] | remove NAME [--scope user|workspace] [--json]",
      );
    }
    const source = required(parsed.positionals.shift(), "Skill SOURCE");
    const scope = (parsed.values.get("scope") ?? "user") as SkillScope;
    if (scope !== "user" && scope !== "workspace") throw new TypeError("--scope must be user or workspace");
    const skillName = parsed.values.get("skill");
    if (skillName && (parsed.values.has("commit") || parsed.values.has("sha256"))) {
      throw new TypeError("--skill resolves and pins GitHub HEAD; do not combine it with --commit or --sha256");
    }
    const immutable = skillName ? undefined : immutableSource(source, parsed.values);
    const expectedName = parsed.values.get("name");
    const subdir = parsed.values.get("subdir");
    const installed = skillName
      ? await catalog.installGithubSkill(source, skillName, { scope, ...(subdir === undefined ? {} : { subdir }) })
      : immutable
      ? await catalog.installImmutable(immutable, { scope, ...(expectedName ? { expectedName } : {}) })
      : await catalog.install({ source, scope, ...(expectedName ? { expectedName } : {}) });
    return output(installed, parsed.json);
  }

  const declarations = new McpDeclarationCatalog({ workspaceRoot, userDeclarationsRoot: resolve(paths.qiHome, "resources", "mcp") });
  const reviews = new McpReviewStore(resolve(paths.stateRoot, "mcp-bindings.json"));
  const credentials = new EncryptedFileCredentialStore(paths.qiHome);
  const authorizationUrls = new Map<string, string>();
  const oauth = new SealedMcpOAuthProviderFactory(credentials, {
    redirectToAuthorization(server, url) { authorizationUrls.set(server, url.toString()); },
    confirmAdditionalScopes() { return false; },
  });
  const manager = new McpConnectionManager({
    catalog: declarations,
    reviews,
    workspaceRoot,
    credentials: { async resolve(alias) { return (await credentials.get(`mcp:${alias}`) ?? await credentials.get(alias))?.secret; } },
    oauth,
  });
  try {
    const operation = parsed.positionals.shift() ?? "status";
    if (operation === "status") return output(await manager.statuses(), parsed.json);
    if (operation === "refresh") {
      const server = required(parsed.positionals.shift(), "server");
      try { return output(await manager.refresh(server), parsed.json); }
      catch (error) {
        const authorizationUrl = authorizationUrls.get(server);
        if (authorizationUrl) return output({ server, status: "needs-auth", authorizationUrl }, parsed.json);
        throw error;
      }
    }
    if (operation === "bind") {
      const [server, kind, name, effect] = takeFour(parsed.positionals);
      assertKind(kind); assertEffect(effect);
      const resourcePatterns = parsed.many.get("resource");
      return output(await reviews.bind({ server, kind, name, effect, ...(resourcePatterns?.length ? { resourcePatterns } : {}) }), parsed.json);
    }
    if (operation === "unbind") {
      const server = required(parsed.positionals.shift(), "server");
      const kind = required(parsed.positionals.shift(), "kind"); assertKind(kind);
      const name = required(parsed.positionals.shift(), "name");
      return output({ unbound: await reviews.unbind(server, kind, name) }, parsed.json);
    }
    if (operation === "logout") {
      const server = required(parsed.positionals.shift(), "server"); await manager.logout(server); return output({ server, status: "logged-out" }, parsed.json);
    }
    throw new TypeError("Usage: qi mcp status|refresh|bind|unbind|logout ... [--workspace PATH] [--json]");
  } finally {
    await manager.close();
  }
}

function immutableSource(source: string, values: ReadonlyMap<string, string>): ImmutableSkillSource | undefined {
  const sha256 = values.get("sha256");
  if (sha256) { const subdir = values.get("subdir"); return { type: "archive", url: source, sha256, ...(subdir ? { subdir } : {}) }; }
  const commit = values.get("commit");
  if (!commit) return undefined;
  const subdir = required(values.get("subdir"), "--subdir for immutable Git sources");
  return /^https:\/\/github\.com\//i.test(source)
    ? { type: "github", url: source, commit, subdir }
    : { type: "git", repository: source, commit, subdir };
}

function parse(args: readonly string[]) {
  const positionals: string[] = []; const values = new Map<string, string>(); const many = new Map<string, string[]>(); let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!;
    if (item === "--json") { json = true; continue; }
    if (item.startsWith("--")) {
      const key = item.slice(2); const value = args[++index]; if (!value || value.startsWith("--")) throw new TypeError(`${item} requires a value`);
      if (key === "resource") many.set(key, [...(many.get(key) ?? []), value]); else values.set(key, value); continue;
    }
    positionals.push(item);
  }
  return { positionals, values, many, json };
}
function output(value: unknown, json: boolean): true { process.stdout.write(`${json ? JSON.stringify(value, null, 2) : format(value)}\n`); return true; }
function format(value: unknown): string { return Array.isArray(value) ? value.map((entry) => JSON.stringify(entry)).join("\n") : JSON.stringify(value, null, 2); }
function required(value: string | undefined, label: string): string { if (!value) throw new TypeError(`${label} is required`); return value; }
function takeFour(values: string[]): [string, string, string, string] { return [required(values.shift(), "server"), required(values.shift(), "kind"), required(values.shift(), "name"), required(values.shift(), "effect")]; }
function assertKind(value: string): asserts value is McpBinding["kind"] { if (!new Set(["tool", "resource", "resource-template", "prompt", "instructions"]).has(value)) throw new TypeError(`Invalid MCP kind: ${value}`); }
function assertEffect(value: string): asserts value is Effect { if (!new Set(["read", "write", "execute", "publish", "spend"]).has(value)) throw new TypeError(`Invalid MCP effect: ${value}`); }
