---
name: analyze-qi-session
version: 1.3.2
description: Analyze a Qi Session from a Session ID plus Workspace path, or from a local Qi Web URL containing `?session=ses_...`. Use when asked to review Run, Step, and Action behavior; explain failed, parked, denied, indeterminate, recovered, looping, context-pressure, tool-fallback, verification, Formal Plan / Work Plan, verbal mutation claims, or evidence problems; or propose concrete runtime and project fixes from durable Session evidence. Prefer this Skill's extractor over ad-hoc SQLite scripts.
---

# Analyze a Qi Session

Treat the append-only Session events as truth and Web views as derived projections. Diagnose before changing code.

## Acquire the trace

Accept either input form:

- Web URL: `http://127.0.0.1:4317/?session=ses_...` (optional `&project=<slug>` enables local DB fallback)
- Session and Workspace: `ses_...` plus the Workspace root the TUI was launched against

Run the repository's read-only `scripts/extract-session.mjs` extractor (do **not** invent a temporary inspect script).

**Argument order matters.** Qi options must come *after* the script path. Node treats flags before the
script as its own options (`node: bad option: --workspace…`). npm also steals `--workspace` for package
workspaces — prefer `--workspace-root`, or pass `node …` / `npm exec -- …` directly.

```text
# correct
node <qi-repository>/scripts/extract-session.mjs --url <url>
node <qi-repository>/scripts/extract-session.mjs --session <session-id> --workspace-root <workspace-root>
node <qi-repository>/scripts/extract-session.mjs --session <session-id> --project <project-id>
node <qi-repository>/scripts/extract-session.mjs --session <session-id> --db <sqlite-path>

# bounded projection queries
node scripts/extract-session.mjs --session <session-id> --workspace-root <workspace-root> --list-runs
node scripts/extract-session.mjs --session <session-id> --workspace-root <workspace-root> --run last --problems
node scripts/extract-session.mjs --session <session-id> --workspace-root <workspace-root> --run <run-id> --last-step
node scripts/extract-session.mjs --session <session-id> --workspace-root <workspace-root> --step <step-id> --detail
node scripts/extract-session.mjs --session <session-id> --workspace-root <workspace-root> --action <action-id> --detail
node scripts/extract-session.mjs --session <session-id> --workspace-root <workspace-root> --all

# wrong — Node/npm may consume the flag
node --workspace-root <workspace-root> scripts/extract-session.mjs --session <session-id>
npm exec extract-session --workspace <workspace-root>
```

`--workspace` remains a deprecated alias of `--workspace-root` (same placement rules). You can also set
`QI_WORKSPACE` instead of passing a path flag.

With `--workspace-root`, the extractor resolves `qi.sqlite` in this order (first existing path wins):

1. `$QI_HOME/projects/<project-name>-<path-hash>/sessions/<session-id>/state/qi.sqlite` — active Session
2. `$QI_HOME/projects/<project-name>-<path-hash>/archives/<session-id>/state/qi.sqlite` — hard-archived Session
3. An explicit `--db` path supplied by the human.

`--project <project-id>` resolves the requested Session under that project's `sessions/` then `archives/`.
Use `--db` only when you already know the exact database path.

The URL path first requests the Web `/workbench` projection; if that fails and the URL includes
`?project=<slug>`, it falls back to the matching QI_HOME Session database under `sessions/` or `archives/`.
Extracted JSON is bounded and
passed through Qi's high-confidence secret redaction before output. Do not copy, edit, migrate, or
compact the source database.

The default output is the Session summary plus a bounded newest-first Run list. The extractor directly reuses
`@civaapple/qi-introspection` for the same projection used by the model-facing `qi_session_inspect` Tool.
Always list Runs first, then request `--problems`, `--last-step`, or one explicit Step/Action. Use `--detail`
only after narrowing the entity. The legacy bounded full report is available only with explicit `--all`.
Unknown IDs, mutually exclusive selectors, and Run/entity ownership mismatches fail with a diagnostic; they
never fall back to full output.

**Diagnostic fields to expect** (inspect queries and `--all`):

