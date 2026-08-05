import type { SlashCommand } from "@earendil-works/pi-tui";
import { defaultLocale, t, type Locale, type MessageKey } from "./i18n.js";

export type TuiPanel =
  | "overview"
  | "config"
  | "context"
  | "runs"
  | "steps"
  | "actions"
  | "agents"
  | "skills"
  | "jobs"
  | "tasks"
  | "diff"
  | "plan"
  | "providers"
  | "coord"
  | "work"
  | "gate"
  | "extensions"
  | "help";

export type CommandVisibility = "primary" | "alias" | "advanced";

export interface ParsedTuiCommand {
  readonly name: string;
  readonly argument: string;
  readonly draft?: string;
}

export interface TuiCommandDefinition {
  readonly name: string;
  readonly descriptionKey: MessageKey;
  readonly argumentHint?: string;
  readonly category: "inspect" | "navigate" | "manage" | "control";
  readonly visibility: CommandVisibility;
  readonly panel?: TuiPanel;
  readonly draftPolicy?: "preserve" | "consume" | "reject";
}

export const tuiCommands: readonly TuiCommandDefinition[] = Object.freeze([
  { name: "help", descriptionKey: "cmd.help", argumentHint: "[command|advanced]", category: "inspect", visibility: "primary", panel: "help", draftPolicy: "preserve" },
  { name: "settings", descriptionKey: "cmd.settings", category: "inspect", visibility: "primary", draftPolicy: "preserve" },
  { name: "status", descriptionKey: "cmd.status", category: "inspect", visibility: "primary", panel: "overview", draftPolicy: "preserve" },
  {
    name: "memory",
    descriptionKey: "cmd.memory",
    argumentHint: "[list|remember|accept|correct|forget|promote|pin|unpin]",
    category: "manage",
    visibility: "primary",
  },
  {
    name: "goal",
    descriptionKey: "cmd.goal",
    argumentHint: "[prompt]",
    category: "control",
    visibility: "primary",
  },
  { name: "mode", descriptionKey: "cmd.mode", argumentHint: "[ask|plan|agent]", category: "control", visibility: "primary" },
  {
    name: "ask",
    descriptionKey: "cmd.ask",
    argumentHint: "[prompt]",
    category: "control",
    visibility: "primary",
  },
  { name: "login", descriptionKey: "cmd.login", argumentHint: "[status|list|logout [provider]|<provider> [device|key <api-key>]]", category: "manage", visibility: "primary", draftPolicy: "preserve" },
  {
    name: "plan",
    descriptionKey: "cmd.plan",
    argumentHint: "[prompt|accept|revise [feedback]|reject [feedback]]",
    category: "inspect",
    visibility: "primary",
    panel: "plan",
  },
  { name: "skills", descriptionKey: "cmd.skills", category: "inspect", visibility: "primary", panel: "skills" },
  { name: "plugins", descriptionKey: "cmd.plugins", category: "inspect", visibility: "primary" },
  { name: "agents", descriptionKey: "cmd.agents", category: "inspect", visibility: "primary" },
  { name: "mcp", descriptionKey: "cmd.mcp", category: "manage", visibility: "primary", draftPolicy: "preserve" },
  { name: "tasks", descriptionKey: "cmd.tasks", category: "inspect", visibility: "primary", panel: "tasks" },
  { name: "jobs", descriptionKey: "cmd.jobs", argumentHint: "[stop <N|ID>]", category: "inspect", visibility: "primary", panel: "jobs" },
  { name: "mounts", descriptionKey: "cmd.mounts", argumentHint: "[add <path>|unmount <id>]", category: "inspect", visibility: "primary" },
  { name: "permissions", descriptionKey: "cmd.permissions", category: "inspect", visibility: "primary", draftPolicy: "preserve" },
  { name: "shell", descriptionKey: "cmd.shell", category: "manage", visibility: "primary", draftPolicy: "preserve" },
  { name: "verify", descriptionKey: "cmd.verify", category: "inspect", visibility: "primary" },
  { name: "runs", descriptionKey: "cmd.runs", category: "navigate", visibility: "primary", panel: "runs" },
  { name: "sessions", descriptionKey: "cmd.sessions", category: "navigate", visibility: "primary", draftPolicy: "preserve" },
  { name: "model", descriptionKey: "cmd.model", category: "manage", visibility: "primary", draftPolicy: "preserve" },
  { name: "reset-workspace", descriptionKey: "cmd.reset-workspace", category: "control", visibility: "primary", draftPolicy: "consume" },
  { name: "next", descriptionKey: "cmd.next", argumentHint: "[continue|stop|plan]", category: "control", visibility: "primary" },
  { name: "steer", descriptionKey: "cmd.steer", argumentHint: "<text>", category: "control", visibility: "primary" },
  { name: "cancel", descriptionKey: "cmd.cancel", category: "control", visibility: "primary" },
  { name: "quit", descriptionKey: "cmd.quit", category: "control", visibility: "primary" },

  { name: "config", descriptionKey: "cmd.config", category: "inspect", visibility: "alias", panel: "config" },
  { name: "max-steps", descriptionKey: "cmd.max-steps", category: "manage", visibility: "alias", draftPolicy: "preserve" },
  {
    name: "max-actions-per-step",
    descriptionKey: "cmd.max-actions-per-step",
    category: "manage",
    visibility: "alias",
    draftPolicy: "preserve",
  },
  { name: "subagent", descriptionKey: "cmd.subagent", category: "manage", visibility: "alias", draftPolicy: "preserve" },
  { name: "delegate", descriptionKey: "cmd.subagent", category: "manage", visibility: "alias", draftPolicy: "preserve" },
  { name: "context", descriptionKey: "cmd.context", category: "inspect", visibility: "alias", panel: "context" },
  { name: "providers", descriptionKey: "cmd.providers", category: "inspect", visibility: "alias" },
  { name: "skill", descriptionKey: "cmd.skill", category: "manage", visibility: "alias" },
  { name: "job", descriptionKey: "cmd.job", argumentHint: "stop <N|ID>", category: "manage", visibility: "alias" },
  { name: "task", descriptionKey: "cmd.task", argumentHint: "stop <N|ID>", category: "manage", visibility: "alias" },
  { name: "add-dir", descriptionKey: "cmd.add-dir", argumentHint: "<path>", category: "control", visibility: "alias" },
  { name: "unmount", descriptionKey: "cmd.unmount", argumentHint: "<id>", category: "control", visibility: "alias" },
  { name: "exit", descriptionKey: "cmd.exit", category: "control", visibility: "alias" },

  { name: "coord", descriptionKey: "cmd.coord", category: "inspect", visibility: "advanced", panel: "coord" },
  { name: "work", descriptionKey: "cmd.work", category: "inspect", visibility: "advanced", panel: "work" },
  { name: "gate", descriptionKey: "cmd.gate", category: "inspect", visibility: "advanced", panel: "gate" },
  { name: "extensions", descriptionKey: "cmd.extensions", category: "inspect", visibility: "advanced", panel: "extensions" },
]);

