#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { RuntimeActivity } from "@civaapple/qi-loop";
import type { SessionEvent } from "@civaapple/qi-protocol";
import { AuthSession, parseLoginCommand } from "./auth.js";
import { AuthBackedModelPort } from "./auth-model-port.js";
import { defaultUserConfigPath, findCompatibleEndpoint, loadUserConfig, removeCompatibleEndpoint } from "./config.js";
import { persistLoginProviderDefaults } from "./login-persist.js";
import { parseTuiCliArguments, qiCliVersion, refreshLaunchCapabilities, type TuiCliOptions } from "./cli.js";
import { commandHelp, parseSkillInstallCommand, parseTaskStopCommand, parseTuiCommand, tuiCommands } from "./commands.js";
import { InteractiveTui } from "./interactive.js";
import { TuiPresenter, type TuiLaunchInfo } from "./presenter.js";
import { LineInputBatcher } from "./input-batcher.js";
import { discoveryAcceleratorTip, missingDiscoveryAccelerators } from "./discovery-tools.js";
import { renderEvent, renderStatus } from "./render.js";
import { t } from "./i18n.js";
import { formatProviderLabel } from "./provider.js";
import {
  contextBudgetFromWindow,
  TUI_HISTORY_BUDGET_TOKENS,
  TUI_MAX_ACTIONS_PER_STEP,
  TUI_MAX_STEPS,
  TuiRuntime,
} from "./runtime.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const parsed = await parseTuiCliArguments(process.argv.slice(2));
  if (parsed.kind === "help" || parsed.kind === "version") {
    process.stdout.write(parsed.text);
    return;
  }
  const options = parsed.options;
  const rich = process.stdin.isTTY === true && process.stdout.isTTY === true && process.env.TERM !== "dumb";
  let runtime: TuiRuntime | undefined;
  let presenter: TuiPresenter | undefined;
  let eventConsumer: (event: SessionEvent) => void = (event) => {
    if (rich) return;
    const line = renderEvent(event);
    if (line) process.stdout.write(`${line}\n`);
  };
  let activityConsumer: (activity: RuntimeActivity) => void = () => undefined;
  const auth = await AuthSession.create({ config: options.provider });

  if (rich) {
    let sessionId = options.sessionId;
    let pendingNotice: string | undefined;
    for (;;) {
      const authStatus = auth.status();
      // In-process New Session / resume is a launch: re-read project/user capability policy.
      const policy = await refreshLaunchCapabilities(options);
      options.allowWrite = policy.allowWrite;
      options.allowVerify = policy.allowVerify;
      options.allowNetwork = policy.allowNetwork;
      options.allowExecute = policy.allowExecute;
      options.allowBackground = policy.allowBackground;
      options.allowDelegate = policy.allowDelegate;
      options.projectConfigPath = policy.projectConfigPath;
      delete (options as { shell?: unknown }).shell;
      if (policy.shell !== undefined) options.shell = policy.shell;
      runtime = await TuiRuntime.create({
        workspaceRoot: options.workspaceRoot,
        dataRoot: options.dataRoot,
        modelPort: new AuthBackedModelPort(auth),
        model: { provider: auth.config.provider, model: auth.config.model },
        resolveModel: () => ({
          provider: auth.config.provider,
          model: auth.config.model,
        }),
        contextWindowTokens: options.contextWindowTokens,
        outputReserveTokens: options.outputReserveTokens,
        allowWrite: options.allowWrite,
        allowVerify: options.allowVerify,
        allowExecute: options.allowExecute,
        allowNetwork: options.allowNetwork,
        allowBackground: options.allowBackground,
        allowDelegate: options.allowDelegate,
        ...(options.shell === undefined ? {} : { shell: options.shell }),
        ...(sessionId === undefined ? {} : { sessionId }),
        projectConfigPath: policy.projectConfigPath,
        mounts: options.mounts,
        onEvent: (event) => eventConsumer(event),
        onActivity: (activity) => activityConsumer(activity),
      });
      const launchOptions: TuiCliOptions = {
        ...options,
        provider: {
          ...options.provider,
          provider: auth.config.provider,
          model: auth.config.model,
          wireApi: auth.config.wireApi,
          accountAlias: auth.config.accountAlias,
          ...(auth.config.baseURL === undefined ? {} : { baseURL: auth.config.baseURL }),
        },
      };
      presenter = new TuiPresenter(await launchInfo(launchOptions, runtime, authStatus.authStatus));
      presenter.update(runtime.events(), runtime.view());
      presenter.setSkills(runtime.skillCatalog());
      if (pendingNotice) {
        presenter.setNotice(pendingNotice);
        pendingNotice = undefined;
      }
      const interactive = new InteractiveTui(runtime, presenter, { auth });
      eventConsumer = (event) => interactive.onEvent(event);
      activityConsumer = (activity) => interactive.onActivity(activity);
      const exit = await interactive.run();
      await runtime.close();
      runtime = undefined;
      if (exit.kind === "resume") {
        sessionId = exit.sessionId;
        pendingNotice = t(options.language, "sessions.resumed");
        continue;
      }
      if (exit.kind === "new-session") {
        sessionId = undefined;
        pendingNotice = t(options.language, "sessions.resumed");
        continue;
      }
      return;
    }
  }

  const authStatus = auth.status();
  runtime = await TuiRuntime.create({
    workspaceRoot: options.workspaceRoot,
    dataRoot: options.dataRoot,
    modelPort: new AuthBackedModelPort(auth),
    model: { provider: options.provider.provider, model: options.provider.model },
    resolveModel: () => ({
      provider: auth.config.provider,
      model: auth.config.model,
    }),
    contextWindowTokens: options.contextWindowTokens,
    outputReserveTokens: options.outputReserveTokens,
    allowWrite: options.allowWrite,
    allowVerify: options.allowVerify,
    allowExecute: options.allowExecute,
    allowNetwork: options.allowNetwork,
    allowBackground: options.allowBackground,
    allowDelegate: options.allowDelegate,
    ...(options.shell === undefined ? {} : { shell: options.shell }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.projectConfigPath === undefined ? {} : { projectConfigPath: options.projectConfigPath }),
    mounts: options.mounts,
    onEvent: (event) => eventConsumer(event),
    onActivity: (activity) => activityConsumer(activity),
  });

  presenter = new TuiPresenter(await launchInfo(options, runtime, authStatus.authStatus));
  presenter.update(runtime.events(), runtime.view());
  presenter.setSkills(runtime.skillCatalog());

  process.stdout.write(
    [
      "Qi · evidence-first local agent",
      `workspace ${options.workspaceRoot}`,
      `model ${formatProviderLabel(options.provider.provider, options.provider.accountAlias)}/${options.provider.model}${options.provider.baseURL ? ` via ${options.provider.baseURL}` : ""} · ${options.provider.wireApi} · auth ${authStatus.authStatus}`,
      `control read${options.allowWrite ? " + write" : ""}${options.allowVerify ? " + verify" : ""}${options.allowNetwork ? " + network" : ""}${options.allowExecute ? " + host execute" : ""}${options.allowBackground ? " + background tasks" : ""}${options.allowDelegate ? " + delegate" : ""}`,
      `context ${contextBudgetFromWindow(options.contextWindowTokens, options.outputReserveTokens)} prompt + ${options.outputReserveTokens} output reserve / ${options.contextWindowTokens} window`,
      ...(options.configPath === undefined ? [] : [`config ${options.configPath}`]),
      ...(runtime.verificationManifest === undefined
        ? []
        : [`verify ${runtime.verificationManifest.origin} ${runtime.verificationManifest.path} · ${runtime.verificationManifest.profiles.join(", ")}`]),
      ...(presenter.discoveryTip() === undefined ? [] : [presenter.discoveryTip()!]),
      "commands /help · /settings · /login · /ask · /mode · /plan · /next · /tasks · /skills · /mounts · /permissions · /runs · /sessions · /steer <text> · /cancel · /quit",
      "",
    ].join("\n"),
  );

  const readline = createInterface({ input: process.stdin, output: process.stdout, prompt: "you › " });
  const active = new Set<Promise<void>>();
  let closing = false;
  readline.prompt();
  const handleInput = (raw: string): void => {
    const line = raw.trim();
    const isSingleLine = !line.includes("\n");
    if (!line) {
      if (!closing) readline.prompt();
      return;
    }
    const command = isSingleLine ? parseTuiCommand(line) : undefined;
    if (command?.name === "quit") {
      closing = true;
      runtime?.cancel("User quit");
      readline.close();
      return;
    }
    if (command?.name === "skills" || command?.name === "skill") {
      if (runtime?.active || active.size > 0) {
        process.stderr.write("A Run or TUI operation is active; wait before managing Skills.\n");
        if (!closing) readline.prompt();
        return;
      }
      let request;
      try {
        const installArgument = command.name === "skill"
          ? command.argument
          : /^install\b/i.test(command.argument.trim())
            ? command.argument
            : undefined;
        request = installArgument === undefined ? undefined : parseSkillInstallCommand(installArgument);
      } catch (error) {
        process.stderr.write(`${message(error)}\n`);
        if (!closing) readline.prompt();
        return;
      }
      const task = (request
        ? runtime.installSkill(request.source, request.scope).then((installed) => `Installed ${installed.name} ${installed.version} in ${installed.scope} scope.`)
        : runtime.refreshSkills().then((skills) => `Discovered ${skills.length} active Skill${skills.length === 1 ? "" : "s"}.`))
        .then((notice) => {
          presenter?.setSkills(runtime.skillCatalog());
          presenter?.setPanel("skills", notice);
          process.stdout.write(`${presenter?.render().join("\n") ?? ""}\n`);
        })
        .catch((error: unknown) => {
          process.stderr.write(`skill error: ${message(error)}\n`);
        })
        .finally(() => {
          active.delete(task);
          if (!closing) readline.prompt();
        });
      active.add(task);
      return;
    }
    if (command?.name === "login") {
      if (runtime?.active || active.size > 0) {
        process.stderr.write("A Run or TUI operation is active; wait before /login.\n");
        if (!closing) readline.prompt();
        return;
      }
      const task = handleLoginCommand(auth, command.argument, (line) => process.stdout.write(`${line}\n`))
        .then((notice) => {
          process.stdout.write(`${notice}\n`);
        })
        .catch((error: unknown) => {
          process.stderr.write(`login error: ${message(error)}\n`);
        })
        .finally(() => {
          active.delete(task);
          if (!closing) readline.prompt();
        });
      active.add(task);
      return;
    }
    if (command?.name === "tasks" || command?.name === "task") {
      let token: string;
      try {
        const stopArgument = command.name === "task" && !/^stop\b/i.test(command.argument.trim())
          ? `stop ${command.argument}`
          : command.argument;
        token = parseTaskStopCommand(stopArgument);
      } catch (error) {
        process.stderr.write(`${message(error)}\n`);
        if (!closing) readline.prompt();
        return;
      }
      const tasks = runtime.tasks();
      const taskId = (/^\d+$/.test(token) ? tasks[Number(token) - 1]?.taskId : undefined) ?? token;
      const task = runtime.stopTask(taskId)
        .then(() => {
          presenter?.update(runtime.events(), runtime.view());
          presenter?.setPanel("tasks", `Stop requested for ${taskId}.`);
          process.stdout.write(`${presenter?.render().join("\n") ?? ""}\n`);
        })
        .catch((error: unknown) => { process.stderr.write(`ProcessTask error: ${message(error)}\n`); })
        .finally(() => {
          active.delete(task);
          if (!closing) readline.prompt();
        });
      active.add(task);
      return;
    }
    if (command?.name === "mode") {
      const requested = command.argument.trim().toLowerCase();
      try {
        if (!requested) {
          process.stdout.write(`mode ${runtime.mode()} · /mode ask|plan|agent\n`);
        } else if (requested !== "ask" && requested !== "plan" && requested !== "agent") {
          throw new TypeError("Usage: /mode ask|plan|agent");
        } else {
          runtime.changeMode(requested, `User set /mode ${requested}`);
          presenter?.update(runtime.events(), runtime.view());
          process.stdout.write(`mode ${runtime.mode()}\n`);
        }
      } catch (error) {
        process.stderr.write(`${message(error)}\n`);
      }
      if (!closing) readline.prompt();
      return;
    }
    if (command?.name === "ask") {
      if (runtime.active || active.size > 0) {
        process.stderr.write("A Run or TUI operation is active; wait before /ask.\n");
        if (!closing) readline.prompt();
        return;
      }
      const prompt = command.argument.trim().replace(/^\+\s*/, "");
      try {
        const view = runtime.view();
        if (view?.pendingReview?.status === "pending" || view?.pendingQuestion?.status === "pending") {
          throw new TypeError("Settle the pending Plan review or next-Run Question before changing mode.");
        }
        if (prompt) {
          if (runtime.mode() !== "ask") {
            runtime.changeMode("ask", "User set /ask <prompt>");
            presenter?.update(runtime.events(), runtime.view());
          }
          process.stdout.write(`mode ask\n`);
          const task = runtime.run(prompt)
            .then((result) => {
              presenter?.update(runtime.events(), result.view);
              process.stdout.write(`${renderStatus(result.view)}\n`);
            })
            .catch((error: unknown) => { process.stderr.write(`run error: ${message(error)}\n`); })
            .finally(() => {
              active.delete(task);
              if (!closing) readline.prompt();
            });
          active.add(task);
          return;
        }
        const next = runtime.mode() === "ask" ? "agent" : "ask";
        runtime.changeMode(next, next === "ask" ? "User set /ask" : "User toggled /ask off");
        presenter?.update(runtime.events(), runtime.view());
        process.stdout.write(`mode ${runtime.mode()}\n`);
      } catch (error) {
        process.stderr.write(`${message(error)}\n`);
      }
      if (!closing) readline.prompt();
      return;
    }
    if (command?.name === "plan") {
      if (runtime.active || active.size > 0) {
        process.stderr.write("A Run or TUI operation is active; wait before /plan.\n");
        if (!closing) readline.prompt();
        return;
      }
      const trimmed = command.argument.trim().replace(/^\+\s*/, "");
      if (!trimmed) {
        presenter?.update(runtime.events(), runtime.view());
        presenter?.setPanel("plan");
        process.stdout.write(`${presenter?.render().join("\n") ?? ""}\n`);
        if (!closing) readline.prompt();
        return;
      }
      const separator = trimmed.search(/\s/);
      const verb = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
      const feedback = separator < 0 ? undefined : trimmed.slice(separator).trim() || undefined;
      try {
        if (verb === "accept" || verb === "start") {
          const accepted = runtime.acceptPlan();
          presenter?.update(runtime.events(), runtime.view());
          process.stdout.write("Plan accepted · starting the first item Run.\n");
          const task = runtime.runTriggered(accepted.runId, accepted.input)
            .then((result) => {
              presenter?.update(runtime.events(), result.view);
              process.stdout.write(`${renderStatus(result.view)}\n`);
            })
            .catch((error: unknown) => { process.stderr.write(`run error: ${message(error)}\n`); })
            .finally(() => {
              active.delete(task);
              if (!closing) readline.prompt();
            });
          active.add(task);
          return;
        }
        if (verb === "revise") {
          runtime.revisePlan(feedback);
          presenter?.update(runtime.events(), runtime.view());
          process.stdout.write("Plan review marked for revise.\n");
          const prompt = feedback?.trim()
            || "请根据审阅反馈更新 plan_document：保持稳定的 planItemId，写完后再次请求 Plan 审阅。";
          const task = runtime.run(prompt)
            .then((result) => {
              presenter?.update(runtime.events(), result.view);
              process.stdout.write(`${renderStatus(result.view)}\n`);
            })
            .catch((error: unknown) => { process.stderr.write(`run error: ${message(error)}\n`); })
            .finally(() => {
              active.delete(task);
              if (!closing) readline.prompt();
            });
          active.add(task);
          return;
        }
        if (verb === "reject") {
          runtime.rejectPlan(feedback);
          presenter?.update(runtime.events(), runtime.view());
          process.stdout.write("Plan review rejected.\n");
          process.stdout.write(`${presenter?.render().join("\n") ?? ""}\n`);
          if (!closing) readline.prompt();
          return;
        }
        if (runtime.view()?.pendingReview?.status === "pending") {
          process.stderr.write("A Plan review is pending · use /plan accept|revise|reject.\n");
          if (!closing) readline.prompt();
          return;
        }
        if (runtime.mode() !== "plan") {
          runtime.changeMode("plan", "User set /plan <prompt>");
          presenter?.update(runtime.events(), runtime.view());
        }
        process.stdout.write("Planning…\n");
        const task = runtime.run(trimmed)
          .then((result) => {
            presenter?.update(runtime.events(), result.view);
            process.stdout.write(`${renderStatus(result.view)}\n`);
          })
          .catch((error: unknown) => { process.stderr.write(`run error: ${message(error)}\n`); })
          .finally(() => {
            active.delete(task);
            if (!closing) readline.prompt();
          });
        active.add(task);
        return;
      } catch (error) {
        process.stderr.write(`${message(error)}\n`);
      }
      if (!closing) readline.prompt();
      return;
    }
    if (command?.name === "next") {
      if (runtime.active || active.size > 0) {
        process.stderr.write("A Run or TUI operation is active; wait before answering.\n");
        if (!closing) readline.prompt();
        return;
      }
      const choice = command.argument.trim().toLowerCase();
      const mapped =
        choice === "continue" || choice === ""
          ? "continue"
          : choice === "stop"
            ? "stop"
            : choice === "plan" || choice === "return_to_plan"
              ? "return_to_plan"
              : undefined;
      if (!mapped) {
        process.stderr.write("Usage: /next continue|stop|plan\n");
        if (!closing) readline.prompt();
        return;
      }
      try {
        const pending = runtime.view()?.pendingQuestion;
        if (!(pending?.status === "pending" && pending.kind === "next_run")) {
          if (mapped !== "continue") {
            process.stderr.write("No pending Next Run. Use /next continue after stop, or wait for the next gate.\n");
            if (!closing) readline.prompt();
            return;
          }
          if (!runtime.reaskNextRun()) {
            process.stderr.write("No incomplete Plan item to continue.\n");
            if (!closing) readline.prompt();
            return;
          }
          presenter?.update(runtime.events(), runtime.view());
        }
        const answered = runtime.answerNextRun(mapped);
        presenter?.update(runtime.events(), runtime.view());
        if (answered.runId && answered.input) {
          process.stdout.write("Starting the next Plan item Run.\n");
          const task = runtime.runTriggered(answered.runId, answered.input)
            .then((result) => {
              presenter?.update(runtime.events(), result.view);
              process.stdout.write(`${renderStatus(result.view)}\n`);
            })
            .catch((error: unknown) => { process.stderr.write(`run error: ${message(error)}\n`); })
            .finally(() => {
              active.delete(task);
              if (!closing) readline.prompt();
            });
          active.add(task);
          return;
        }
        process.stdout.write(
          mapped === "return_to_plan"
            ? "Returned to Plan mode. Revise → review → 开始实现.\n"
            : "Stopped. Use /next continue later to resume incomplete items.\n",
        );
      } catch (error) {
        process.stderr.write(`${message(error)}\n`);
      }
      if (!closing) readline.prompt();
      return;
    }
    const panel = command ? tuiCommands.find((candidate) => candidate.name === command.name)?.panel : undefined;
    if (panel && command) {
      presenter?.update(runtime?.events() ?? [], runtime?.view());
      presenter?.setPanel(
        panel,
        command.name === "help" && command.argument
          ? commandHelp(command.argument, options.language).join(" · ")
          : undefined,
      );
      process.stdout.write(`${presenter?.render().join("\n") ?? "session empty"}\n`);
      if (!closing) readline.prompt();
      return;
    }
    if (command?.name === "cancel") {
      runtime?.cancel("User cancelled the Run");
      if (!closing) readline.prompt();
      return;
    }
    if (command?.name === "steer") {
      try {
        if (!command.argument) throw new TypeError("Usage: /steer <text>");
        runtime?.steer(command.argument);
      } catch (error) {
        process.stderr.write(`${message(error)}\n`);
      }
      if (!closing) readline.prompt();
      return;
    }
    if (command) {
      process.stderr.write(`${t(options.language, "help.unknown", { name: command.name })}\n`);
      if (!closing) readline.prompt();
      return;
    }
    if (runtime?.active) {
      process.stderr.write("A Run is active; use /steer, /cancel or wait for its boundary.\n");
      if (!closing) readline.prompt();
      return;
    }
    const task = runtime
      .run(line)
      .then((result) => {
        presenter?.update(runtime?.events() ?? [], result.view);
        process.stdout.write(`${renderStatus(result.view)}\n`);
      })
      .catch((error: unknown) => {
        process.stderr.write(`run error: ${message(error)}\n`);
      })
      .finally(() => {
        active.delete(task);
        if (!closing) readline.prompt();
      });
    active.add(task);
  };
  const inputBatcher = new LineInputBatcher({ onInput: handleInput });
  readline.on("line", (raw) => inputBatcher.push(raw));
  await new Promise<void>((resolveClosed) => readline.once("close", resolveClosed));
  closing = true;
  inputBatcher.flush();
  await Promise.allSettled(active);
  await runtime.close();
}

