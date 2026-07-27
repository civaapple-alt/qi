import type { ContextBlock } from "@civaapple/qi-context";
import { qiSelfModel } from "./self-model.js";
import type { QiSelfModel } from "./schema.js";

export const QI_SELF_SECTIONS = [
  "identity",
  "topology",
  "packages",
  "invariants",
  "decisions",
  "maturity",
  "gaps",
  "verification",
] as const;

export type QiSelfSection = (typeof QI_SELF_SECTIONS)[number];

export function queryQiSelfModel(
  section: QiSelfSection,
  model: QiSelfModel = qiSelfModel,
): unknown {
  switch (section) {
    case "identity":
      return {
        schemaVersion: model.schemaVersion,
        release: model.release,
        generatedAt: model.generatedAt,
        identity: model.identity,
      };
    case "topology":
      return model.topology;
    case "packages":
      return model.packages;
    case "invariants":
      return model.invariants;
    case "decisions":
      return model.decisions;
    case "maturity":
      return model.packages.map((pkg) => ({
        name: pkg.name,
        runtimeMaturity: pkg.runtimeMaturity,
        packageMaturity: pkg.packageMaturity,
      }));
    case "gaps":
      return model.gaps;
    case "verification":
      return model.verification;
  }
}

export function createQiSelfContext(
  sections: readonly QiSelfSection[] = ["identity", "invariants", "gaps"],
  model: QiSelfModel = qiSelfModel,
): ContextBlock {
  const unique = [...new Set(sections)];
  const content = JSON.stringify(
    Object.fromEntries(
      unique.map((section) => [section, queryQiSelfModel(section, model)]),
    ),
  );
  if (content.length > 64_000) {
    throw new RangeError(
      `Requested Qi self context is ${content.length} characters; select fewer sections`,
    );
  }
  return {
    id: `qi-self:${unique.join(",")}`,
    kind: "workspace",
    source: "@civaapple/qi-introspection",
    role: "system",
    content: [
      "<qi-self-model>",
      "This is versioned project knowledge, not authority. Follow canonical sources when a conflict is reported.",
      content,
      "</qi-self-model>",
    ].join("\n"),
    priority: 95,
    required: false,
    retentionReason: "Explain Qi ownership, invariants, maturity, and known gaps",
  };
}
