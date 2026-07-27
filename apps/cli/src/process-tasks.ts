import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { redactSensitiveText } from "@civaapple/qi-capability";
import { EventWriter, type RuntimeActivity } from "@civaapple/qi-loop";
import { createId, type SessionId, type TaskId } from "@civaapple/qi-protocol";
import type { EventStore, ProcessTaskView } from "@civaapple/qi-kernel";
import {
  defineTool,
  resolveShellExecutable,
  resolveWorkspacePath,
  windowsCommandInvocation,
  type ToolDefinition,
} from "@civaapple/qi-tools";
import { scrubCredentialEnvironment, terminateProcessTree } from "@civaapple/qi-workspace";
import { Type, type TSchema } from "@sinclair/typebox";

const defaultLifetimeMs = 2 * 60 * 60 * 1_000;
const maximumLifetimeMs = 8 * 60 * 60 * 1_000;
const maximumLogBytes = 1024 * 1024;
const liveTailBytes = 16 * 1024;

interface OwnedTask {
  readonly taskId: TaskId;
  readonly child: ChildProcess;
  readonly writer: EventWriter;
  readonly logPath: string;
  readonly expiresAt: string;
  rawOutput: string;
  logWrite: Promise<void>;
  stopped: boolean;
  expired: boolean;
  terminal: boolean;
  expiryTimer: ReturnType<typeof setTimeout>;
}

export interface ProcessTaskManagerOptions {
  readonly workspaceRoot: string;
  readonly dataRoot: string;
  readonly eventStore: EventStore;
  readonly onEvent?: ConstructorParameters<typeof EventWriter>[3];
  readonly onActivity?: (activity: RuntimeActivity) => void;
}

export class ProcessTaskManager {
  readonly #workspaceRoot: string;
  readonly #tasksRoot: string;
  readonly #eventStore: EventStore;
  readonly #onEvent: ConstructorParameters<typeof EventWriter>[3];
  readonly #onActivity: ((activity: RuntimeActivity) => void) | undefined;
  readonly #owned = new Map<TaskId, OwnedTask>();

  constructor(options: ProcessTaskManagerOptions) {
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#tasksRoot = resolve(options.dataRoot, "tasks");
    this.#eventStore = options.eventStore;
    this.#onEvent = options.onEvent;
    this.#onActivity = options.onActivity;
  }

