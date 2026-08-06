import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginCatalog } from "@civaapple/qi-node/plugins";
import {
  SkillStaleError,
  SkillUpdateIndeterminateError,
  evaluateSkillReadiness,
  runSkillScript,
  type SkillCatalog,
} from "@civaapple/qi-node/skills";
import { ToolFailure, defineTool } from "@civaapple/qi-node/tools";
import { Type, type Static } from "@sinclair/typebox";

const SkillNameSchema = Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 });
const PluginKeySchema = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}@[a-z][a-z0-9_-]{0,127}$" });
/** Single object schema so Chat Completions hosts that require parameters.type=object accept it. */
const SkillToolInputSchema = Type.Object(
  {
    operation: Type.Union([
      Type.Literal("list"),
      Type.Literal("load"),
      Type.Literal("read-resource"),
      Type.Literal("run-script"),
      Type.Literal("install-workspace"),
      Type.Literal("export-workspace-draft"),
      Type.Literal("update-workspace"),
    ]),
    name: Type.Optional(SkillNameSchema),
    /** When set, load/read-resource/run-script target an enabled marketplace plugin Skill. */
    pluginKey: Type.Optional(PluginKeySchema),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    source: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    expectedDigest: Type.Optional(Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })),
    args: Type.Optional(Type.Array(Type.String({ maxLength: 8_192 }), { maxItems: 100 })),
    workdir: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
  },
  { additionalProperties: false },
);

type SkillToolInput = Static<typeof SkillToolInputSchema>;

