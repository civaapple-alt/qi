/** ACP stdio: stdout is JSON-RPC only. All diagnostics go to stderr. */
export function acpLog(message: string, detail?: unknown): void {
  const suffix = detail === undefined
    ? ""
    : ` ${typeof detail === "string" ? detail : safeJson(detail)}`;
  process.stderr.write(`[qi acp] ${message}${suffix}\n`);
}

export function redirectConsoleToStderr(): void {
  const sink = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(stringifyArg).join(" ")}\n`);
  };
  globalThis.console.log = sink;
  globalThis.console.info = sink;
  globalThis.console.warn = sink;
  globalThis.console.debug = sink;
  // Keep console.error on stderr (already is); still route through sink for consistency.
  globalThis.console.error = sink;
}

function stringifyArg(value: unknown): string {
  if (typeof value === "string") return value;
  return safeJson(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
