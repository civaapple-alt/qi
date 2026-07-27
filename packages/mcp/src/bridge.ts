import type { Effect } from "@civaapple/qi-capability";
import { defineTool, type RegistrationHandle, type ToolExecutionContext, type ToolRegistry } from "@civaapple/qi-tools";
import { Type, type TSchema } from "@sinclair/typebox";

export interface McpRemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpTransport {
  listTools(): Promise<readonly McpRemoteTool[]>;
  callTool(name: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface McpToolCandidate extends McpRemoteTool {
  server: string;
  state: "quarantined";
}

export interface McpToolBinding {
  remoteName: string;
  localName: string;
  effect: Effect;
  resources(input: unknown, context: ToolExecutionContext): readonly string[];
  maximumModelBytes?: number;
}

const BoundedRemoteOutput = Type.Object(
  {
    preview: Type.String(),
    artifactRef: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export class McpBridge {
  readonly #server: string;
  readonly #transport: McpTransport;
  #candidates = new Map<string, McpRemoteTool>();

  constructor(server: string, transport: McpTransport) {
    if (!server.trim()) throw new TypeError("MCP server name is required");
    this.#server = server;
    this.#transport = transport;
  }

  async discover(): Promise<McpToolCandidate[]> {
    const discovered = await this.#transport.listTools();
    const candidates = new Map<string, McpRemoteTool>();
    for (const tool of discovered) {
      if (!tool.name || !tool.description || !isObjectSchema(tool.inputSchema)) {
        throw new TypeError(`MCP server ${this.#server} advertised an invalid tool`);
      }
      if (candidates.has(tool.name)) throw new Error(`MCP server ${this.#server} advertised duplicate tool ${tool.name}`);
      candidates.set(tool.name, structuredClone(tool));
    }
    this.#candidates = candidates;
    return [...candidates.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((tool) => ({ ...structuredClone(tool), server: this.#server, state: "quarantined" as const }));
  }

  bind(registry: ToolRegistry, binding: McpToolBinding): RegistrationHandle {
    const candidate = this.#candidates.get(binding.remoteName);
    if (!candidate) throw new Error(`MCP tool ${binding.remoteName} must be discovered before it can be bound`);
    const maximumModelBytes = binding.maximumModelBytes ?? 16 * 1024;
    if (!Number.isInteger(maximumModelBytes) || maximumModelBytes < 256) {
      throw new RangeError("maximumModelBytes must be an integer of at least 256");
    }
    const transport = this.#transport;
    const server = this.#server;
    const input = compileJsonSchema(candidate.inputSchema);
    return registry.register(binding.localName, defineTool({
      description: `[MCP ${server}] ${candidate.description}`,
      input,
      output: BoundedRemoteOutput,
      effect: () => binding.effect,
      resources: (value, context) => [...binding.resources(value, context)],
      async execute(value, context) {
        const remoteOutput = await transport.callTool(candidate.name, value, context.signal);
        const encoded = encodeJson(remoteOutput);
        if (encoded.byteLength <= maximumModelBytes) {
          return { preview: encoded.toString("utf8"), truncated: false };
        }
        const stored = await context.artifactStore.put(encoded, "application/json");
        return {
          preview: encoded.subarray(0, maximumModelBytes).toString("utf8"),
          artifactRef: stored.ref,
          truncated: true,
        };
      },
      toModelOutput(output) {
        const suffix = output.artifactRef ? `\nFull result: ${output.artifactRef}` : "";
        return [{ type: "text", text: `${output.preview}${suffix}` }];
      },
    }));
  }
}

function isObjectSchema(schema: Record<string, unknown>): boolean {
  return schema.type === "object" && typeof schema.properties === "object" && schema.properties !== null;
}

function encodeJson(value: unknown): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("MCP result is not JSON-serializable");
  return Buffer.from(json, "utf8");
}

function compileJsonSchema(schema: Record<string, unknown>, depth = 0): TSchema {
  if (depth > 32) throw new TypeError("MCP input schema exceeds maximum nesting depth");
  if ("$ref" in schema) throw new TypeError("MCP input schemas with $ref must be resolved before binding");
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0 || !schema.enum.every(isLiteral)) throw new TypeError("MCP schema enum must contain JSON literals");
    return Type.Union(schema.enum.map((value) => value === null ? Type.Null() : Type.Literal(value)));
  }
  if (isLiteral(schema.const)) return schema.const === null ? Type.Null() : Type.Literal(schema.const);
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (alternatives) {
    if (alternatives.length === 0 || !alternatives.every(isRecord)) throw new TypeError("MCP schema alternatives must be schemas");
    return Type.Union(alternatives.map((entry) => compileJsonSchema(entry, depth + 1)));
  }
  switch (schema.type) {
    case "object": {
      if (!isRecord(schema.properties)) throw new TypeError("MCP object schema requires properties");
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
      const properties: Record<string, TSchema> = {};
      for (const [name, child] of Object.entries(schema.properties)) {
        if (!isRecord(child)) throw new TypeError(`MCP property ${name} is not a schema`);
        const compiled = compileJsonSchema(child, depth + 1);
        properties[name] = required.has(name) ? compiled : Type.Optional(compiled);
      }
      return Type.Object(properties, { additionalProperties: schema.additionalProperties === true });
    }
    case "array":
      if (!isRecord(schema.items)) throw new TypeError("MCP array schema requires one items schema");
      return Type.Array(compileJsonSchema(schema.items, depth + 1), numericOptions(schema, ["minItems", "maxItems"]));
    case "string":
      return Type.String({ ...numericOptions(schema, ["minLength", "maxLength"]), ...(typeof schema.pattern === "string" ? { pattern: schema.pattern } : {}) });
    case "integer":
      return Type.Integer(numericOptions(schema, ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]));
    case "number":
      return Type.Number(numericOptions(schema, ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]));
    case "boolean": return Type.Boolean();
    case "null": return Type.Null();
    default: throw new TypeError(`Unsupported MCP JSON Schema type: ${String(schema.type)}`);
  }
}

function numericOptions(schema: Record<string, unknown>, keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.flatMap((key) => typeof schema[key] === "number" ? [[key, schema[key] as number]] : []));
}

function isLiteral(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
