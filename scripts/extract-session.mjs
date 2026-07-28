#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { redactSensitiveValue } from "@civaapple/qi-agent/capability";
import { inspectQiSession } from "@civaapple/qi-agent/extensions";
import { SqliteEventStore } from "@civaapple/qi-node/storage";
import {
  defaultQiHome as resolveDefaultQiHome,
  workspaceProjectId,
} from "@civaapple/qi-node/paths";
import { projectWebSession } from "@civaapple/qi-web";

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  await main(process.argv.slice(2));
}

async function main(argv) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(`Usage (options MUST follow the script path — Node/npm may steal leading flags):
  node scripts/extract-session.mjs --url URL
  node scripts/extract-session.mjs --session SESSION_ID --workspace-root WORKSPACE
  node scripts/extract-session.mjs --session SESSION_ID --db SQLITE_PATH
  node scripts/extract-session.mjs --session SESSION_ID --project PROJECT_ID
  [--list-runs] [--run ID|last] [--problems|--last-step|--step ID|--action ID] [--detail]
  [--all]  Legacy bounded full report (explicit opt-in)

Do NOT write:  node --workspace-root DIR scripts/extract-session.mjs
Do NOT pass Qi flags through bare npm without \`--\` (npm's own --workspace steals them).

Database resolution for --workspace-root (first existing path wins):
  1. $QI_HOME/projects/<project-id>/state/qi.sqlite (TUI default)
--workspace is accepted as an alias of --workspace-root (same placement rules).
--project uses $QI_HOME/projects/<project-id>/state/qi.sqlite directly.
--url may include ?project=<project-id> for local SQLite fallback when Web is down.
Or set QI_WORKSPACE to the Workspace root instead of passing --workspace-root.
`);
      process.exit(0);
    }

    const loaded = options.url
      ? await loadFromUrl(options.url, options.environment)
      : loadFromDatabase(
        options.session,
        resolveSessionDatabase({
          sessionId: options.session,
          workspace: options.workspace,
          db: options.db,
          projectSlug: options.project,
          environment: options.environment,
        }),
      );
    const report = options.all
      ? createReport(loaded, options.workspace)
      : inspectQiSession(createInspectionSource(loaded), {
        operation: selectedOperation(options),
        sessionId: loaded.view.sessionId,
        ...(options.run === undefined ? {} : { runId: options.run }),
        ...(options.step === undefined ? {} : { stepId: options.step }),
        ...(options.action === undefined ? {} : { actionId: options.action }),
        ...(options.detail ? { detail: "detail" } : {}),
      });
    const sanitized = redactSensitiveValue(report);
    process.stdout.write(`${JSON.stringify(sanitized.value, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`extract-session: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

export function parseArguments(args, environment = process.env) {
  const values = new Map();
  const flags = new Set();
  const booleanOptions = new Set(["--list-runs", "--problems", "--last-step", "--detail", "--all"]);
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--help" || item === "-h") return { help: true, environment };
    if (item === "--") continue;
    if (!item?.startsWith("--")) fail(`Unexpected argument: ${item}`);
    if (booleanOptions.has(item)) {
      if (flags.has(item)) fail(`${item} may be provided only once`);
      flags.add(item);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`${item} requires a value`);
    if (values.has(item)) fail(`${item} may be provided only once`);
    values.set(item, value);
    index += 1;
  }
  const url = values.get("--url");
  const session = values.get("--session");
  const workspace = values.get("--workspace-root")
    ?? values.get("--workspace")
    ?? values.get("--project-root")
    ?? optionalEnv(environment, "QI_WORKSPACE");
  const db = values.get("--db");
  const project = values.get("--project");
  const allowed = new Set([
    "--url",
    "--session",
    "--workspace-root",
    "--workspace",
    "--project-root",
    "--project",
    "--db",
    "--run",
    "--step",
    "--action",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) fail(`Unknown option: ${key}`);
  }
  if (url && (session || db || workspace || project)) {
    fail("--url cannot be combined with --session / --workspace-root / --project / --db");
  }
  if (!url && !session) fail("Provide --url or --session");
  if (!url && !workspace && !db && !project) {
    fail("--session requires --workspace-root, --project, --db, or QI_WORKSPACE");
  }
  if ([workspace, db, project].filter(Boolean).length > 1) {
    fail("Use only one of --workspace-root, --project, or --db");
  }
  if (values.has("--workspace") && values.has("--workspace-root")) {
    fail("Use --workspace-root (preferred) or --workspace, not both");
  }
  const selectors = [
    flags.has("--list-runs") ? "--list-runs" : undefined,
    flags.has("--problems") ? "--problems" : undefined,
    flags.has("--last-step") ? "--last-step" : undefined,
    values.has("--step") ? "--step" : undefined,
    values.has("--action") ? "--action" : undefined,
  ].filter(Boolean);
  if (selectors.length > 1) fail(`Query selectors are mutually exclusive: ${selectors.join(", ")}`);
  if (flags.has("--all") && (selectors.length > 0 || values.has("--run") || flags.has("--detail"))) {
    fail("--all cannot be combined with projection query options");
  }
  const run = values.get("--run");
  if (run !== undefined && run !== "last" && !/^run_[A-Za-z0-9_-]+$/.test(run)) {
    fail("--run must be a Run ID or last");
  }
  return {
    help: false,
    url,
    session,
    workspace,
    db,
    project,
    environment,
    listRuns: flags.has("--list-runs"),
    problems: flags.has("--problems"),
    lastStep: flags.has("--last-step"),
    detail: flags.has("--detail"),
    all: flags.has("--all"),
    run,
    step: values.get("--step"),
    action: values.get("--action"),
  };
}

