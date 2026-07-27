import { defaultProjectsRoot } from "./paths.js";

export interface WebCliEnvironment {
  readonly QI_WEB_DB?: string;
  readonly QI_WEB_PROJECTS?: string;
  readonly QI_WEB_PORT?: string;
  readonly QI_WEB_HOST?: string;
  readonly QI_HOME?: string;
}

export type WebCliOptions =
  | {
      readonly mode: "single";
      readonly dbPath: string;
      readonly port: number;
      readonly host: string;
    }
  | {
      readonly mode: "projects";
      readonly projectsRoot: string;
      readonly port: number;
      readonly host: string;
    };

export const WEB_CLI_USAGE =
  "Usage: qi-web [--projects PATH | DB_PATH | --db PATH] [--port 4317] [--host 127.0.0.1]\n" +
  "  Default (no DB): browse $QI_HOME/projects (or ~/.qi/projects).";

export function parseWebCliArguments(
  args: readonly string[],
  environment: WebCliEnvironment = process.env,
): WebCliOptions {
  const values = new Map<string, string>();
  let positionalDatabase: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === "--help" || argument === "-h") {
      throw new WebCliHelp();
    }
    const assigned = /^(--db|--projects|--port|--host)=(.*)$/.exec(argument);
    if (assigned) {
      const [, name, assignedValue] = assigned;
      if (!name || !assignedValue) throw new TypeError(`${argument} requires a non-empty value`);
      setOnce(values, name, assignedValue);
      continue;
    }
    if (argument === "--db" || argument === "--projects" || argument === "--port" || argument === "--host") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new TypeError(`${argument} requires a value`);
      setOnce(values, argument, next);
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) throw new TypeError(`Unknown argument: ${argument}`);
    if (positionalDatabase !== undefined) {
      throw new TypeError(`Unexpected positional argument: ${argument}`);
    }
    positionalDatabase = argument;
  }

  const flaggedDatabase = optionalValue(values.get("--db"));
  const flaggedProjects = optionalValue(values.get("--projects"));
  if (flaggedDatabase && positionalDatabase) {
    throw new TypeError("Specify the database either positionally or with --db, not both");
  }
  if ((flaggedDatabase || positionalDatabase) && flaggedProjects) {
    throw new TypeError("Use either a database (--db / positional) or --projects, not both");
  }

  const rawPort = optionalValue(values.get("--port")) ?? optionalValue(environment.QI_WEB_PORT) ?? "4317";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError("Invalid port");
  const host = optionalValue(values.get("--host")) ?? optionalValue(environment.QI_WEB_HOST) ?? "127.0.0.1";

  const dbPath = flaggedDatabase ?? optionalValue(positionalDatabase) ?? optionalValue(environment.QI_WEB_DB);
  if (dbPath) {
    return { mode: "single", dbPath, port, host };
  }

  const projectsRoot = flaggedProjects
    ?? optionalValue(environment.QI_WEB_PROJECTS)
    ?? defaultProjectsRoot(environment);
  return { mode: "projects", projectsRoot, port, host };
}

export class WebCliHelp extends Error {
  constructor() {
    super(WEB_CLI_USAGE);
    this.name = "WebCliHelp";
  }
}

function setOnce(values: Map<string, string>, name: string, value: string): void {
  if (values.has(name)) throw new TypeError(`${name} was provided more than once`);
  values.set(name, value);
}

function optionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