export function primarySlashCommands(locale: Locale = defaultLocale()): readonly SlashCommand[] {
  return Object.freeze(
    tuiCommands
      .filter((command) => command.visibility === "primary")
      .map((command) => toSlashCommand(command, locale)),
  );
}

/**
 * Slash commands offered in the editor `/` autocomplete.
 * Includes primary commands plus a small set of inspect/manage aliases (`/config`, `/max-steps`, …).
 * History drill-downs (Steps / Actions / Agents) live under `/runs`, not as separate slash names.
 */
export function autocompleteSlashCommands(locale: Locale = defaultLocale()): readonly SlashCommand[] {
  return Object.freeze(
    tuiCommands
      .filter((command) =>
        command.visibility === "primary"
        || (command.visibility === "alias" && (
          command.name === "config"
          || command.name === "context"
          || command.name === "providers"
          || command.name === "max-steps"
          || command.name === "max-actions-per-step"
          || command.name === "subagent"
          || command.name === "delegate"
          || command.name === "exit"
        )))
      .map((command) => toSlashCommand(command, locale)),
  );
}

export function toSlashCommand(command: TuiCommandDefinition, locale: Locale): SlashCommand {
  return {
    name: command.name,
    description: t(locale, command.descriptionKey),
    ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
  };
}

export function parseTuiCommand(input: string): ParsedTuiCommand | undefined {
  const newline = input.search(/\r?\n/);
  const commandLine = newline < 0 ? input : input.slice(0, newline);
  const draft = newline < 0 ? undefined : input.slice(newline + (input[newline] === "\r" ? 2 : 1));
  const trimmed = commandLine.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const separator = trimmed.search(/\s/);
  if (separator < 0) return {
    name: trimmed.slice(1).toLowerCase(),
    argument: "",
    ...(draft === undefined ? {} : { draft }),
  };
  return {
    name: trimmed.slice(1, separator).toLowerCase(),
    argument: trimmed.slice(separator).trim(),
    ...(draft === undefined ? {} : { draft }),
  };
}