export function selectedOperation(options) {
  if (options.problems) return "problems";
  if (options.lastStep) return "last-step";
  if (options.step) return "step";
  if (options.action) return "action";
  if (options.run) return "run";
  return "runs";
}

function optionalEnv(environment, name) {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

/** @deprecated Compatibility name; values are now basename plus a canonical-path hash. */
export function workspaceProjectSlug(workspaceRoot) {
  return workspaceProjectId(workspaceRoot);
}

export function defaultQiHome(environment = process.env, homeDirectory = homedir()) {
  return resolveDefaultQiHome(environment, homeDirectory);
}

export function candidateSessionDatabases({
  workspace,
  db,
  projectSlug,
  environment = process.env,
  homeDirectory = homedir(),
}) {
  if (db) return [{ kind: "explicit", path: resolve(db) }];
  const candidates = [];
  const slug = projectSlug
    ?? (workspace ? workspaceProjectSlug(workspace) : undefined);
  if (slug) {
    candidates.push({
      kind: "qi-home",
      path: resolve(defaultQiHome(environment, homeDirectory), "projects", slug, "state", "qi.sqlite"),
    });
  }
  return candidates;
}

/**
 * Resolve the Session SQLite path from the 0.6 private project layout.
 */
export function resolveSessionDatabase(options) {
  const candidates = candidateSessionDatabases(options);
  if (candidates.length === 0) {
    fail("Cannot resolve qi.sqlite; provide --workspace, --db, or a URL with ?project=");
  }
  const existing = candidates.filter((candidate) => existsSync(candidate.path));
  if (existing[0]) return existing[0].path;
  const tried = candidates.map((candidate) => `${candidate.kind}: ${candidate.path}`).join("\n  ");
  fail(`No qi.sqlite found. Tried:\n  ${tried}`);
}

async function loadFromUrl(value, environment = process.env) {
  const page = new URL(value);
  if (!new Set(["http:", "https:"]).has(page.protocol)) fail("Web URL must use HTTP or HTTPS");
  if (page.username || page.password) fail("Web URL must not contain credentials");
  const sessionId = page.searchParams.get("session");
  if (!sessionId) fail("Web URL must contain a session query parameter");
  const projectSlug = page.searchParams.get("project")?.trim() || undefined;
  const root = page.origin;
  try {
    return await loadFromWebApi(root, sessionId);
  } catch (error) {
    if (!projectSlug) throw error;
    const database = resolveSessionDatabase({ projectSlug, environment });
    const loaded = loadFromDatabase(sessionId, database);
    return {
      ...loaded,
      source: {
        ...loaded.source,
        webFallback: true,
        webError: error instanceof Error ? error.message : String(error),
        url: value,
      },
    };
  }
}

async function loadFromWebApi(root, sessionId) {
  const workbenchUrl = `${root}/api/session/${encodeURIComponent(sessionId)}/workbench`;
  const response = await fetch(workbenchUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.ok) {
    const bundle = await readBoundedJson(response);
    assertBundle(bundle, "Web workbench response");
    return { ...bundle, source: { kind: "web", url: workbenchUrl } };
  }
  if (response.status !== 404) fail(`Web workbench request failed: ${response.status} ${await response.text()}`);
  const [viewResponse, historyResponse] = await Promise.all([
    fetch(`${root}/api/session/${encodeURIComponent(sessionId)}`, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }),
    fetch(`${root}/api/session/${encodeURIComponent(sessionId)}/history`, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }),
  ]);
  if (!viewResponse.ok) fail(`Session projection request failed: ${viewResponse.status} ${await viewResponse.text()}`);
  if (!historyResponse.ok) fail(`Session history request failed: ${historyResponse.status} ${await historyResponse.text()}`);
  const view = await readBoundedJson(viewResponse);
  const events = await readBoundedJson(historyResponse);
  return {
    view,
    events,
    narrative: projectWebSession(view, events),
    source: { kind: "web", url: root, compatibilityFallback: true },
  };
}

