/** Claude-compatible marketplace and plugin adaptation types (ADR-0037). */

export type MarketplaceSource =
  | { readonly kind: "github"; readonly repo: string; readonly ref?: string }
  | { readonly kind: "local"; readonly path: string };

export interface KnownMarketplace {
  readonly name: string;
  readonly source: MarketplaceSource;
  readonly installLocation: string;
  readonly declaredName?: string;
  readonly resolvedRevision?: string;
  readonly lastUpdated?: string;
}

export type PluginSource =
  | { readonly kind: "vendored"; readonly path: string }
  | {
      readonly kind: "git-subdir" | "url" | "github" | "npm";
      readonly url?: string;
      readonly path?: string;
      readonly ref?: string;
      readonly sha?: string;
      readonly repo?: string;
    };

export interface MarketplacePluginEntry {
  readonly name: string;
  readonly description: string;
  readonly source: PluginSource;
  readonly category?: string;
  readonly homepage?: string;
  readonly author?: string;
  readonly tags?: readonly string[];
  readonly strict?: boolean;
  readonly skills?: readonly string[];
  readonly displayName?: string;
}

export interface MarketplaceCatalog {
  readonly name: string;
  readonly description?: string;
  readonly renames: Readonly<Record<string, string>>;
  readonly plugins: readonly MarketplacePluginEntry[];
}

export type PluginComponentKind = "skills" | "commands" | "mcp" | "agents" | "hooks" | "lsp";
export type PluginSupportLevel = "supported" | "partial" | "unsupported";

export interface PluginComponentSummary {
  readonly kind: PluginComponentKind;
  readonly ids: readonly string[];
  readonly supported: boolean;
}

export interface InspectedPlugin {
  readonly name: string;
  readonly description: string;
  readonly root: string;
  readonly components: readonly PluginComponentSummary[];
  readonly support: PluginSupportLevel;
  readonly unsupportedReasons: readonly string[];
}

export interface InstalledPluginRecord {
  readonly key: string;
  readonly marketplace: string;
  readonly name: string;
  readonly pin: string;
  readonly cachePath: string;
  readonly installedAt: string;
  readonly sourceKind: PluginSource["kind"];
  readonly sourceUrl?: string;
  readonly marketplaceRevision?: string;
  readonly commit?: string;
  readonly version?: string;
  readonly treeDigest?: string;
  readonly declaredMarketplace?: string;
}

export interface PluginSkillRef {
  readonly id: string;
  readonly pluginKey: string;
  readonly plugin: string;
  readonly marketplace: string;
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly version?: string;
}

export interface PluginSkillSnapshot {
  readonly plugins: readonly InstalledPluginRecord[];
  readonly skills: readonly PluginSkillRef[];
}

export interface PluginSkillStatus {
  readonly ref: PluginSkillRef;
  readonly enabled: boolean;
}

export interface PluginCommandRef {
  readonly id: string;
  readonly plugin: string;
  readonly marketplace: string;
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly kind: "command" | "skill";
}

export interface PluginAgentRef {
  readonly id: string;
  readonly plugin: string;
  readonly marketplace: string;
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly model?: string;
  readonly advisoryTools?: readonly string[];
}

export interface ConvertedMcpDeclaration {
  readonly name: string;
  readonly transport: "stdio" | "http" | "sse";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly warnings: readonly string[];
}