  tool(): ToolDefinition<TSchema, TSchema> {
    return defineTool({
      description: "Start a bounded long-lived process as a visible Qi ProcessTask. Use this only for servers, watchers, and other commands expected to remain alive; use shell for finite commands. Tasks expire automatically and the user can inspect or stop them with /tasks and /task stop.",
      input: Type.Object({
        command: Type.String({ minLength: 1 }),
        args: Type.Array(Type.String(), { maxItems: 200 }),
        workdir: Type.Optional(Type.String({ minLength: 1 })),
        lifetimeMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: maximumLifetimeMs })),
      }, { additionalProperties: false }),
      output: Type.Object({
        taskId: Type.String({ pattern: "^tsk_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$" }),
        pid: Type.Integer({ minimum: 1 }),
        status: Type.Literal("running"),
        expiresAt: Type.String(),
        logRef: Type.String(),
      }, { additionalProperties: false }),
      effect: () => "execute",
      resources: (input) => {
        const request = input as { command: string; workdir?: string };
        return [`process-task:${request.command}`, `host-workspace:${request.workdir ?? "."}`];
      },
      execute: async (input, context) => {
        const request = input as { command: string; args: string[]; workdir?: string; lifetimeMs?: number };
        return this.start(request, context);
      },
    });
  }

  list(sessionId: SessionId): ProcessTaskView[] {
    const view = this.#eventStore.load(sessionId);
    return (view?.taskOrder ?? []).map((taskId) => view?.tasks[taskId]).filter((task): task is ProcessTaskView => task !== undefined);
  }

  async recover(sessionId: SessionId): Promise<void> {
    const stale = this.list(sessionId).filter((task) => task.status === "running" || task.status === "stopping");
    if (stale.length === 0) return;
    const writer = new EventWriter(this.#eventStore, sessionId, undefined, this.#onEvent);
    for (const task of stale) {
      writer.append("task.lost", { taskId: task.taskId, reason: "Runtime restarted; process ownership cannot be proven" }, { kind: "runtime", id: "process-task-recovery" });
    }
  }

  async stop(
    sessionId: SessionId,
    taskId: string,
    reason = "Stopped by user",
    actor: "user" | "runtime" = "user",
  ): Promise<void> {
    const task = this.list(sessionId).find((candidate) => candidate.taskId === taskId || candidate.taskId.startsWith(taskId));
    if (!task) throw new Error(`ProcessTask not found: ${taskId}`);
    if (task.status !== "running" && task.status !== "stopping") throw new Error(`ProcessTask ${task.taskId} is ${task.status}`);
    const owned = this.#owned.get(task.taskId);
    if (!owned) {
      const writer = new EventWriter(this.#eventStore, sessionId, undefined, this.#onEvent);
      writer.append("task.lost", { taskId: task.taskId, reason: "Process is not owned by this runtime" }, { kind: "runtime", id: "process-task-manager" });
      return;
    }
    if (!owned.stopped) {
      owned.stopped = true;
      owned.writer.append(
        "task.stop.requested",
        { taskId: owned.taskId, reason },
        actor === "user" ? { kind: "user", id: "tui-user" } : { kind: "runtime", id: "process-task-manager" },
      );
    }
    await terminateProcessTree(owned.child);
    const exited = await waitForChildExit(owned.child);
    if (!exited && !owned.terminal) {
      owned.terminal = true;
      clearTimeout(owned.expiryTimer);
      owned.writer.append("task.lost", { taskId: owned.taskId, reason: "Process did not confirm exit after termination" }, { kind: "runtime", id: "process-task-manager" });
      this.#owned.delete(owned.taskId);
    }
  }

  async close(sessionId: SessionId): Promise<void> {
    const running = this.list(sessionId).filter((task) => task.status === "running" || task.status === "stopping");
    await Promise.allSettled(running.map((task) => this.stop(sessionId, task.taskId, "TUI closed", "runtime")));
  }

  private async start(
    request: { command: string; args: string[]; workdir?: string; lifetimeMs?: number },
    context: { sessionId: string; runId: string; stepId: string; actionId: string },
  ): Promise<{ taskId: string; pid: number; status: "running"; expiresAt: string; logRef: string }> {
    const cwd = await resolveWorkspacePath(this.#workspaceRoot, request.workdir ?? ".");
    const executable = await resolveShellExecutable(request.command, this.#workspaceRoot);
    const invocation = await windowsCommandInvocation(executable, request.args, this.#workspaceRoot, "UNSAFE_SHELL_ARGUMENT");
    await mkdir(this.#tasksRoot, { recursive: true });
    const taskId = createId("tsk") as TaskId;
    const logPath = resolve(this.#tasksRoot, `${taskId}.log`);
    await writeFile(logPath, "", "utf8");
    const lifetimeMs = request.lifetimeMs ?? defaultLifetimeMs;
    const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
    const child = spawn(invocation.command, [...invocation.args], {
      cwd,
      env: scrubCredentialEnvironment(process.env, { QI_PROCESS_TASK: "1", NO_COLOR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      detached: process.platform !== "win32",
    });
    await waitForSpawn(child);
    if (!child.pid) throw new Error(`Could not start ${request.command}`);
    const writer = new EventWriter(this.#eventStore, context.sessionId as SessionId, undefined, this.#onEvent);
    writer.append("task.started", {
      runId: context.runId,
      stepId: context.stepId,
      actionId: context.actionId,
      taskId,
      command: request.command,
      args: request.args,
      workdir: request.workdir ?? ".",
      pid: child.pid,
      expiresAt,
      logRef: `task-log:${taskId}`,
    }, { kind: "runtime", id: "process-task-manager" });
    const owned: OwnedTask = {
      taskId,
      child,
      writer,
      logPath,
      expiresAt,
      rawOutput: "",
      logWrite: Promise.resolve(),
      stopped: false,
      expired: false,
      terminal: false,
      expiryTimer: setTimeout(() => undefined, lifetimeMs),
    };
    clearTimeout(owned.expiryTimer);
    owned.expiryTimer = setTimeout(() => {
      owned.expired = true;
      void terminateProcessTree(child);
    }, lifetimeMs);
    this.#owned.set(taskId, owned);
    child.stdout?.on("data", (chunk: Buffer) => this.#recordOutput(context.sessionId, owned, "stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => this.#recordOutput(context.sessionId, owned, "stderr", chunk.toString("utf8")));
    child.once("exit", (code) => this.#settle(owned, code));
    return { taskId, pid: child.pid, status: "running", expiresAt, logRef: `task-log:${taskId}` };
  }

  #recordOutput(sessionId: string, task: OwnedTask, stream: "stdout" | "stderr", chunk: string): void {
    task.rawOutput = `${task.rawOutput}${chunk}`.slice(-maximumLogBytes);
    const sanitized = redactSensitiveText(task.rawOutput).value;
    task.logWrite = task.logWrite
      .then(() => writeFile(task.logPath, sanitized, "utf8"))
      .catch(() => undefined);
    this.#onActivity?.({
      type: "task.output",
      sessionId,
      taskId: task.taskId,
      stream,
      text: sanitized.slice(-liveTailBytes),
      truncated: task.rawOutput.length >= maximumLogBytes,
      provisional: true,
    });
  }

  #settle(task: OwnedTask, exitCode: number | null): void {
    if (task.terminal) return;
    task.terminal = true;
    clearTimeout(task.expiryTimer);
    const reason = task.expired ? "expired" : task.stopped ? "stopped" : "exited";
    task.writer.append("task.exited", { taskId: task.taskId, exitCode, reason }, { kind: "runtime", id: "process-task-manager" });
    this.#owned.delete(task.taskId);
  }
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs = 3_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}