async function handleLoginCommand(
  auth: AuthSession,
  argument: string,
  write: (line: string) => void,
): Promise<string> {
  const request = parseLoginCommand(argument);
  if (request.mode === "status") {
    const status = auth.status();
    return `auth ${status.authStatus} · ${formatProviderLabel(status.provider, status.accountAlias)}/${status.model} · ${status.wireApi}` +
      (status.baseURL ? ` · ${status.baseURL}` : "");
  }
  if (request.mode === "list") {
    const accounts = await auth.listAccounts();
    if (accounts.length === 0) return "No sealed provider accounts in QI_HOME.";
    return accounts.map((account) => `${account.accountId} · ${account.authKind}`).join("\n");
  }
  if (request.mode === "logout") {
    const provider = request.provider || auth.config.provider;
    const alias = request.alias ?? auth.config.accountAlias;
    const removed = await auth.logout(provider, alias);
    if (removed && provider === "compatible") {
      await removeCompatibleEndpoint(alias, defaultUserConfigPath());
    }
    return removed ? "Logged out and revoked the sealed credential." : "No sealed credential matched.";
  }
  if (request.mode === "use") {
    const configPath = defaultUserConfigPath();
    const loaded = await loadUserConfig(configPath);
    const provider = request.provider || "compatible";
    const alias = request.alias ?? "default";
    const routing = provider === "compatible"
      ? (() => {
        const entry = findCompatibleEndpoint(loaded.config, alias);
        return entry ? { model: entry.model, baseURL: entry.baseURL } : undefined;
      })()
      : undefined;
    const status = await auth.useAccount(provider, alias, routing);
    const savedPath = await persistLoginProviderDefaults(status, configPath);
    return `Switched to ${formatProviderLabel(status.provider, status.accountAlias)}/${status.model}` +
      (status.baseURL ? ` · ${status.baseURL}` : "") +
      `. Active routing saved to ${savedPath}.`;
  }
  if (request.mode === "api-key") {
    const status = await auth.loginApiKey(request.provider, request.apiKey!, {
      ...(request.alias === undefined ? {} : { alias: request.alias }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.baseURL === undefined ? {} : { baseURL: request.baseURL }),
    });
    const configPath = await persistLoginProviderDefaults(status, defaultUserConfigPath());
    return `Authenticated ${formatProviderLabel(status.provider, status.accountAlias)}/${status.model} (${status.authStatus}) via API key` +
      (status.baseURL ? ` · ${status.baseURL}` : "") +
      `. Saved provider/model/base_url to ${configPath}. Secrets stay in the sealed store.`;
  }
  if (request.provider !== "kimi") {
    throw new TypeError(`Device login is currently implemented for kimi; use /login ${request.provider} key <api-key>`);
  }
  const status = await auth.loginKimiDevice({
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.alias === undefined ? {} : { alias: request.alias }),
    onAuthorization: (info) => {
      write(`Open ${info.verificationUriComplete || info.verificationUri}`);
      write(`User code: ${info.userCode}`);
      write("Waiting for authorization…");
    },
  });
  const configPath = await persistLoginProviderDefaults(status, defaultUserConfigPath());
  return `Authenticated ${formatProviderLabel(status.provider, status.accountAlias)}/${status.model} via device login (${status.authStatus}). ` +
    `Saved provider/model to ${configPath}.`;
}

