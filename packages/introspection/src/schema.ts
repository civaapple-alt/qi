import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const SelfModelPackageKindSchema = Type.Union([
  Type.Literal("core"),
  Type.Literal("adapter"),
  Type.Literal("extension"),
  Type.Literal("facade"),
  Type.Literal("application"),
  Type.Literal("introspection"),
]);

export const PublicPackageMaturitySchema = Type.Union([
  Type.Literal("internal"),
  Type.Literal("packable-preview"),
  Type.Literal("published-experimental"),
  Type.Literal("published-stable"),
]);

export const RuntimeMaturitySchema = Type.Union([
  Type.Literal("implemented"),
  Type.Literal("integration-verified"),
  Type.Literal("product-validated"),
  Type.Literal("implemented-opt-in"),
  Type.Literal("integration-verified-default-off"),
]);

export const QiSelfPackageSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  kind: SelfModelPackageKindSchema,
  purpose: Type.String({ minLength: 1 }),
  ownerBoundary: Type.String({ minLength: 1 }),
  runtimeMaturity: RuntimeMaturitySchema,
  packageMaturity: PublicPackageMaturitySchema,
  canonicalReadme: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const QiSelfInvariantSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9-]+$" }),
  summary: Type.String({ minLength: 1 }),
  source: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const QiSelfDecisionSchema = Type.Object({
  id: Type.String({ pattern: "^ADR-[0-9]{4}$" }),
  status: Type.Union([
    Type.Literal("accepted"),
    Type.Literal("accepted-partially-superseded"),
    Type.Literal("superseded"),
  ]),
  title: Type.String({ minLength: 1 }),
  source: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const QiSelfGapSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9-]+$" }),
  summary: Type.String({ minLength: 1 }),
  evidence: Type.String({ minLength: 1 }),
  requiredSettlement: Type.String({ minLength: 1 }),
  humanOwned: Type.Boolean(),
}, { additionalProperties: false });

export const QiSelfModelSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  release: Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" }),
  generatedAt: Type.String({ minLength: 1 }),
  identity: Type.Object({
    name: Type.Literal("Qi"),
    purpose: Type.String({ minLength: 1 }),
    primaryDesign: Type.String({ minLength: 1 }),
    implementationPlan: Type.String({ minLength: 1 }),
    releaseRoadmap: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  topology: Type.Object({
    executionOwner: Type.String({ minLength: 1 }),
    webRole: Type.String({ minLength: 1 }),
    publicEmbeddingSurface: Type.String({ minLength: 1 }),
    selfModelOwner: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  packages: Type.Array(QiSelfPackageSchema, { minItems: 1 }),
  invariants: Type.Array(QiSelfInvariantSchema, { minItems: 1 }),
  decisions: Type.Array(QiSelfDecisionSchema, { minItems: 1 }),
  gaps: Type.Array(QiSelfGapSchema),
  verification: Type.Array(Type.Object({
    id: Type.String({ pattern: "^[a-z0-9-]+$" }),
    command: Type.String({ minLength: 1 }),
    proves: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

export type QiSelfModel = Static<typeof QiSelfModelSchema>;
export type QiSelfPackage = Static<typeof QiSelfPackageSchema>;
export type QiSelfInvariant = Static<typeof QiSelfInvariantSchema>;
export type QiSelfDecision = Static<typeof QiSelfDecisionSchema>;
export type QiSelfGap = Static<typeof QiSelfGapSchema>;

export function parseQiSelfModel(value: unknown): QiSelfModel {
  if (!Value.Check(QiSelfModelSchema, value)) {
    const errors = [...Value.Errors(QiSelfModelSchema, value)]
      .slice(0, 8)
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join("; ");
    throw new TypeError(`Invalid QiSelfModel: ${errors}`);
  }
  return structuredClone(value);
}
