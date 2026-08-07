import { runHostProcess, type HostProcessOptions, type HostProcessResult } from "@civaapple/qi-node/workspace";
import type { ToolExecutionContext } from "@civaapple/qi-agent/tools";

/**
 * Prefer Runtime-injected sandboxed runner (ADR-0041); fall back to honest host process.
 */
export function runToolProcess(
  context: ToolExecutionContext,
  command: string,
  args: readonly string[],
  options?: HostProcessOptions,
): Promise<HostProcessResult> {
  if (context.runProcess) {
    return context.runProcess(command, args, options);
  }
  return runHostProcess(command, args, options);
}
