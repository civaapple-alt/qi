import type { CapabilityBroker } from "@civaapple/qi-capability";
import type { EventWriter } from "@civaapple/qi-loop";
import { createId, type RunId, type StepId } from "@civaapple/qi-protocol";
import type { RegisteredTool } from "@civaapple/qi-tools";

export interface GraphNode {
  id: string;
  observe: readonly string[];
  actions: readonly string[];
  skills: readonly string[];
  evaluator?: string;
}

export type DeterministicGuard =
  | { kind: "always" }
  | { kind: "fact"; path: readonly string[]; operator: "exists" | "equals" | "not-equals"; value?: unknown };

export type EdgeDecision = DeterministicGuard | { kind: "model"; choice: string; description: string };

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  when: EdgeDecision;
}

export interface GraphDefinition {
  id: string;
  version: number;
  start: string;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
}

export interface ModelRouteChoice {
  edgeId: string;
  choice: string;
  description: string;
  to: string;
}

export class GraphGovernor {
  #definition: GraphDefinition;
  #current: string;
  readonly #writer: EventWriter | undefined;
  readonly #runId: RunId | undefined;

  constructor(definition: GraphDefinition, recording?: { writer: EventWriter; runId: RunId }) {
    validateGraph(definition);
    this.#definition = structuredClone(definition);
    this.#current = definition.start;
    this.#writer = recording?.writer;
    this.#runId = recording?.runId;
    this.#writer?.append("graph.node.entered", {
      runId: this.#runId,
      graphId: definition.id,
      graphVersion: definition.version,
      nodeId: definition.start,
    }, { kind: "runtime", id: "graph-governor" });
  }

  get definition(): GraphDefinition { return structuredClone(this.#definition); }
  get currentNode(): GraphNode { return structuredClone(this.#node(this.#current)); }
  allowedActions(): readonly string[] { return [...this.#node(this.#current).actions]; }
  allowedObservations(): readonly string[] { return [...this.#node(this.#current).observe]; }

  filterTools(catalog: readonly RegisteredTool[]): RegisteredTool[] {
    const allowed = this.allowedActions();
    return catalog.filter((tool) => allowed.some((pattern) => glob(pattern, tool.name))).map((tool) => structuredClone(tool));
  }

  modelChoices(observation: unknown): ModelRouteChoice[] {
    if (this.#deterministicMatches(observation).length > 0) return [];
    return this.#outgoing().filter((edge): edge is GraphEdge & { when: Extract<EdgeDecision, { kind: "model" }> } => edge.when.kind === "model")
      .map((edge) => ({ edgeId: edge.id, choice: edge.when.choice, description: edge.when.description, to: edge.to }));
  }

  advance(observation: unknown, modelChoice?: string): { from: string; to: string; edgeId: string; decision: "deterministic" | "model" } | undefined {
    const deterministic = this.#deterministicMatches(observation);
    if (deterministic.length > 1) throw new Error(`Graph ${this.#definition.id} has ambiguous deterministic transitions from ${this.#current}`);
    let edge = deterministic[0];
    let decision: "deterministic" | "model" = "deterministic";
    if (!edge && modelChoice !== undefined) {
      const candidates = this.#outgoing().filter((candidate) => candidate.when.kind === "model" && candidate.when.choice === modelChoice);
      if (candidates.length !== 1) throw new Error(`Model choice ${modelChoice} is not uniquely allowed from ${this.#current}`);
      edge = candidates[0];
      decision = "model";
    }
    if (!edge) return undefined;
    const from = this.#current;
    this.#current = edge.to;
    this.#writer?.append("graph.transitioned", {
      runId: this.#runId,
      graphId: this.#definition.id,
      graphVersion: this.#definition.version,
      edgeId: edge.id,
      from,
      to: edge.to,
      decision,
    }, { kind: "runtime", id: "graph-governor" });
    return { from, to: edge.to, edgeId: edge.id, decision };
  }

  async replaceAuthorized(input: {
    replacement: GraphDefinition;
    definitionRef: string;
    broker: CapabilityBroker;
    subject: string;
    writer: EventWriter;
    runId: RunId;
    stepId: StepId;
  }): Promise<boolean> {
    validateGraph(input.replacement);
    if (input.replacement.id !== this.#definition.id) throw new Error("A graph update cannot change graph identity");
    if (input.replacement.version !== this.#definition.version + 1) throw new Error("A graph update must increment version by one");
    if (!input.replacement.nodes.some((node) => node.id === this.#current)) throw new Error("A graph update cannot remove the current node");
    const actionId = createId("act");
    const ref = { runId: input.runId, stepId: input.stepId, actionId };
    input.writer.append("action.proposed", {
      ...ref,
      toolName: "graph.modify",
      input: { graphId: this.#definition.id, toVersion: input.replacement.version, definitionRef: input.definitionRef },
      resources: [`graph:${this.#definition.id}`],
      effect: "write",
    }, { kind: "agent", id: input.subject });
    input.writer.append("authority.requested", ref, { kind: "runtime", id: "capability-broker" });
    const decision = await input.broker.authorize({ actionId, subject: input.subject, tool: "graph.modify", effect: "write", resources: [`graph:${this.#definition.id}`] });
    if (decision.outcome === "denied") {
      input.writer.append("authority.denied", { ...ref, reason: decision.reason, policyTrace: decision.trace }, { kind: "runtime", id: "capability-broker" });
      return false;
    }
    input.writer.append("authority.granted", { ...ref, leaseId: decision.leaseId, policyTrace: decision.trace }, { kind: "runtime", id: "capability-broker" });
    input.writer.append("action.started", ref, { kind: "runtime", id: "graph-governor" });
    input.writer.append("graph.definition.updated", {
      ...ref,
      graphId: this.#definition.id,
      fromVersion: this.#definition.version,
      toVersion: input.replacement.version,
      definitionRef: input.definitionRef,
    }, { kind: "runtime", id: "graph-governor" });
    this.#definition = structuredClone(input.replacement);
    input.writer.append("action.completed", { ...ref, modelOutput: [{ type: "text", text: `Graph updated to version ${input.replacement.version}` }] }, { kind: "runtime", id: "graph-governor" });
    return true;
  }

  #node(id: string): GraphNode {
    const node = this.#definition.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`Graph node ${id} is missing`);
    return node;
  }
  #outgoing(): GraphEdge[] { return this.#definition.edges.filter((edge) => edge.from === this.#current); }
  #deterministicMatches(observation: unknown): GraphEdge[] {
    return this.#outgoing().filter((edge) => edge.when.kind !== "model" && evaluateGuard(edge.when, observation));
  }
}

export function validateGraph(definition: GraphDefinition): void {
  if (!definition || typeof definition !== "object" || !definition.id || !Number.isInteger(definition.version) || definition.version < 1) throw new TypeError("Graph requires an ID and positive integer version");
  if (!Array.isArray(definition.nodes) || definition.nodes.length === 0 || !Array.isArray(definition.edges)) throw new TypeError("Graph requires node and edge arrays");
  unique(definition.nodes.map((node) => node.id), "node");
  unique(definition.edges.map((edge) => edge.id), "edge");
  const nodes = new Set(definition.nodes.map((node) => node.id));
  if (!nodes.has(definition.start)) throw new TypeError(`Graph start node ${definition.start} is missing`);
  for (const node of definition.nodes) {
    if (!node || typeof node !== "object" || !node.id || !Array.isArray(node.actions) || !Array.isArray(node.observe) || !Array.isArray(node.skills) || node.actions.some((action: unknown) => typeof action !== "string" || !action)) throw new TypeError("Graph nodes require IDs and valid selector arrays");
  }
  const modelChoices = new Set<string>();
  for (const edge of definition.edges) {
    if (!edge || typeof edge !== "object" || !edge.id || !edge.when || typeof edge.when !== "object") throw new TypeError("Graph edges require IDs and decisions");
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new TypeError(`Graph edge ${edge.id} references a missing node`);
    if (edge.when.kind === "model") {
      if (!edge.when.choice || !edge.when.description) throw new TypeError(`Model edge ${edge.id} needs a choice and description`);
      const key = `${edge.from}\0${edge.when.choice}`;
      if (modelChoices.has(key)) throw new TypeError(`Model choice ${edge.when.choice} is duplicated from ${edge.from}`);
      modelChoices.add(key);
    } else if (edge.when.kind === "fact") {
      if (!Array.isArray(edge.when.path) || edge.when.path.length === 0 || !edge.when.path.every((part: unknown) => typeof part === "string" && part)) throw new TypeError(`Fact edge ${edge.id} needs a path`);
      if (!["exists", "equals", "not-equals"].includes(edge.when.operator)) throw new TypeError(`Fact edge ${edge.id} has an invalid operator`);
    } else if (edge.when.kind !== "always") {
      throw new TypeError(`Graph edge ${edge.id} has an unsupported decision kind`);
    }
  }
}

function evaluateGuard(guard: DeterministicGuard, observation: unknown): boolean {
  if (guard.kind === "always") return true;
  let value = observation;
  for (const key of guard.path) {
    if (typeof value !== "object" || value === null || !(key in value)) return guard.operator === "not-equals";
    value = (value as Record<string, unknown>)[key];
  }
  if (guard.operator === "exists") return true;
  const equal = JSON.stringify(value) === JSON.stringify(guard.value);
  return guard.operator === "equals" ? equal : !equal;
}

function unique(values: readonly string[], label: string): void {
  if (values.some((value) => !value) || new Set(values).size !== values.length) throw new TypeError(`Graph ${label} IDs must be non-empty and unique`);
}

function glob(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