async function readBoundedJson(response) {
  const maximumBytes = 64 * 1024 * 1024;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) fail(`Web response exceeds ${maximumBytes} bytes`);
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumBytes) fail(`Web response exceeds ${maximumBytes} bytes`);
  try {
    return JSON.parse(text);
  } catch {
    fail("Web response is not valid JSON");
  }
}

function loadFromDatabase(sessionId, databasePath) {
  const store = new SqliteEventStore(resolve(databasePath), { readonly: true });
  try {
    const view = store.load(sessionId);
    if (!view) fail(`Session ${sessionId} does not exist in ${resolve(databasePath)}`);
    const events = store.read(sessionId).events;
    const inspectionCatalog = store.listSessions().slice(0, 50);
    const ownershipViews = Object.fromEntries(
      inspectionCatalog
        .filter((summary) => summary.sessionId !== sessionId)
        .map((summary) => {
          const other = store.load(summary.sessionId);
          return [summary.sessionId, other ? ownershipProjection(other) : undefined];
        })
        .filter(([, other]) => other !== undefined),
    );
    return {
      view,
      events,
      narrative: projectWebSession(view, events),
      inspectionCatalog,
      ownershipViews,
      source: { kind: "sqlite", database: resolve(databasePath) },
    };
  } finally {
    store.close();
  }
}

function assertBundle(value, label) {
  if (!isRecord(value) || !isRecord(value.view) || !isRecord(value.narrative) || !Array.isArray(value.events)) {
    fail(`${label} is missing view, narrative, or events`);
  }
}

function createInspectionSource(bundle) {
  return {
    listSessions() {
      return bundle.inspectionCatalog ?? [{
        sessionId: bundle.view.sessionId,
        title: bundle.view.title ?? bundle.view.sessionId,
        version: bundle.events.length,
        updatedAt: bundle.events.at(-1)?.occurredAt ?? "",
      }];
    },
    load(sessionId) {
      return sessionId === bundle.view.sessionId
        ? bundle.view
        : bundle.ownershipViews?.[sessionId];
    },
    read(sessionId, afterVersion = 0) {
      return {
        sessionId,
        version: bundle.events.length,
        events: sessionId === bundle.view.sessionId ? bundle.events.slice(afterVersion) : [],
      };
    },
  };
}

function ownershipProjection(view) {
  return {
    runOrder: view.runOrder,
    runs: Object.fromEntries(view.runOrder.map((runId) => {
      const run = view.runs[runId];
      return [runId, {
        steps: Object.fromEntries(Object.keys(run?.steps ?? {}).map((stepId) => [stepId, {}])),
        actions: Object.fromEntries(Object.keys(run?.actions ?? {}).map((actionId) => [actionId, {}])),
      }];
    })),
  };
}

function createReport(bundle, workspace) {
  const events = bundle.events;
  const narrative = bundle.narrative;
  const signals = detectSignals(narrative, events);
  const eventCounts = countBy(events, (event) => event.type);
  return {
    schemaVersion: 1,
    extractedAt: new Date().toISOString(),
    source: bundle.source,
    ...(workspace ? { workspace: resolve(workspace) } : {}),
    session: {
      sessionId: bundle.view.sessionId,
      title: bundle.view.title,
      version: bundle.view.version,
      presence: bundle.view.presence,
      eventCount: events.length,
      runCount: narrative.runs.length,
      formalGoalCount: Object.keys(bundle.view.goals ?? {}).length,
      formalEvidenceCount: Object.keys(bundle.view.evidence ?? {}).length,
      acceptedMemoryCount: Object.values(bundle.view.memories ?? {}).filter((memory) => memory.status === "accepted").length,
    },
    eventCounts,
    signals,
    runs: narrative.runs.map((run) => ({
      runId: run.runId,
      trigger: run.trigger,
      input: boundString(run.input, 4_000),
      status: run.status,
      displayStatus: run.displayStatus,
      terminalReason: run.terminalReason,
      startSequence: run.startSequence,
      endSequence: run.endSequence,
      durationMs: run.durationMs,
      summary: run.summary,
      compactions: events.filter((event) => event.type === "context.compacted" && event.data.runId === run.runId)
        .map((event) => ({ sequence: event.sequence, ...event.data })),
      evaluations: events.filter((event) => event.type === "evaluation.completed" && event.data.runId === run.runId)
        .map((event) => ({ sequence: event.sequence, ...event.data })),
      steps: run.steps.map((step) => ({
        stepId: step.stepId,
        index: step.index,
        status: step.status,
        finishReason: step.finishReason,
        startSequence: step.startSequence,
        endSequence: step.endSequence,
        provider: step.provider,
        model: step.model,
        modelText: boundString(step.modelText, 4_000),
        context: step.context,
        rejectedCalls: step.rejectedCalls,
        actions: step.actions.map((action) => ({
          actionId: action.actionId,
          toolName: action.toolName,
          effect: action.effect,
          resources: action.resources,
          target: action.target,
          input: boundValue(action.input),
          status: action.status,
          errorCode: action.errorCode,
          terminalDetail: action.terminalDetail,
          resultSummary: action.resultSummary,
          diff: boundString(action.diff, 12_000),
          diffTruncated: action.diffTruncated,
          durationMs: action.durationMs,
          recovered: action.recovered,
          milestones: action.milestones,
        })),
      })),
    })),
  };
}