async function launchInfo(
  options: TuiCliOptions,
  runtime: TuiRuntime,
  authStatus: "ready" | "missing" | "expired",
): Promise<TuiLaunchInfo> {
  const branch = await gitBranch(options.workspaceRoot);
  const missing = await missingDiscoveryAccelerators(options.workspaceRoot);
  const discoveryTip = discoveryAcceleratorTip(options.language, missing);
  return {
    workspaceRoot: options.workspaceRoot,
    dataRoot: options.dataRoot,
    provider: options.provider.provider,
    model: options.provider.model,
    ...(options.provider.accountAlias === undefined ? {} : { accountAlias: options.provider.accountAlias }),
    ...(options.provider.baseURL === undefined ? {} : { baseURL: options.provider.baseURL }),
    wireApi: options.provider.wireApi,
    authStatus,
    capabilities: [
      ...(options.allowWrite ? ["write"] : []),
      ...(options.allowVerify ? ["verify"] : []),
      ...(options.allowNetwork ? ["network"] : []),
      ...(options.allowExecute ? ["host execute"] : []),
      ...(options.allowBackground ? ["background tasks"] : []),
      ...(options.allowDelegate ? ["delegate"] : []),
    ],
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    projectConfigPath: runtime.projectConfigPath(),
    mounts: runtime.mounts().map((mount) => ({ id: mount.id, path: mount.path, mode: mount.mode as "read" })),
    ...(runtime.verificationManifest === undefined ? {} : { verification: runtime.verificationManifest }),
    shell: runtime.shellProfiles,
    language: options.language,
    theme: options.theme,
    contextWindowTokens: options.contextWindowTokens,
    contextBudgetTokens: contextBudgetFromWindow(options.contextWindowTokens, options.outputReserveTokens),
    outputReserveTokens: options.outputReserveTokens,
    historyBudgetTokens: TUI_HISTORY_BUDGET_TOKENS,
    maxSteps: TUI_MAX_STEPS,
    maxActionsPerStep: TUI_MAX_ACTIONS_PER_STEP,
    skillRoots: runtime.skillRoots,
    ...(branch === undefined ? {} : { branch }),
    version: qiCliVersion().slice("qi ".length),
    ...(discoveryTip === undefined ? {} : { discoveryTip }),
  };
}

async function gitBranch(workspaceRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspaceRoot,
      timeout: 2_000,
      windowsHide: true,
    });
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`qi: ${message(error)}\n`);
  process.exitCode = 1;
});
