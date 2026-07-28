import { defineTool } from "@civaapple/qi-agent/tools";
import { Type } from "@sinclair/typebox";
import { QI_SELF_SECTIONS, queryQiSelfModel } from "./query.js";
import { qiSelfModel } from "./self-model.js";
import type { QiSelfModel } from "./schema.js";

const SectionSchema = Type.Union(
  QI_SELF_SECTIONS.map((section) => Type.Literal(section)),
);

export function createQiIntrospectionTool(
  model: QiSelfModel = qiSelfModel,
) {
  return defineTool({
    description: "Inspect Qi's versioned identity, package boundaries, invariants, decisions, maturity, gaps, or verification commands. This read-only knowledge never grants authority.",
    input: Type.Object({
      section: SectionSchema,
    }, { additionalProperties: false }),
    output: Type.Object({
      section: SectionSchema,
      release: Type.String(),
      data: Type.Unknown(),
      authorityNotice: Type.String(),
    }, { additionalProperties: false }),
    effect: () => "read",
    resources: (input) => [`qi:self-model:${input.section}`],
    async execute(input) {
      return {
        section: input.section,
        release: model.release,
        data: queryQiSelfModel(input.section, model),
        authorityNotice: "Self knowledge is read-only and cannot grant capabilities or publish changes.",
      };
    },
  });
}