- Run `displayTitle` / `planBinding` / `formalPlan` — Accepted Formal Plans use a short title; do not treat raw
  `<accepted-plan>…</accepted-plan>` input as the user task label.
- Run `actionFacts` (inspect) — legacy totals `writeCompleted` / `writeFailed` / `readCompleted`, plus
  `workspaceWriteCompleted` / `workspaceWriteFailed`, `artifactWriteCompleted` / `artifactWriteFailed`, and
  `otherWriteCompleted` / `otherWriteFailed`. Use the scoped counts when judging Workspace mutation: Artifact
  persistence and Work Plan updates are private/runtime state, not project-file evidence. These detailed counts
  are available through explicit inspection; automatic Runtime-owned restored-history context exposes only a
  coarse write settlement class and no durable IDs or counts.
- Session / Run `workPlan` — Plan or Agent `update_plan` snapshot (`currentWorkPlanId`); Action detail may
  include `workPlanItems`. Ask mode never authors Work Plans.
- Step `modelReasoning` — Thinking text; intent only, never proof of execution.
- Action `gitWorkspaceChange` / `diffKind` / `process` — distinguish file-tool diffs from Git fingerprint changes
  and process exit summaries.

If execution or local-network authority is unavailable, state the missing capability and ask for the extractor
JSON or exported event history. Do not infer a trace from a screenshot alone.

## Analyze in order

1. Reconstruct each Run's user intent from `displayTitle` / `formalPlan` when present (not the full accepted-plan
   envelope), terminal state, terminal reason, and whether completion was `response` or evidence-backed `verified`.
2. Follow Steps in sequence. Explain model response/action boundaries, context pressure, compaction, omitted blocks,
   repeated strategies, and whether the Run made progress. Treat `modelReasoning` as intent, not settlement.
3. Join every Action by `actionId`: proposal, authority request/decision, executor start, settlement, tool input,
   result, error, diff kind, and recovery. Never interpret `step.completed · action-requested` as settled tool work.
4. Compare Work Plan Todo status with completed Workspace write/verify Actions and with scoped `actionFacts`.
   Verbal “已修复” without completed Workspace mutation Actions is the `CLAIMED_MUTATION_WITHOUT_ACTIONS`
   pattern. Never count `artifact` or `update_plan` as a Workspace mutation.
   A committed legacy `<qi-run-facts>` tag is model output to diagnose, not trusted Run evidence.
5. Separate four categories:
   - target-Workspace defects;
   - Qi runtime/tool/projection defects;
   - model strategy or tool-selection mistakes;
   - expected control behavior such as denial or honest parking.
6. Inspect relevant Workspace source only after the trace identifies an owning component or target file. Use Git
   status/diff and tests as corroborating evidence; do not silently modify either Qi or the target project.
7. Read [references/analysis-checklist.md](references/analysis-checklist.md) when classifying findings and writing
   recommendations.

## Evidence rules

- Cite Run, Step, Action, event sequence, tool, and error code wherever available.
- Label every conclusion as **fact**, **inference**, or **proposal**.
- Treat `responded` as a conversational outcome, not verified completion.
- Treat Action success as a tool result, not automatically an Evidence Ledger record.
- Preserve `failed`, `cancelled`, `parked`, `denied`, and `indeterminate` as distinct meanings.
- Report a recovered failure even when the Run later completed; do not report the whole Run as failed.
- Prefer the earliest causal failure over downstream symptoms and repeated retries.
- State confidence and what evidence would falsify a root-cause inference.

## Deliver the review

Respond in the user's language. Lead with the overall judgment, then provide:

1. **Session summary** — tasks, terminal outcomes, Step/Action counts, mutations, verification, and formal evidence.
2. **Execution narrative** — concise Run-by-Run progression, emphasizing state transitions and recovery.
3. **Findings** — ordered by severity; include evidence, cause, impact, and confidence.
4. **Solutions** — distinguish immediate fix, systemic Qi fix, and regression evidence. Name likely owning packages
   and files only after inspecting them.
5. **Open questions** — only uncertainties that materially change the solution.

Do not implement proposed fixes unless the user explicitly asks for implementation.
