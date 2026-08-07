import { resolve } from "node:path";
import {
  probeSrtAvailable,
  resolveSandboxBackend,
  type SandboxPolicy,
} from "@civaapple/qi-node/sandbox";
import { loadProjectConfig, projectConfigPathForWorkspace } from "./project-config.js";
import { defaultUserConfigPath, loadUserConfig } from "./config.js";

/**
 * Non-interactive sandbox inspection.
 * Usage: qi sandbox status [--workspace PATH] [--json]
 */
export async function runSandboxCliCommand(
  argv: readonly string[],
  options: {
    readonly cwd?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly write?: (text: string) => void;
    readonly writeErr?: (text: string) => void;
  } = {},
): Promise<boolean> {
  if (argv[0] !== "sandbox") return false;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const writeErr = options.writeErr ?? ((text: string) => process.stderr.write(text));
  const cwd = resolve(options.cwd ?? process.cwd());
  const environment = options.environment ?? process.env;
  const { operation, workspace, json } = parseArgs(argv.slice(1), cwd);

  if (operation !== "status") {
    throw new TypeError(
      "Usage: qi sandbox status [--workspace PATH] [--json]\n" +
        "  Reports graded process-sandbox backend (srt → win-low-il → host) and srt probe.",
    );
  }

  try {
    const report = await buildSandboxReport({ workspaceRoot: workspace, environment });
    if (json) {
      write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      write(`${formatHuman(report)}\n`);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    else writeErr(`${message}\n`);
    process.exitCode = 1;
    return true;
  }
}

export interface SandboxReport {
  readonly ok: true;
  readonly workspaceRoot: string;
  readonly policy: SandboxPolicy;
  readonly backend: string;
  readonly strength: string;
  readonly status: string;
  readonly reason: string;
  readonly wraps: readonly string[];
  readonly srt: {
    readonly available: boolean;
    readonly kind?: string;
    readonly path?: string;
    readonly reason: string;
  };
  readonly hints: readonly string[];
}

export async function buildSandboxReport(options: {
  readonly workspaceRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<SandboxReport> {
  const environment = options.environment ?? process.env;
  const user = await loadUserConfig(defaultUserConfigPath(environment));
  const project = await loadProjectConfig(projectConfigPathForWorkspace(options.workspaceRoot, environment));
  const policy =
    project.config.sandbox?.policy
    ?? user.config.sandbox?.policy
    ?? "auto";
  const srt = await probeSrtAvailable(environment);
  const sandbox = await resolveSandboxBackend({
    policy,
    environment,
    workspaceRoot: options.workspaceRoot,
  });
  const hints: string[] = [];
  if (!srt.available) {
    hints.push(
      "Install Anthropic sandbox-runtime CLI for full OS isolation: npm i -g @anthropic-ai/sandbox-runtime",
    );
    if (process.platform === "win32") {
      hints.push(
        "On Windows without srt, Qi uses the reduced Low IL tier; run `srt windows-install` after installing srt for ACE+WFP isolation.",
      );
    } else if (process.platform === "linux") {
      hints.push("Linux srt requires bubblewrap (bwrap) on PATH.");
    }
  } else if (srt.kind === "module" && !srt.path) {
    hints.push("Module is resolvable but `srt` CLI is not on PATH; add the global bin directory to PATH.");
  }
  if (sandbox.info.backend.startsWith("srt-") === false && srt.available) {
    hints.push(
      "srt was detected but not selected as backend (smoke failed or policy).",
    );
  }
  if (
    sandbox.info.reason.includes("AppData")
    || sandbox.info.reason.includes("nvm")
    || sandbox.info.reason.includes("CreateProcessWithLogonW")
    || sandbox.info.reason.includes("拒绝访问")
  ) {
    hints.push(
      "Windows: srt-win.exe under your user profile (nvm/AppData) cannot be loaded by the srt-sandbox account. Qi copies it to %ProgramData%\\qi\\srt-win\\srt-win.exe — ensure that folder is readable by Users, then re-run status.",
    );
  }
  if (sandbox.info.reason.includes("smoke failed") || sandbox.info.reason.includes("WFP") || sandbox.info.reason.includes("Logon")) {
    hints.push(
      "Elevated `srt windows-install` should report WFP installed with filters>0; seclogon (Secondary Logon) must be Running.",
    );
  }
  if (sandbox.info.strength === "reduced") {
    hints.push("Reduced strength does not block reading user secrets; path guards still apply.");
  }
  if (sandbox.info.backend.startsWith("srt-")) {
    hints.push(
      "srt denies ~/.ssh by default in Qi workspace settings; listing ~/.ssh via shell should fail closed — that is intended.",
    );
  }

  return {
    ok: true,
    workspaceRoot: options.workspaceRoot,
    policy,
    backend: sandbox.info.backend,
    strength: sandbox.info.strength,
    status: sandbox.info.status,
    reason: sandbox.info.reason,
    wraps: sandbox.info.wraps,
    srt: {
      available: srt.available,
      ...(srt.kind === undefined ? {} : { kind: srt.kind }),
      ...(srt.path === undefined ? {} : { path: srt.path }),
      reason: srt.reason,
    },
    hints,
  };
}

function formatHuman(report: SandboxReport): string {
  const lines = [
    `workspace  ${report.workspaceRoot}`,
    `policy     ${report.policy}`,
    `backend    ${report.backend}`,
    `strength   ${report.strength}`,
    `status     ${report.status}`,
    `reason     ${report.reason}`,
    `wraps      ${report.wraps.join(", ")}`,
    `srt        ${report.srt.available ? "available" : "unavailable"}` +
      (report.srt.kind ? ` (${report.srt.kind})` : ""),
    ...(report.srt.path ? [`           path ${report.srt.path}`] : []),
    `           ${report.srt.reason}`,
  ];
  if (report.hints.length > 0) {
    lines.push("hints");
    for (const hint of report.hints) lines.push(`  · ${hint}`);
  }
  return lines.join("\n");
}

function parseArgs(argv: readonly string[], cwd: string): {
  operation: string;
  workspace: string;
  json: boolean;
} {
  let operation = "status";
  let workspace = cwd;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--workspace") {
      const value = argv[index + 1];
      if (!value) throw new TypeError("--workspace requires a path");
      workspace = resolve(cwd, value);
      index += 1;
      continue;
    }
    if (arg?.startsWith("-")) throw new TypeError(`Unknown argument: ${arg}`);
    if (arg) operation = arg;
  }
  return { operation, workspace, json };
}
