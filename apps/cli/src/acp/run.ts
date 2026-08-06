import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { parseTuiCliArguments, type TuiCliOptions } from "../cli.js";
import { createQiAcpAgent } from "./server.js";
import { redirectConsoleToStderr, acpLog } from "./log.js";
import {
  createAuthBackedRuntimeFactory,
  type AcpRuntimeFactory,
} from "./runtime-factory.js";

export interface RunAcpServerOptions {
  /** Args after the `acp` subcommand (workspace flags, --safe, …). */
  readonly args?: readonly string[];
  readonly launch?: TuiCliOptions;
  readonly factory?: AcpRuntimeFactory;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

/**
 * Start the ACP stdio server. Resolves when the client closes the connection.
 * Returns true when argv was handled as `acp`.
 */
export async function runAcpCliCommand(
  argv: readonly string[],
  options: Omit<RunAcpServerOptions, "args"> = {},
): Promise<boolean> {
  if (argv[0] !== "acp") return false;
  redirectConsoleToStderr();
  try {
    await runAcpServer({
      args: argv.slice(1),
      ...options,
    });
  } catch (error) {
    acpLog("fatal", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  return true;
}

export async function runAcpServer(options: RunAcpServerOptions = {}): Promise<void> {
  redirectConsoleToStderr();

  let launch = options.launch;
  if (!launch) {
    const parsed = await parseTuiCliArguments([...(options.args ?? [])], {
      cwd: process.cwd(),
      environment: process.env,
    });
    if (parsed.kind !== "run") {
      throw new TypeError("qi acp: unexpected help/version parse result for launch options");
    }
    launch = parsed.options;
  }

  const factory = options.factory ?? createAuthBackedRuntimeFactory();
  const handle = createQiAcpAgent({
    launch,
    factory,
  });

  const stdout = (options.output ?? process.stdout) as Writable;
  const stdin = (options.input ?? process.stdin) as Readable;
  // ndJsonStream(outputWritable, inputReadable)
  const stream = ndJsonStream(
    Writable.toWeb(stdout),
    Readable.toWeb(stdin),
  );

  acpLog("listening on stdio (JSON-RPC); no banner");
  const conn = handle.app.connect(stream);
  try {
    await conn.closed;
  } finally {
    await handle.closeAll();
  }
  acpLog("connection closed");
}
