import type { ToolExecutionContext } from "./registry.js";

/**
 * Ceiling for the full stdout+stderr capture kept for a truncated shell/verify/script run's Artifact.
 * Intentionally not exported from the package index: this is an implementation detail shared between
 * builtins.ts and shell-profiles.ts, not a public contract.
 */
export const truncatedOutputCaptureLimitBytes = 8 * 1024 * 1024;

/**
 * When a host-process run was truncated (stdout/stderr exceeded the tool's inline outputLimitBytes),
 * persist the complete stdout/stderr — up to truncatedOutputCaptureLimitBytes — as a retrievable Artifact
 * instead of letting it disappear, and return an `outputRef` to merge into the tool's output. Returns an
 * empty object when there is nothing extra to store, so callers can always spread the result into their
 * output object without changing its shape.
 */
export async function storeTruncatedOutputArtifact(
  context: ToolExecutionContext,
  result: { truncated: boolean; stdoutFull?: string | undefined; stderrFull?: string | undefined },
): Promise<{ outputRef: string } | Record<string, never>> {
  if (!result.truncated || (result.stdoutFull === undefined && result.stderrFull === undefined)) return {};
  const sections: string[] = [];
  if (result.stdoutFull !== undefined) {
    sections.push(`=== stdout (${Buffer.byteLength(result.stdoutFull, "utf8")} bytes) ===\n${result.stdoutFull}`);
  }
  if (result.stderrFull !== undefined) {
    sections.push(`=== stderr (${Buffer.byteLength(result.stderrFull, "utf8")} bytes) ===\n${result.stderrFull}`);
  }
  const stored = await context.artifactStore.put(Buffer.from(sections.join("\n\n"), "utf8"), "text/plain; charset=utf-8");
  return { outputRef: stored.ref };
}