function detectSignals(narrative, events) {
  const signals = [];
  for (const run of narrative.runs) {
    const actions = run.steps.flatMap((step) => step.actions);
    const writeActions = actions.filter((action) => action.effect === "write" && action.status === "completed");
    const failedActions = actions.filter((action) => action.status === "failed");
    const indeterminate = actions.filter((action) => action.status === "indeterminate");
    if (run.status === "failed" || run.status === "parked") {
      signals.push(signal("high", "RUN_TERMINAL_PROBLEM", `${run.displayStatus}: ${run.terminalReason ?? "no reason recorded"}`, {
        runId: run.runId,
        sequences: compactSequences(run.startSequence, run.endSequence),
      }));
    }
    for (const action of indeterminate) {
      signals.push(signal("critical", "INDETERMINATE_EFFECT", `${action.toolName} has an unknown effect settlement`, actionEvidence(run, action)));
    }
    for (const action of actions.filter((item) => item.status === "denied")) {
      signals.push(signal("medium", "AUTHORITY_DENIED", `${action.toolName} was denied: ${action.terminalDetail ?? "no reason recorded"}`, actionEvidence(run, action)));
    }
    for (const action of failedActions) {
      signals.push(signal(action.recovered ? "medium" : "high", action.recovered ? "ACTION_FAILED_RECOVERED" : "ACTION_FAILED", `${action.toolName} failed${action.errorCode ? ` with ${action.errorCode}` : ""}${action.recovered ? " and the Run later recovered" : ""}`, actionEvidence(run, action)));
    }
    const rejected = run.steps.flatMap((step) => step.rejectedCalls.map((call) => ({ stepId: step.stepId, ...call })));
    for (const call of rejected) {
      signals.push(signal("medium", "MODEL_ACTION_REJECTED", `${call.toolName} was rejected with ${call.errorCode}: ${call.reason}`, { runId: run.runId, stepId: call.stepId }));
    }
    const repeated = countBy(failedActions, (action) => `${action.toolName}:${action.errorCode ?? "UNKNOWN"}`);
    for (const [fingerprint, count] of Object.entries(repeated)) {
      if (count >= 2) signals.push(signal("high", "REPEATED_ACTION_FAILURE", `${fingerprint} repeated ${count} times`, { runId: run.runId }));
    }
    const compacted = events.filter((event) => event.type === "context.compacted" && event.data.runId === run.runId);
    if (compacted.length > 0) {
      const hardLimit = compacted.some((event) => event.data.reason === "hard-limit");
      signals.push(signal(hardLimit ? "medium" : "info", "CONTEXT_COMPACTED", `${compacted.length} exchange(s) compacted${hardLimit ? " at a hard limit" : " under pressure"}`, {
        runId: run.runId,
        sequences: compacted.map((event) => event.sequence),
      }));
    }
    if (run.summary.stepCount >= 12) {
      signals.push(signal("info", "LONG_RUN", `${run.summary.stepCount} Steps and ${run.summary.actionCount} Actions warrant a convergence review`, { runId: run.runId }));
    }
    if (writeActions.length > 0 && run.displayStatus === "responded" && !actions.some(isVerificationAction)) {
      signals.push(signal("medium", "MUTATION_WITHOUT_OBSERVED_VERIFICATION", `${writeActions.length} completed mutation(s), but no declared or recognizable verification Action was observed`, { runId: run.runId }));
    }
    if (writeActions.length > 0 && run.displayStatus === "responded") {
      signals.push(signal("info", "NO_FORMAL_ACCEPTANCE", "Workspace mutation ended with response completion, not evidence-backed verified completion", { runId: run.runId }));
    }
    if (run.displayStatus === "responded" && writeActions.length === 0) {
      const finalText = [...run.steps]
        .reverse()
        .map((step) => step.modelText)
        .find((text) => typeof text === "string" && text.trim().length > 0);
      if (typeof finalText === "string" && claimsVerbalWorkspaceMutation(finalText)) {
        signals.push(signal(
          "medium",
          "CLAIMED_MUTATION_WITHOUT_ACTIONS",
          "Final response claims a Workspace mutation, but this Run had no completed write Action",
          { runId: run.runId },
        ));
      }
    }
    const failedDedicated = failedActions.filter((action) => new Set(["edit", "write", "move", "remove"]).has(action.toolName));
    const laterShellMutation = actions.find((action) => action.toolName === "shell" && action.status === "completed" && action.diff);
    if (failedDedicated.length > 0 && laterShellMutation) {
      signals.push(signal("medium", "DEDICATED_TOOL_TO_SHELL_FALLBACK", "A dedicated mutation failed before a shell Action produced a Workspace diff", {
        runId: run.runId,
        actionIds: [...failedDedicated.map((action) => action.actionId), laterShellMutation.actionId],
      }));
    }
    for (const action of actions) {
      const gaps = [];
      if (!action.milestones.proposed) gaps.push("proposal");
      if (action.effect !== "read" && !action.milestones.authorityGranted && action.status !== "denied") gaps.push("authority grant");
      if (["completed", "failed", "indeterminate"].includes(action.status) && !action.milestones.started) gaps.push("executor start");
      if (["completed", "failed", "cancelled", "denied", "indeterminate"].includes(action.status) && !action.milestones.terminal) gaps.push("terminal settlement");
      if (gaps.length > 0) signals.push(signal("high", "ACTION_LIFECYCLE_GAP", `${action.toolName} is missing ${gaps.join(", ")}`, actionEvidence(run, action)));
    }
  }
  return signals.sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
}

