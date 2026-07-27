import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** User Qi home: `QI_HOME` or `~/.qi`. */
export function defaultQiHome(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  homeDirectory = homedir(),
): string {
  const fromEnv = environment.QI_HOME?.trim();
  return fromEnv ? resolve(fromEnv) : resolve(homeDirectory, ".qi");
}

/**
 * Stable slug for a Workspace path, Cursor-style:
 * `D:\ai-project\qi` → `D-ai-project-qi`, `/home/u/p` → `home-u-p`.
 */
export function workspaceProjectSlug(workspaceRoot: string): string {
  const absolute = absoluteWorkspacePath(workspaceRoot);
  const withoutDriveColon = absolute.replace(/^([A-Za-z]):/, "$1");
  return withoutDriveColon.split("/").filter(Boolean).join("-");
}

/**
 * Default Session data directory (sqlite, artifacts, plans, tasks):
 * `~/.qi/projects/<workspace-slug>` (or `$QI_HOME/projects/...`).
 * Workspace-local `.qi` remains for Skills / verify manifests only.
 */
export function defaultSessionDataRoot(
  workspaceRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  homeDirectory = homedir(),
): string {
  return resolve(
    defaultQiHome(environment, homeDirectory),
    "projects",
    workspaceProjectSlug(workspaceRoot),
  );
}

/** Per-Workspace permissions / mounts: `…/projects/<slug>/config.toml`. */
export function defaultProjectConfigPath(
  workspaceRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  homeDirectory = homedir(),
): string {
  return resolve(defaultSessionDataRoot(workspaceRoot, environment, homeDirectory), "config.toml");
}

function absoluteWorkspacePath(workspaceRoot: string): string {
  const trimmed = workspaceRoot.trim();
  // Preserve Windows drive paths even when this code runs on POSIX (tests / cross-compile).
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) {
    return trimmed.replace(/\\/g, "/");
  }
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(trimmed);
  return absolute.replace(/\\/g, "/");
}