export function commandHelp(commandName?: string, locale: Locale = defaultLocale()): string[] {
  const requested = commandName?.replace(/^\//, "").trim().toLowerCase();
  if (requested === "advanced") {
    return advancedCommandHelp(locale);
  }
  if (requested) {
    const command = tuiCommands.find((candidate) => candidate.name === requested);
    return command
      ? [
          `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
          t(locale, command.descriptionKey),
        ]
      : [t(locale, "help.unknown", { name: requested })];
  }
  const lines = [
    t(locale, "help.title.shortcuts"),
    `  Shift+Tab             ${t(locale, "help.shortcut.tab")}`,
    `  Ctrl+O                ${t(locale, "help.shortcut.ctrlo")}`,
    `  Shift+Enter / Ctrl+J  ${t(locale, "help.shortcut.newline")}`,
    `  Ctrl+V / Alt+V        ${t(locale, "help.shortcut.pasteimage")}`,
    `  Ctrl+C                ${t(locale, "help.shortcut.ctrlc")}`,
    `  Esc                   ${t(locale, "help.shortcut.esc")}`,
    `  ↑ / ↓                 ${t(locale, "help.shortcut.arrows")}`,
    `  Enter                 ${t(locale, "help.shortcut.enter")}`,
    "",
    t(locale, "help.title.commands"),
  ];
  for (const category of ["inspect", "navigate", "manage", "control"] as const) {
    const commands = tuiCommands.filter(
      (candidate) => candidate.visibility === "primary" && candidate.category === category,
    );
    if (commands.length === 0) continue;
    lines.push(`  ${t(locale, `help.category.${category}`)}`);
    for (const command of commands) {
      lines.push(
        `    /${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""} — ${t(locale, command.descriptionKey)}`,
      );
    }
  }
  lines.push("", t(locale, "help.footer"), t(locale, "help.hint.advanced"));
  return lines;
}

function advancedCommandHelp(locale: Locale): string[] {
  const lines = [t(locale, "help.title.advanced")];
  for (const visibility of ["alias", "advanced"] as const) {
    const commands = tuiCommands.filter((candidate) => candidate.visibility === visibility);
    if (commands.length === 0) continue;
    lines.push(`  ${visibility}`);
    for (const command of commands) {
      lines.push(
        `    /${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""} — ${t(locale, command.descriptionKey)}`,
      );
    }
  }
  return lines;
}

export interface SkillInstallCommand {
  readonly source: string;
  readonly scope: "user" | "workspace";
}

export function parseSkillInstallCommand(argument: string): SkillInstallCommand {
  const match = /^install(?:\s+(--workspace))?\s+([\s\S]+)$/i.exec(argument.trim());
  if (!match?.[2]) throw new TypeError("Usage: /skills install [--workspace] <name-or-path>");
  let source = match[2].trim();
  if ((source.startsWith('"') && source.endsWith('"')) || (source.startsWith("'") && source.endsWith("'"))) {
    source = source.slice(1, -1).trim();
  }
  if (!source) throw new TypeError("Skill source must not be empty");
  return { source, scope: match[1] ? "workspace" : "user" };
}

export interface MountsCommand {
  readonly mode: "list" | "add" | "unmount";
  readonly argument: string;
}

export function parseMountsCommand(argument: string): MountsCommand {
  const trimmed = argument.trim();
  if (!trimmed) return { mode: "list", argument: "" };
  const separator = trimmed.search(/\s/);
  const verb = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
  const rest = separator < 0 ? "" : trimmed.slice(separator).trim();
  if (verb === "add") {
    if (!rest) throw new TypeError("Usage: /mounts add <path>");
    return { mode: "add", argument: rest };
  }
  if (verb === "unmount" || verb === "remove") {
    if (!rest) throw new TypeError("Usage: /mounts unmount <id>");
    return { mode: "unmount", argument: rest };
  }
  throw new TypeError("Usage: /mounts · /mounts add <path> · /mounts unmount <id>");
}

export function parseJobStopCommand(argument: string): string {
  const match = /^stop\s+(.+)$/i.exec(argument.trim());
  if (!match?.[1]) throw new TypeError("Usage: /jobs stop <N|ID>");
  return match[1].trim();
}

/** @deprecated Use parseJobStopCommand — ProcessTasks moved to /jobs (ADR-0035). */
export function parseTaskStopCommand(argument: string): string {
  return parseJobStopCommand(argument);
}