function isVerificationAction(action) {
  if (action.toolName === "verify") return true;
  if (action.toolName !== "shell") return false;
  const value = isRecord(action.input) ? action.input : {};
  const command = [value.command, ...(Array.isArray(value.args) ? value.args : [])].filter((item) => typeof item === "string").join(" ").toLowerCase();
  return /(?:^|\s)(?:test|typecheck|lint|build)(?:\s|$)|pytest|go test|cargo test|mvn(?:w)? .*test|gradle(?:w)? .*test/.test(command);
}

/** Narrow prose patterns that claim a durable Workspace mutation completed. */
export function claimsVerbalWorkspaceMutation(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  return (
    /已(?:经)?修复|已实际(?:执行|修改|完成|落盘)|(?:两处|问题)?都改掉了|已改掉|本轮实际修改成功|刚刚已用\s*`?edit`?|已用\s*`?edit`?\s*工具|(?:编辑工具|edit)\s*返回(?:了)?(?:确认\s*)?diff|diff\s*(?:均)?确认|强制滚动代码已(?:彻底)?删除|改动已实际落盘/i
      .test(text)
    || /\balready\s+fixed\b|\bedit\s+returned\s+(?:a\s+)?diff\b|\bmutation\s+(?:has\s+)?landed\b|\bfixed\s+with\s+(?:an?\s+)?edit\b/i
      .test(text)
  );
}

export { detectSignals };

function actionEvidence(run, action) {
  return {
    runId: run.runId,
    stepId: action.stepId,
    actionId: action.actionId,
    toolName: action.toolName,
    sequences: Object.values(action.milestones).filter(Number.isInteger),
  };
}

function signal(severity, code, observation, evidence) {
  return { severity, code, observation, evidence };
}

function severityRank(value) {
  return ({ critical: 0, high: 1, medium: 2, info: 3 })[value] ?? 4;
}

function compactSequences(...values) {
  return values.filter(Number.isInteger);
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = selector(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function boundValue(value, depth = 0) {
  if (typeof value === "string") return boundString(value, 4_000);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 5) return "[depth truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => boundValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, boundValue(item, depth + 1)]));
}

function boundString(value, maximum) {
  if (typeof value !== "string") return value;
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n… truncated by extractor`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function fail(message) {
  throw new Error(message);
}
