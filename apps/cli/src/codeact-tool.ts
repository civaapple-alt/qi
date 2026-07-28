import type { EventStore } from "@civaapple/qi-agent/kernel";
import { CodeActRunner, ContainerProgramSandbox, ControlledToolClient } from "@civaapple/qi-node/codeact";
import type { RunId, SessionId, StepId } from "@civaapple/qi-protocol";
import { ToolFailure, defineTool, type ArtifactStore, type ToolRegistry } from "@civaapple/qi-node/tools";
import { Type, type Static } from "@sinclair/typebox";

const CodeActInputSchema = Type.Object(
  {
    program: Type.String({
      minLength: 1,
      maxLength: 20_000,
      description: "ES module source that exports `async function main(api)`; `api.call(name, input)` invokes a Qi Tool.",
    }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 60_000 })),
  },
  { additionalProperties: false },
);

type CodeActInput = Static<typeof CodeActInputSchema>;

export interface CodeActToolDeps {
  eventStore: EventStore;
  toolRegistry: ToolRegistry;
  artifactStore: ArtifactStore;
  workspaceRoot: string;
  runtime: "docker" | "podman";
  image?: string;
}

/**
 * Runs a short generated program inside a network-off, read-only-root container. Every nested `api.call`
 * still passes through the normal Tool Registry, capability authorization, and Session event lifecycle;
 * the allowlist below mirrors the outer agent's currently registered tools but always excludes `codeact`
 * and `delegate` so a program cannot recurse into another sandbox or chain into Subagent delegation.
 */
export function createCodeActTool(deps: CodeActToolDeps) {
  return defineTool({
    description:
      "Run a short generated program (async function main(api)) in an isolated, network-off container for " +
      "compact control logic — loops, branching, and combining several tool results — that would otherwise take " +
      "many separate tool calls. The program receives no ambient filesystem, network, or credentials; every " +
      "api.call(name, input) becomes a normal authorized Action with its own durable events. Prefer ordinary " +
      "tools for a single step; prefer codeact when the same coordination would take several dependent calls.",
    input: CodeActInputSchema,
    output: Type.Object(
      {
        output: Type.Unknown(),
        isolation: Type.Literal("container"),
        runtime: Type.Union([Type.Literal("docker"), Type.Literal("podman")]),
      },
      { additionalProperties: false },
    ),
    effect: () => "execute",
    resources: () => [`container-runtime:${deps.runtime}`],
    execute: async (input: CodeActInput, context) => {
      const allowedTools = deps.toolRegistry
        .catalog()
        .map((entry) => entry.name)
        .filter((name) => name !== "codeact" && name !== "delegate");
      const client = new ControlledToolClient({
        store: deps.eventStore,
        registry: deps.toolRegistry,
        sessionId: context.sessionId as SessionId,
        runId: context.runId as RunId,
        stepId: context.stepId as StepId,
        subject: context.subject,
        workspaceRoot: deps.workspaceRoot,
        artifactStore: deps.artifactStore,
        allowedTools,
        ...(context.effectJournal === undefined ? {} : { effectJournal: context.effectJournal }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const sandbox = new ContainerProgramSandbox({
        programSource: input.program,
        runtime: deps.runtime,
        ...(deps.image === undefined ? {} : { image: deps.image }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });
      const runner = new CodeActRunner(client);
      let output: unknown;
      try {
        output = await runner.run(sandbox, context.signal);
      } catch (error) {
        throw new ToolFailure(
          "CODEACT_PROGRAM_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }
      return { output, isolation: "container" as const, runtime: deps.runtime };
    },
  });
}
