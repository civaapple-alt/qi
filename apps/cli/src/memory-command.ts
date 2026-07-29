import type { IndexedMemoryClaim } from "@civaapple/qi-agent/memory";

export type ParsedMemoryCommand =
  | { readonly mode: "list"; readonly scope?: "session" | "project" | "user" | "pending" }
  | {
      readonly mode: "remember";
      readonly scope: "session" | "project" | "user";
      readonly activation: "relevant" | "always";
      readonly statement: string;
    }
  | { readonly mode: "accept"; readonly memoryId: string }
  | { readonly mode: "correct"; readonly memoryId: string; readonly statement: string }
  | { readonly mode: "forget"; readonly memoryId: string; readonly reason?: string }
  | {
      readonly mode: "promote";
      readonly memoryId: string;
      readonly activation: "relevant" | "always";
    }
  | { readonly mode: "pin" | "unpin"; readonly memoryId: string };

const USAGE =
  "Usage: /memory [list [session|project|user|pending]] · " +
  "/memory remember <session|project|user> [--always] <text> · " +
  "/memory accept <id> · /memory correct <id> <text> · " +
  "/memory forget <id> [reason] · /memory promote <id> [--always] · " +
  "/memory pin|unpin <id>";

export function parseMemoryCommand(argument: string): ParsedMemoryCommand {
  const trimmed = argument.trim();
  if (!trimmed) return { mode: "list" };
  const [verb = "", ...tokens] = splitArguments(trimmed);
  const rest = tokens.join(" ").trim();
  switch (verb.toLowerCase()) {
    case "list": {
      const scope = tokens[0]?.toLowerCase();
      if (scope === undefined) return { mode: "list" };
      if (scope !== "session" && scope !== "project" && scope !== "user" && scope !== "pending") {
        throw new TypeError(USAGE);
      }
      return { mode: "list", scope };
    }
    case "remember": {
      const scope = tokens.shift()?.toLowerCase();
      if (scope !== "session" && scope !== "project" && scope !== "user") throw new TypeError(USAGE);
      const always = tokens[0] === "--always";
      if (always) tokens.shift();
      const statement = tokens.join(" ").trim();
      if (!statement) throw new TypeError(USAGE);
      if (always && scope !== "user") {
        throw new TypeError("--always is only available for explicit User Memory");
      }
      return { mode: "remember", scope, activation: always ? "always" : "relevant", statement };
    }
    case "accept":
      if (!rest || tokens.length !== 1) throw new TypeError(USAGE);
      return { mode: "accept", memoryId: rest };
    case "correct": {
      const memoryId = tokens.shift();
      const statement = tokens.join(" ").trim();
      if (!memoryId || !statement) throw new TypeError(USAGE);
      return { mode: "correct", memoryId, statement };
    }
    case "forget": {
      const memoryId = tokens.shift();
      if (!memoryId) throw new TypeError(USAGE);
      const reason = tokens.join(" ").trim();
      return { mode: "forget", memoryId, ...(reason ? { reason } : {}) };
    }
    case "promote": {
      const memoryId = tokens.shift();
      const activation = tokens.shift();
      if (!memoryId || (activation !== undefined && activation !== "--always") || tokens.length > 0) {
        throw new TypeError(USAGE);
      }
      return { mode: "promote", memoryId, activation: activation ? "always" : "relevant" };
    }
    case "pin":
    case "unpin":
      if (!rest || tokens.length !== 1) throw new TypeError(USAGE);
      return { mode: verb.toLowerCase() as "pin" | "unpin", memoryId: rest };
    default:
      throw new TypeError(USAGE);
  }
}

export function formatMemoryClaims(
  claims: readonly IndexedMemoryClaim[],
  options: {
    readonly title?: string;
    readonly usedMemoryIds?: ReadonlySet<string>;
    readonly omittedMemoryIds?: ReadonlySet<string>;
  } = {},
): string[] {
  const lines = [
    options.title ?? "Memory",
    "Machine-private plaintext storage. Credential-like secrets are rejected.",
    "",
  ];
  if (claims.length === 0) {
    lines.push("No matching Memory.");
    return lines;
  }
  for (const claim of claims) {
    const scope = formatMemoryScope(claim);
    const used = options.usedMemoryIds?.has(claim.memoryId)
      ? " · included this Run"
      : options.omittedMemoryIds?.has(claim.memoryId)
        ? " · omitted this Run"
        : "";
    lines.push(
      `${claim.memoryId} · ${scope} · ${claim.status} · ${claim.sensitivity}` +
        ` · ${claim.activation ?? "relevant"}${used}`,
      `  ${claim.statement}`,
      `  source ${claim.provenance.map((source) =>
        `${source.projectId ?? "legacy"}/${source.sessionId}#${source.sequence}`).join(", ")}`,
    );
  }
  return lines;
}

export function memoryIdsUsedInLatestRun(events: readonly {
  readonly type: string;
  readonly data: unknown;
}[]): ReadonlySet<string> {
  return memoryUsageInLatestRun(events).included;
}

export function memoryUsageInLatestRun(events: readonly {
  readonly type: string;
  readonly data: unknown;
}[]): { readonly included: ReadonlySet<string>; readonly omitted: ReadonlySet<string> } {
  const latestRunId = [...events].reverse().find((event) => event.type === "run.triggered")
    ?.data as { runId?: string } | undefined;
  const included = new Set<string>();
  const omitted = new Set<string>();
  for (const event of events) {
    if (event.type !== "context.compiled") continue;
    const data = event.data as {
      runId?: string;
      includedBlockIds?: readonly string[];
      omittedBlockIds?: readonly string[];
    };
    if (latestRunId?.runId && data.runId !== latestRunId.runId) continue;
    for (const blockId of data.includedBlockIds ?? []) {
      if (blockId.startsWith("memory:")) included.add(blockId.slice("memory:".length));
    }
    for (const blockId of data.omittedBlockIds ?? []) {
      if (blockId.startsWith("memory:")) omitted.add(blockId.slice("memory:".length));
    }
  }
  return { included, omitted };
}

function formatMemoryScope(claim: IndexedMemoryClaim): string {
  if (typeof claim.scope === "string") return `legacy:${claim.scope}`;
  if (claim.scope.kind === "session") return "Session";
  if (claim.scope.kind === "project") return "Project";
  return "User";
}

function splitArguments(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of input.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  return tokens;
}
