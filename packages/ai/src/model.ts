import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const ModelRefSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 100 }),
    model: Type.String({ minLength: 1, maxLength: 200 }),
    profile: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);

export const ModelContentPartSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("text"), text: Type.String({ maxLength: 1_000_000 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("image"),
      uri: Type.String({ minLength: 1, maxLength: 6_000_000 }),
      mediaType: Type.String({ minLength: 1, maxLength: 200 }),
      width: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      height: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("artifact"),
      ref: Type.String({ minLength: 1, maxLength: 500 }),
      mediaType: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      width: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      height: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      fallbackText: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("tool-result"),
      callId: Type.String({ minLength: 1, maxLength: 200 }),
      output: Type.Unknown(),
      isError: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("tool-call"),
      callId: Type.String({ minLength: 1, maxLength: 200 }),
      name: Type.String({ minLength: 1, maxLength: 128 }),
      input: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
]);

export const ModelMessageSchema = Type.Object(
  {
    role: Type.Union([
      Type.Literal("system"),
      Type.Literal("user"),
      Type.Literal("assistant"),
      Type.Literal("tool"),
    ]),
    content: Type.Array(ModelContentPartSchema),
  },
  { additionalProperties: false },
);

export const PortableToolSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,127}$" }),
    description: Type.String({ minLength: 1, maxLength: 10_000 }),
    inputSchema: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ModelRequestSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1, maxLength: 200 }),
    model: ModelRefSchema,
    messages: Type.Array(ModelMessageSchema, { minItems: 1 }),
    tools: Type.Array(PortableToolSchema),
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false },
);

export const ModelEventSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("text.delta"), delta: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("reasoning.delta"), delta: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("action.requested"),
      callId: Type.String({ minLength: 1, maxLength: 200 }),
      name: Type.String({ minLength: 1, maxLength: 128 }),
      input: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("usage"),
      inputTokens: Type.Integer({ minimum: 0 }),
      outputTokens: Type.Integer({ minimum: 0 }),
      cachedInputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("completed"),
      finishReason: Type.Union([
        Type.Literal("stop"),
        Type.Literal("actions"),
        Type.Literal("length"),
      ]),
      responseId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("failed"),
      code: Type.String({ minLength: 1, maxLength: 128 }),
      message: Type.String({ minLength: 1, maxLength: 10_000 }),
      retryable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);

export type ModelRef = Static<typeof ModelRefSchema>;
export type ModelContentPart = Static<typeof ModelContentPartSchema>;
export type ModelMessage = Static<typeof ModelMessageSchema>;
export type PortableTool = Static<typeof PortableToolSchema>;
export type ModelRequest = Static<typeof ModelRequestSchema>;
export type ModelEvent = Static<typeof ModelEventSchema>;

export interface ModelCapabilities {
  readonly input: ReadonlySet<"text" | "image" | "artifact">;
  readonly output: ReadonlySet<"text" | "reasoning" | "action">;
  readonly contextTokens: number;
  readonly parallelActions: boolean;
  readonly promptCache: boolean;
}

export interface ModelPort {
  capabilities(model: ModelRef): Promise<ModelCapabilities>;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}

function parse<T>(schema: Parameters<typeof Value.Check>[0], value: unknown, label: string): T {
  if (Value.Check(schema, value)) return value as T;
  const details = [...Value.Errors(schema, value)]
    .slice(0, 8)
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
  throw new TypeError(`${label} is invalid: ${details}`);
}

export function parseModelRequest(value: unknown): ModelRequest {
  return parse<ModelRequest>(ModelRequestSchema, value, "ModelRequest");
}

export function parseModelEvent(value: unknown): ModelEvent {
  return parse<ModelEvent>(ModelEventSchema, value, "ModelEvent");
}