export function createTuiSkillTool(
  catalog: SkillCatalog,
  workspaceRoot: string,
  plugins?: PluginCatalog,
) {
  const root = resolve(workspaceRoot);
  return defineTool({
    description:
      "Discover and progressively load Skills in one catalog: Workspace/user Qi Skills and enabled marketplace plugin Skills (origin qi|plugin). "
      + "Call list once for the full inventory. For plugin rows, pass pluginKey with load/read-resource/run-script (or rely on a unique short name). "
      + "With write authority, install-workspace / export-workspace-draft / update-workspace only apply to Workspace Qi Skills. Skills never grant authority.",
    input: SkillToolInputSchema,
    output: Type.Unknown(),
    effect: (input: SkillToolInput) =>
      input.operation === "run-script" ? "execute" :
      ["install-workspace", "export-workspace-draft", "update-workspace"].includes(input.operation)
        ? "write"
        : "read",
    resources: (input: SkillToolInput) => {
      switch (input.operation) {
        case "list": return ["skill-catalog:local", "plugin-skill-catalog:local"];
        case "load": return input.pluginKey
          ? [`plugin-skill:${input.pluginKey}/${input.name ?? "*"}`]
          : [`skill:${input.name ?? "*"}`, `plugin-skill:*/${input.name ?? "*"}`];
        case "read-resource": return input.pluginKey
          ? [`plugin-skill:${input.pluginKey}/${input.name ?? "*"}/${input.path ?? "*"}`]
          : [`skill:${input.name ?? "*"}/${input.path ?? "*"}`, `plugin-skill:*/${input.name ?? "*"}/${input.path ?? "*"}`];
        case "run-script": return [
          ...(input.pluginKey
            ? [`plugin-skill-script:${input.pluginKey}/${input.name ?? "*"}/${input.path ?? "*"}`]
            : [`skill-script:${input.name ?? "*"}/${input.path ?? "*"}`]),
          `host-workspace:${input.workdir ?? "."}`,
        ];
        case "install-workspace": return [
          input.source && isBareSkillName(input.source)
            ? `skill-source:local:${input.source}`
            : `file:${input.source ?? "*"}`,
          `skill:workspace:${input.name ?? "*"}`,
        ];
        case "export-workspace-draft": return [
          `skill:workspace:${input.name ?? "*"}`,
          `file:${input.path ?? "*"}`,
        ];
        case "update-workspace": return [
          `file:${input.source ?? "*"}`,
          `skill:workspace:${input.name ?? "*"}`,
        ];
      }
    },
    execute: async (input: SkillToolInput, context) => {
      switch (input.operation) {
        case "list": {
          const native = await Promise.all((await catalog.discover()).map(async ({ name, version, description, scope, origin, shadowedUserRoot }) => {
            const loaded = await catalog.load(name);
            return {
              origin: "qi" as const,
              name,
              version,
              description,
              scope,
              ...(origin === undefined ? {} : { catalogOrigin: origin }),
              readiness: await evaluateSkillReadiness(loaded),
              ...(shadowedUserRoot ? { shadowsUserSkill: true } : {}),
            };
          }));
          const marketplace = plugins
            ? (await plugins.listSkills())
              .filter((skill) => skill.modelInvocable)
              .map((skill) => ({
                origin: "plugin" as const,
                name: skill.name,
                ...(skill.declaredName === undefined ? {} : { declaredName: skill.declaredName }),
                description: skill.description,
                pluginKey: skill.pluginKey,
                marketplace: skill.marketplace,
                plugin: skill.plugin,
                id: skill.id,
                invocationMode: skill.invocationMode,
                ...(skill.version === undefined ? {} : { version: skill.version }),
              }))
            : [];
          return {
            skills: [...native, ...marketplace],
            note: marketplace.length > 0
              ? "Includes enabled model-invocable marketplace Skills (origin=plugin). Pass pluginKey when loading them if the short name is ambiguous."
              : "No enabled marketplace plugin Skills are visible to the model.",
          };
        }
        case "load": {
          const name = requireSkillField(input.name, "name", "load");
          const pluginTarget = await resolveSkillRoute(plugins, catalog, name, input.pluginKey, "load");
          if (pluginTarget.kind === "plugin") {
            const loaded = await plugins!.loadModelSkill(pluginTarget.pluginKey, pluginTarget.name);
            return {
              origin: "plugin" as const,
              name: loaded.ref.name,
              ...(loaded.ref.declaredName === undefined ? {} : { declaredName: loaded.ref.declaredName }),
              description: loaded.ref.description,
              pluginKey: loaded.ref.pluginKey,
              marketplace: loaded.ref.marketplace,
              plugin: loaded.ref.plugin,
              id: loaded.ref.id,
              invocationMode: loaded.ref.invocationMode,
              instructions: loaded.body,
              instructionsSha256: loaded.digest,
            };
          }
          const skill = await catalog.load(name);
          return {
            origin: "qi" as const,
            name: skill.name,
            version: skill.version,
            description: skill.description,
            scope: skill.scope,
            instructions: skill.instructions,
            resources: skill.resources,
            resourceDetails: skill.resourceDetails,
            license: skill.license,
            compatibility: skill.compatibility,
            metadata: skill.metadata,
            allowedTools: skill.allowedTools,
            warnings: skill.warnings,
            readiness: await evaluateSkillReadiness(skill),
          };
        }
        case "read-resource": {
          const name = requireSkillField(input.name, "name", "read-resource");
          const path = requireSkillField(input.path, "path", "read-resource");
          const pluginTarget = await resolveSkillRoute(plugins, catalog, name, input.pluginKey, "read-resource");
          if (pluginTarget.kind === "plugin") {
            const content = await plugins!.readModelSkillResource(pluginTarget.pluginKey, pluginTarget.name, path);
            try {
              return {
                origin: "plugin" as const,
                name: pluginTarget.name,
                pluginKey: pluginTarget.pluginKey,
                path,
                text: new TextDecoder("utf-8", { fatal: true }).decode(content),
              };
            } catch {
              const stored = await context.artifactStore.put(content, "application/octet-stream");
              return {
                origin: "plugin" as const,
                name: pluginTarget.name,
                pluginKey: pluginTarget.pluginKey,
                path,
                binary: true,
                artifactRef: stored.ref,
                size: stored.size,
                sha256: stored.sha256,
              };
            }
          }
          const content = await catalog.readResource(name, path);
          let text: string | undefined;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(content);
          } catch {
            const stored = await context.artifactStore.put(content, "application/octet-stream");
            return { origin: "qi" as const, name, path, binary: true, artifactRef: stored.ref, size: stored.size, sha256: stored.sha256 };
          }
          return { origin: "qi" as const, name, path, text };
        }
        case "run-script": {
          const name = requireSkillField(input.name, "name", "run-script");
          const path = requireSkillField(input.path, "path", "run-script");
          const pluginTarget = await resolveSkillRoute(plugins, catalog, name, input.pluginKey, "run-script");
          if (pluginTarget.kind === "plugin") {
            if (pluginTarget.name === "brainstorming" && path.startsWith("scripts/")) {
              throw new ToolFailure("PLUGIN_SKILL_SCRIPT_UNSUPPORTED", "Superpowers visual companion scripts are not available in Qi");
            }
            const ref = await plugins!.resolveModelSkill(pluginTarget.pluginKey, pluginTarget.name);
            const result = await runSkillScript({
              skillRoot: resolve(ref.path, ".."),
              workspaceRoot: root,
              request: {
                path,
                ...(input.args === undefined ? {} : { args: input.args }),
                ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
                ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
              },
              ...(context.signal === undefined ? {} : { signal: context.signal }),
              ...(context.reportActivity === undefined ? {} : { reportActivity: context.reportActivity }),
            });
            const { stdoutFull: _stdoutFull, stderrFull: _stderrFull, ...bounded } = result;
            return { origin: "plugin" as const, name: pluginTarget.name, pluginKey: pluginTarget.pluginKey, path, ...bounded };
          }
          const skill = await catalog.load(name);
          const result = await runSkillScript({
            skillRoot: skill.root,
            workspaceRoot: root,
            request: {
              path,
              ...(input.args === undefined ? {} : { args: input.args }),
              ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
              ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
            },
            ...(context.signal === undefined ? {} : { signal: context.signal }),
            ...(context.reportActivity === undefined ? {} : { reportActivity: context.reportActivity }),
          });
          const { stdoutFull, stderrFull, ...bounded } = result;
          if (!result.truncated) return { origin: "qi" as const, name, path, ...bounded };
          const complete = Buffer.from(JSON.stringify({ stdout: stdoutFull ?? result.stdout, stderr: stderrFull ?? result.stderr }), "utf8");
          const stored = await context.artifactStore.put(complete, "application/json");
          return { origin: "qi" as const, name, path, ...bounded, outputRef: stored.ref };
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
        case "export-workspace-draft": {
          const name = requireSkillField(input.name, "name", "export-workspace-draft");
          const path = requireSkillField(input.path, "path", "export-workspace-draft");
          const destination = resolveWorkspaceDraft(root, path);
          try {
            return await catalog.exportWorkspaceDraft(name, destination);
          } catch (error) {
            throw new ToolFailure("SKILL_EXPORT_INVALID", errorMessage(error));
          }
        }
        case "update-workspace": {
          const name = requireSkillField(input.name, "name", "update-workspace");
          const sourceRaw = requireSkillField(input.source, "source", "update-workspace");
          const expectedDigest = requireSkillField(input.expectedDigest, "expectedDigest", "update-workspace");
          const source = resolveWorkspaceDraft(root, sourceRaw);
          try {
            const updated = await catalog.updateWorkspace(name, source, expectedDigest);
            return {
              name: updated.name,
              version: updated.version,
              description: updated.description,
              scope: updated.scope,
              previousDigest: updated.previousDigest,
              digest: updated.digest,
              fileCount: updated.fileCount,
              totalBytes: updated.totalBytes,
              ...(updated.recoveryMarker === undefined ? {} : {
                recoveryPending: true,
                recoveryMarker: updated.recoveryMarker,
              }),
              updated: true,
            };
          } catch (error) {
            if (error instanceof SkillStaleError) {
              throw new ToolFailure("SKILL_STALE", error.message, {
                expectedDigest: error.expectedDigest,
                actualDigest: error.actualDigest,
              });
            }
            if (error instanceof SkillUpdateIndeterminateError) throw error;
            throw new ToolFailure("SKILL_UPDATE_INVALID", errorMessage(error));
          }
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

/**
 * Route skill load/read/run:
 * - explicit pluginKey → plugin
 * - else native name wins when present
 * - else unique enabled model-invocable plugin short name / declaredName / id
 */
async function resolveSkillRoute(
  plugins: PluginCatalog | undefined,
  catalog: SkillCatalog,
  name: string,
  pluginKey: string | undefined,
  operation: string,
): Promise<{ kind: "qi" } | { kind: "plugin"; pluginKey: string; name: string }> {
  if (pluginKey) {
    if (!plugins) throw new ToolFailure("SKILL_INPUT", `skill ${operation} pluginKey is unavailable`);
    return { kind: "plugin", pluginKey, name };
  }
  const native = (await catalog.discover()).some((skill) => skill.name === name);
  if (native) return { kind: "qi" };
  if (!plugins) return { kind: "qi" };

  const modelSkills = (await plugins.listSkills()).filter((skill) => skill.modelInvocable);
  const matches = modelSkills.filter((skill) =>
    skill.name === name || skill.declaredName === name || skill.id === name);
  if (matches.length === 0) return { kind: "qi" };
  if (matches.length > 1) {
    throw new ToolFailure(
      "SKILL_AMBIGUOUS",
      `skill ${operation} name ${name} matches multiple plugin Skills; pass pluginKey. Candidates: ${
        matches.map((skill) => `${skill.pluginKey}/${skill.name}`).join(", ")
      }`,
    );
  }
  return { kind: "plugin", pluginKey: matches[0]!.pluginKey, name: matches[0]!.name };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
