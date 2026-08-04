import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Effect } from "@civaapple/qi-agent/capability";
import type { McpBinding, McpCandidate, McpCandidateSnapshot, McpReviewDocument } from "./types.js";

export class McpReviewStore {
  readonly path: string;
  constructor(path: string) { this.path = resolve(path); }

  async read(): Promise<McpReviewDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as McpReviewDocument;
      if (parsed.schemaVersion !== 1 || !parsed.bindings || !parsed.snapshots) throw new TypeError(`Invalid MCP review store: ${this.path}`);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, bindings: {}, snapshots: {} };
      throw error;
    }
  }

  async recordSnapshot(snapshot: McpCandidateSnapshot): Promise<{ snapshot: McpCandidateSnapshot; drifted: readonly string[] }> {
    const document = await this.read();
    const drifted: string[] = [];
    const priorTransport = document.snapshots[snapshot.server]?.transportIdentity;
    const transportDrifted = priorTransport !== undefined
      && (snapshot.transportIdentity === undefined
        || fingerprintMcpValue(priorTransport) !== fingerprintMcpValue(snapshot.transportIdentity));
    for (const [key, binding] of Object.entries(document.bindings)) {
      if (binding.server !== snapshot.server || binding.state !== "bound") continue;
      const candidate = candidateForBinding(snapshot, binding);
      const currentFingerprint = binding.kind === "instructions" ? snapshot.instructionsFingerprint : candidate?.fingerprint;
      if (transportDrifted || currentFingerprint !== binding.fingerprint) {
        document.bindings[key] = { ...binding, state: "drifted" };
        drifted.push(key);
      }
    }
    document.snapshots[snapshot.server] = snapshot;
    await this.#write(document);
    return { snapshot, drifted };
  }

  async bind(input: { server: string; kind: McpBinding["kind"]; name: string; effect: Effect; resourcePatterns?: readonly string[] }): Promise<McpBinding> {
    const document = await this.read();
    const snapshot = document.snapshots[input.server];
    if (!snapshot) throw new Error(`MCP server ${input.server} must be refreshed before review`);
    const fingerprint = input.kind === "instructions"
      ? snapshot.instructionsFingerprint
      : candidateForBinding(snapshot, { kind: input.kind, name: input.name } as McpBinding)?.fingerprint;
    if (!fingerprint) throw new Error(`MCP candidate ${input.server}/${input.kind}/${input.name} does not exist`);
    const binding: McpBinding = {
      server: input.server,
      kind: input.kind,
      name: input.name,
      fingerprint,
      effect: input.effect,
      resourcePatterns: Object.freeze([...new Set([
        mcpTargetResource(input.server, input.kind, input.name),
        ...(input.resourcePatterns ?? []),
      ])]),
      reviewedAt: new Date().toISOString(),
      state: "bound",
    };
    document.bindings[bindingKey(binding)] = binding;
    await this.#write(document);
    return binding;
  }

  async unbind(server: string, kind: McpBinding["kind"], name: string): Promise<boolean> {
    const document = await this.read();
    const key = bindingKey({ server, kind, name });
    if (!document.bindings[key]) return false;
    delete document.bindings[key];
    await this.#write(document);
    return true;
  }

  async #write(document: McpReviewDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export function fingerprintMcpValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function candidateFromRaw(kind: McpCandidate["kind"], raw: Readonly<Record<string, unknown>>): McpCandidate {
  const name = kind === "resource" && typeof raw.uri === "string" ? raw.uri
    : kind === "resource-template" && typeof raw.uriTemplate === "string" ? raw.uriTemplate
    : typeof raw.name === "string" ? raw.name : typeof raw.uri === "string" ? raw.uri : "";
  if (!name) throw new TypeError(`MCP ${kind} candidate requires name or uri`);
  return {
    kind, name,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.uri === "string" ? { uri: raw.uri } : {}),
    raw: structuredClone(raw),
    fingerprint: fingerprintMcpValue(raw),
  };
}

export function bindingKey(value: Pick<McpBinding, "server" | "kind" | "name">): string { return `${value.server}::${value.kind}::${value.name}`; }

/** Exact, audit-stable resource used by the live proxy and its reviewed lease. */
export function mcpTargetResource(server: string, kind: McpBinding["kind"], name: string): string {
  return `mcp-target:${encodeURIComponent(server)}/${kind}/${encodeURIComponent(name)}`;
}

function candidateForBinding(snapshot: McpCandidateSnapshot, binding: Pick<McpBinding, "kind" | "name">): McpCandidate | undefined {
  const list = binding.kind === "tool" ? snapshot.tools
    : binding.kind === "resource" ? snapshot.resources
    : binding.kind === "resource-template" ? snapshot.resourceTemplates
    : binding.kind === "prompt" ? snapshot.prompts : [];
  return list.find((entry) => entry.name === binding.name);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
