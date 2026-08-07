import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

export interface SrtProbeResult {
  readonly available: boolean;
  readonly kind?: "cli" | "module";
  /** Absolute path to `srt` / `srt.cmd` when kind is cli. */
  readonly path?: string;
  readonly reason: string;
}

/**
 * Detect Anthropic sandbox-runtime without making it a hard dependency.
 * Prefer a PATH-installed `srt` CLI; optionally a resolvable npm module.
 */
export async function probeSrtAvailable(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<SrtProbeResult> {
  const cli = await findOnPath(platform === "win32" ? ["srt.cmd", "srt.exe", "srt"] : ["srt"], environment);
  if (cli) {
    return {
      available: true,
      kind: "cli",
      path: cli,
      reason: `srt CLI found at ${cli}`,
    };
  }

  try {
    // Optional peer; may be absent in most installs. Avoid static import so tsc does not require types.
    const specifier = "@anthropic-ai/sandbox-runtime";
    await import(/* webpackIgnore: true */ specifier);
    return {
      available: true,
      kind: "module",
      reason: "@anthropic-ai/sandbox-runtime module is resolvable (CLI wrap still preferred when srt is on PATH)",
    };
  } catch {
    // ignore
  }

  return {
    available: false,
    reason: "srt CLI not on PATH and @anthropic-ai/sandbox-runtime is not installed",
  };
}

async function findOnPath(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const pathEnv = environment.PATH ?? environment.Path ?? "";
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        await access(candidate, constants.X_OK).catch(async () => {
          await access(candidate, constants.F_OK);
        });
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return undefined;
}
