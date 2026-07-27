import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SkillCatalog } from "@civaapple/qi-skills";
import { ToolFailure, defineTool } from "@civaapple/qi-tools";
import { Type, type Static } from "@sinclair/typebox";

const SkillNameSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });
/** Single object schema so Chat Completions hosts that require parameters.type=object accept it. */
const SkillToolInputSchema = Type.Object(
  {
    operation: Type.Union([
      Type.Literal("list"),
      Type.Literal("load"),
      Type.Literal("read-resource"),
      Type.Literal("install-workspace"),
    ]),
    name: Type.Optional(SkillNameSchema),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    source: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
  },
  { additionalProperties: false },
);

type SkillToolInput = Static<typeof SkillToolInputSchema>;

export function createTuiSkillTool(catalog: SkillCatalog, workspaceRoot: string) {
  const root = resolve(workspaceRoot);
  return defineTool({
    description:
      "Discover and progressively load installed Qi Skills. Use list to refresh metadata, load only a relevant Skill's instructions, and read-resource only for a resource named by that Skill. With write authority, install-workspace publishes a validated Skill draft from an ordinary Workspace directory into .qi/skills; Skills never grant authority.",
    input: SkillToolInputSchema,
    output: Type.Unknown(),
    effect: (input: SkillToolInput) => input.operation === "install-workspace" ? "write" : "read",
    resources: (input: SkillToolInput) => {
      switch (input.operation) {
        case "list": return ["skill-catalog:local"];
        case "load": return [`skill:${input.name ?? "*"}`];
        case "read-resource": return [`skill:${input.name ?? "*"}/${input.path ?? "*"}`];
        case "install-workspace": return [
          input.source && isBareSkillName(input.source)
            ? `skill-source:local:${input.source}`
            : `file:${input.source ?? "*"}`,
          `skill:workspace:${input.name ?? "*"}`,
        ];
      }
    },
    execute: async (input: SkillToolInput) => {
      switch (input.operation) {
        case "list":
          return {
            skills: (await catalog.discover()).map(({ name, version, description, scope, shadowedUserRoot }) => ({
              name,
              version,
              description,
              scope,
              ...(shadowedUserRoot ? { shadowsUserSkill: true } : {}),
            })),
          };
        case "load": {
          const name = requireSkillField(input.name, "name", "load");
          const skill = await catalog.load(name);
          return {
            name: skill.name,
            version: skill.version,
            description: skill.description,
            scope: skill.scope,
            instructions: skill.instructions,
            resources: skill.resources,
          };
        }
        case "read-resource": {
          const name = requireSkillField(input.name, "name", "read-resource");
          const path = requireSkillField(input.path, "path", "read-resource");
          const content = await catalog.readResource(name, path);
          let text;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(content);
          } catch {
            throw new ToolFailure("SKILL_RESOURCE_BINARY", `Skill resource ${path} is not UTF-8 text`);
          }
          return { name, path, text };
        }
        case "install-workspace": {
          const name = requireSkillField(input.name, "name", "install-workspace");
          const sourceRaw = requireSkillField(input.source, "source", "install-workspace");
          const source = isBareSkillName(sourceRaw) ? sourceRaw : resolveWorkspaceDraft(root, sourceRaw);
          const installed = await catalog.install({
            source,
            scope: "workspace",
            expectedName: name,
          });
          return {
            name: installed.name,
            version: installed.version,
            description: installed.description,
            scope: installed.scope,
            installed: true,
          };
        }
      }
    },
  });
}

function requireSkillField(value: string | undefined, field: string, operation: string): string {
  if (!value?.trim()) {
    throw new ToolFailure("SKILL_INPUT", `skill ${operation} requires ${field}`);
  }
  return value.trim();
}

function isBareSkillName(source: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(source.trim());
}

function resolveWorkspaceDraft(workspaceRoot: string, source: string): string {
  if (isAbsolute(source)) throw new ToolFailure("SKILL_SOURCE_SCOPE", "Agent Skill install source must be Workspace-relative");
  const normalized = source.replaceAll("\\", "/");
  const first = normalized.split("/").find((part) => part && part !== ".");
  if (!first || new Set([".qi", ".git", ".artifacts"]).has(first)) {
    throw new ToolFailure("SKILL_SOURCE_SCOPE", "Agent Skill drafts must be outside protected Workspace paths");
  }
  const path = resolve(workspaceRoot, source);
  const prefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  if (!path.startsWith(prefix)) throw new ToolFailure("SKILL_SOURCE_SCOPE", "Agent Skill install source escapes the Workspace");
  if (relative(workspaceRoot, path).startsWith("..")) throw new ToolFailure("SKILL_SOURCE_SCOPE", "Agent Skill install source escapes the Workspace");
  return path;
}
