import { parseQiSelfModel, type QiSelfModel } from "./schema.js";

const packablePreviewPackages = new Set([
  "@civaapple/qi-agent",
  "@civaapple/qi-ai",
  "@civaapple/qi-node",
  "@civaapple/qi-protocol",
  "@civaapple/qi-tui",
]);

export const qiSelfModel: QiSelfModel = parseQiSelfModel({
  schemaVersion: 1,
  release: "0.7.0",
  generatedAt: "2026-07-28T00:00:00.000Z",
  identity: {
    name: "Qi",
    purpose: "A local-first, event-driven, evidence-first Agent runtime for people and Agents to act in one observable, branchable, recoverable world.",
    primaryDesign: "design/system-design.md",
    implementationPlan: "CONTRIBUTING.md",
    releaseRoadmap: "design/roadmap.md",
  },
  topology: {
    executionOwner: "The local embedded TUI runtime is the only current interactive execution owner.",
    webRole: "The Web workbench is a read-only understanding surface over committed Session truth.",
    publicEmbeddingSurface: "@civaapple/qi-agent composes the ordinary default-deny TurnLoop boundaries.",
    selfModelOwner: "@civaapple/qi-agent/extensions owns schema, validation, queries, context rendering, and the read-only Tool.",
  },
  packages: [
    pkg("@civaapple/qi", "apps/cli", "application", "CLI composition and interactive terminal runtime owner", "Auth, policy, Tool wiring, persistence, and process ownership; consumes @civaapple/qi-tui", "integration-verified", "apps/cli/README.md"),
    pkg("@civaapple/qi-agent", "packages/agent", "core", "State machine, lifecycle, authority, Tool and Effect ports, memory, evaluation, and extension contracts", "Portable Agent behavior; no Node storage, filesystem, process, or transport adapters", "integration-verified", "packages/agent/README.md"),
    pkg("@civaapple/qi-ai", "packages/ai", "adapter", "Portable model protocol, provider adapters, and deterministic context compilation", "Model and context boundary; not Agent lifecycle policy", "integration-verified", "packages/ai/README.md"),
    pkg("@civaapple/qi-node", "packages/node", "adapter", "Node paths, SQLite, Workspace, Tools, Skills, MCP, CodeAct, Scheduler, stream, and declarative package storage", "Concrete Node adapters; authority remains in Agent ports", "integration-verified", "packages/node/README.md"),
    pkg("@civaapple/qi-protocol", "packages/protocol", "core", "Durable IDs and Session event schemas", "Wire truth; no orchestration or transition policy", "integration-verified", "packages/protocol/README.md"),
    pkg("@civaapple/qi-tui", "packages/tui", "adapter", "Reusable terminal presenters, controls, panels, and themes", "Projects supplied Session truth; owns no Runtime, auth, policy, or effects", "integration-verified", "packages/tui/README.md"),
    pkg("@civaapple/qi-web", "apps/web", "application", "Read-only Web workbench", "Committed history inspection; never an execution owner", "integration-verified", "apps/web/README.md"),
  ],
  invariants: [
    invariant("append-only-session-truth", "The append-only Session event stream is durable truth; projections are rebuildable.", "AGENTS.md#non-negotiable-invariants"),
    invariant("authority-before-executor", "Authority grants and ActionStarted persist before Tool executor entry.", "AGENTS.md#non-negotiable-invariants"),
    invariant("default-deny", "Capability checks deny by default and delegation cannot widen authority.", "AGENTS.md#non-negotiable-invariants"),
    invariant("separate-tool-phases", "Discovery, validation, authorization, execution, and settlement remain separate.", "AGENTS.md#non-negotiable-invariants"),
    invariant("journal-non-read-effects", "Non-read effects use the Effect Journal; indeterminate effects are not automatically retried.", "AGENTS.md#non-negotiable-invariants"),
    invariant("distinct-outcomes", "Failed, cancelled, parked, denied, and indeterminate outcomes do not collapse.", "AGENTS.md#non-negotiable-invariants"),
    invariant("evidence-completion", "Verified completion requires matching evidence; uncalibrated semantic judgment remains unknown.", "AGENTS.md#non-negotiable-invariants"),
    invariant("knowledge-not-authority", "Skills, MCP metadata, self knowledge, and model prose never grant authority.", "AGENTS.md#non-negotiable-invariants"),
    invariant("safe-steering", "Steering applies only at a safe Step boundary.", "AGENTS.md#non-negotiable-invariants"),
    invariant("single-responsible-agent", "Multi-Agent execution is opt-in and cannot expand the parent Session's authority.", "AGENTS.md#non-negotiable-invariants"),
    invariant("protected-paths", ".qi, .git, and .artifacts never enter Agent file-tool authority.", "AGENTS.md#non-negotiable-invariants"),
    invariant("no-self-authorization", "Self-introspection cannot grant authority, publish, or self-certify semantic success.", "design/decisions.md#adr-0019-make-self-understanding-read-only-and-governed"),
  ],
  decisions: [
    decision("0001", "Redact secrets at model and durable-event boundaries", "adr-0001-redact-secrets-at-model-and-durable-event-boundaries"),
    decision("0002", "Separate model window, output reserve, and working context", "adr-0002-separate-model-window-output-reserve-and-working-context"),
    decision("0003", "Use freshness-checked precise file mutation", "adr-0003-use-freshness-checked-precise-file-mutation"),
    decision("0004", "Discover Skills progressively and install through a bounded service", "adr-0004-discover-skills-progressively-and-install-them-through-a-bounded-service"),
    decision("0005", "Keep provisional activity outside durable Session truth", "adr-0005-keep-provisional-activity-outside-durable-session-truth"),
    decision("0006", "Represent long-lived processes as bounded ProcessTasks", "adr-0006-represent-long-lived-processes-as-bounded-processtasks"),
    decision("0008", "Limit Subagent delegation to one isolated layer", "adr-0008-limit-subagent-delegation-to-one-isolated-layer"),
    decision("0009", "Use explicit provider profiles and execution-side credentials", "adr-0009-use-explicit-provider-profiles-and-execution-side-credentials"),
    decision("0011", "Make human control and Ask/Plan/Agent modes durable", "adr-0011-make-human-control-and-askplanagent-modes-durable"),
    decision("0013", "Keep interaction, activation, and product language separate", "adr-0013-keep-interaction-activation-and-product-language-separate"),
    decision("0014", "Preserve Session compatibility through explicit migrations", "adr-0014-preserve-session-compatibility-through-explicit-migrations"),
    decision("0015", "Separate project policy from Session mount facts", "adr-0015-separate-project-policy-from-session-mount-facts"),
    decision("0016", "Keep execution local and Web read-only", "adr-0016-keep-execution-local-and-web-read-only"),
    decision("0017", "Bound TUI transcript work", "adr-0017-bound-tui-transcript-work"),
    decision("0018", "Publish a modular open-source Runtime", "adr-0018-publish-a-modular-open-source-runtime"),
    decision("0019", "Make self-understanding read-only and governed", "adr-0019-make-self-understanding-read-only-and-governed"),
    decision("0020", "Use Qi as the only product and persistence namespace", "adr-0020-use-qi-as-the-only-product-and-persistence-namespace"),
    decision("0022", "Centralize machine-private state under a generationed QI_HOME layout", "adr-0022-centralize-machine-private-state-under-a-generationed-qihome-layout"),
    decision("0023", "Allow declaration-only packages without granting authority", "adr-0023-allow-declaration-only-packages-without-granting-authority"),
  ],
  gaps: [
    gap("registry-consumer-unverified", "A clean consumer cannot yet resolve Qi dependencies from a public registry.", "The current isolated test installs the complete local tarball set because no packages have been published.", "After publication, install each top-level package from the registry and rerun JS/TS consumers.", true),
    gap("tui-registry-consumer-unverified", "The reusable @civaapple/qi-tui package is not yet registry-installable.", "Its local tarball passes a dependency-closure-isolated JS/TS consumer and registry identity is confirmed, but no publication has occurred.", "After publication, install @civaapple/qi-tui alone from the registry and run the public component example.", true),
    gap("security-contact-unconfirmed", "The public private-reporting destination is not configured.", "SECURITY.md intentionally leaves the destination as a release gate.", "Maintainers configure and publish the real security contact.", true),
    gap("conduct-policy-unconfirmed", "The final community conduct policy is not selected.", "GOVERNANCE.md defines interim expectations but leaves the detailed policy and moderation contact pending.", "Maintainers add a code of conduct or explicitly decide not to adopt a separate one.", true),
    gap("source-archive-blocked", "The versioned source archive is not yet eligible for generation.", "The source-release engineering audit passes, but security/conduct decisions and a clean candidate commit are still required.", "Resolve the reported human-owned blockers, freeze a clean commit, and run npm run release:archive.", true),
    gap("broad-product-study-deferred", "The 5–8 participant study is not currently staffed.", "The active project team has two or three participants.", "Run the study after open source produces external users.", true),
  ],
  verification: [
    verify("typecheck", "npm run typecheck", "The TypeScript project-reference graph is valid."),
    verify("tests", "npm test", "Repository deterministic and integration tests pass."),
    verify("cli-preview", "npm run accept:preview", "The staged CLI installs and starts in isolation."),
    verify("package-readiness", "npm run packages:check", "Every packages/* workspace passes preview metadata, the combined consumer, and its own dependency-closure-isolated JS/TS consumer."),
    verify("package-plan", "npm run packages:plan", "The coordinated package graph, internal ranges, publication waves, manifest blockers, and registry identity evidence are checked without publishing."),
    verify("source-release", "npm run release:audit", "Candidate-tree hygiene, external dependency licenses, human-owned source-open blockers, and archive eligibility are reported separately."),
  ],
});

function pkg(
  name: string,
  path: string,
  kind: "core" | "adapter" | "extension" | "facade" | "application" | "introspection",
  purpose: string,
  ownerBoundary: string,
  runtimeMaturity: "implemented" | "integration-verified" | "product-validated" | "implemented-opt-in" | "integration-verified-default-off",
  canonicalReadme: string,
) {
  return {
    name,
    path,
    kind,
    purpose,
    ownerBoundary,
    runtimeMaturity,
    packageMaturity: packablePreviewPackages.has(name) ? "packable-preview" as const : "internal" as const,
    canonicalReadme,
  };
}

function invariant(id: string, summary: string, source: string) {
  return { id, summary, source };
}

function decision(
  id: string,
  title: string,
  anchor: string,
) {
  return { id: `ADR-${id}`, status: "accepted" as const, title, source: `design/decisions.md#${anchor}` };
}

function gap(
  id: string,
  summary: string,
  evidence: string,
  requiredSettlement: string,
  humanOwned: boolean,
) {
  return { id, summary, evidence, requiredSettlement, humanOwned };
}

function verify(id: string, command: string, proves: string) {
  return { id, command, proves };
}
