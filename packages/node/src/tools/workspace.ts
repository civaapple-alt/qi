import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ToolFailure, type WorkspaceMount } from "@civaapple/qi-agent/tools";
export type { WorkspaceMount } from "@civaapple/qi-agent/tools";

const protectedEntries = new Set([".git", ".qi", ".artifacts"]);
const mountPathPattern = /^mount:([a-z][a-z0-9-]{0,63})\/(.*)$/s;

export interface ResolvedAccessiblePath {
  readonly absolute: string;
  /** Real path of the primary Workspace or mount root that contains `absolute`. */
  readonly rootAbsolute: string;
  readonly rootKind: "workspace" | "mount";
  readonly mountId?: string;
}

export async function resolveWorkspacePath(
  root: string,
  requested: string,
  allowMissing = false,
  allowProtected = false,
): Promise<string> {
  if (!requested || mountPathPattern.test(requested)) {
    throw new ToolFailure("PATH_OUTSIDE_WORKSPACE", "Path must be relative to the Workspace root");
  }
  const relativePath = await coerceWorkspaceRelativePath(root, requested);
  return resolveUnderRoot(root, relativePath, allowMissing, allowProtected);
}

export async function resolveWorkspaceEntry(
  root: string,
  requested: string,
  allowProtected = false,
): Promise<string> {
  if (!requested || mountPathPattern.test(requested)) {
    throw new ToolFailure("PATH_OUTSIDE_WORKSPACE", "Path must be relative to the Workspace root");
  }
  const relativePath = await coerceWorkspaceRelativePath(root, requested);
  const rootReal = await realpath(root);
  const lexical = resolve(rootReal, relativePath);
  assertWithin(rootReal, lexical);
  assertNotProtected(rootReal, lexical, allowProtected);
  const info = await lstat(lexical);
  if (info.isSymbolicLink()) throw new ToolFailure("SYMLINK_NOT_ALLOWED", `${relativePath} must not be a symbolic link`);
  const targetReal = await realpath(lexical);
  assertWithin(rootReal, targetReal);
  assertNotProtected(rootReal, targetReal, allowProtected);
  return lexical;
}

/**
 * Resolve a path for read/discovery tools against the primary Workspace and read-only mounts.
 * Mount paths use `mount:<id>/relative…`. Absolute paths under the Workspace or an authorized mount are
 * rewritten onto that root; absolute paths outside authorized roots request a human grant.
 */
export async function resolveAccessiblePath(
  root: string,
  requested: string,
  mounts: readonly WorkspaceMount[] = [],
  allowMissing = false,
  allowProtected = false,
): Promise<ResolvedAccessiblePath> {
  if (!requested) {
    throw new ToolFailure("PATH_OUTSIDE_WORKSPACE", "Path must not be empty");
  }

  const mountMatch = mountPathPattern.exec(requested);
  if (mountMatch) {
    const mountId = mountMatch[1]!;
    const relativePath = mountMatch[2] ?? "";
    const mount = mounts.find((candidate) => candidate.id === mountId);
    if (!mount) {
      throw new ToolFailure("MOUNT_NOT_FOUND", `Unknown mount id: ${mountId}`, { mountId });
    }
    if (mount.mode !== "read") {
      throw new ToolFailure("MOUNT_READ_ONLY", `Mount ${mountId} is read-only`);
    }
    const rootAbsolute = await realpath(mount.path);
    const absolute = await resolveUnderRoot(mount.path, relativePath || ".", allowMissing, allowProtected);
    return { absolute, rootAbsolute, rootKind: "mount", mountId };
  }

  if (isAbsolute(requested)) {
    const absolute = resolve(requested);
    const underWorkspace = await relativeUnderRoot(root, absolute);
    if (underWorkspace !== undefined) {
      const rootAbsolute = await realpath(root);
      const resolved = await resolveUnderRoot(root, underWorkspace, allowMissing, allowProtected);
      return { absolute: resolved, rootAbsolute, rootKind: "workspace" };
    }
    for (const mount of mounts) {
      const underMount = await relativeUnderRoot(mount.path, absolute);
      if (underMount === undefined) continue;
      if (mount.mode !== "read") {
        throw new ToolFailure("MOUNT_READ_ONLY", `Mount ${mount.id} is read-only`);
      }
      const rootAbsolute = await realpath(mount.path);
      const resolved = await resolveUnderRoot(mount.path, underMount, allowMissing, allowProtected);
      return { absolute: resolved, rootAbsolute, rootKind: "mount", mountId: mount.id };
    }
    throw new ToolFailure(
      "PATH_GRANT_REQUIRED",
      `Path is outside the Workspace and mounts; authorize with /add-dir or the grant panel: ${absolute}`,
      { path: absolute },
    );
  }

  try {
    const rootAbsolute = await realpath(root);
    const absolute = await resolveUnderRoot(root, requested, allowMissing, allowProtected);
    return { absolute, rootAbsolute, rootKind: "workspace" };
  } catch (error) {
    if (error instanceof ToolFailure && error.code === "PATH_OUTSIDE_WORKSPACE") {
      const lexical = resolve(root, requested);
      throw new ToolFailure(
        "PATH_GRANT_REQUIRED",
        `Path escapes the Workspace; authorize a mount if this local directory should be readable: ${lexical}`,
        { path: lexical },
      );
    }
    throw error;
  }
}

export async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export function mountsFromContext(context: {
  mounts?: readonly WorkspaceMount[];
  getMounts?: () => readonly WorkspaceMount[];
}): readonly WorkspaceMount[] {
  return context.getMounts?.() ?? context.mounts ?? [];
}

/** Format an absolute path for tool I/O under the primary Workspace or a mount. */
export function formatAccessiblePath(
  resolved: ResolvedAccessiblePath,
  _workspaceRoot: string,
  _mounts: readonly WorkspaceMount[],
  absolutePath: string,
): string {
  const relativePath = relative(resolved.rootAbsolute, absolutePath).replaceAll("\\", "/");
  if (resolved.rootKind === "mount" && resolved.mountId) {
    return relativePath === "" || relativePath === "."
      ? `mount:${resolved.mountId}/`
      : `mount:${resolved.mountId}/${relativePath}`;
  }
  return relativePath || ".";
}

/**
 * Accept Workspace-relative paths as-is. Absolute paths under `root` are rewritten to a portable
 * relative form (forward slashes); absolute paths outside `root` stay rejected so authority cannot widen.
 */
async function coerceWorkspaceRelativePath(root: string, requested: string): Promise<string> {
  if (!isAbsolute(requested)) return requested;
  const rewritten = await relativeUnderRoot(root, requested);
  if (rewritten === undefined) {
    throw new ToolFailure("PATH_OUTSIDE_WORKSPACE", "Path must be relative to the Workspace root");
  }
  return rewritten;
}

/** Return a forward-slash relative path when `absolute` is under `root`; otherwise `undefined`. */
async function relativeUnderRoot(root: string, absolute: string): Promise<string | undefined> {
  try {
    const rootReal = await realpath(root);
    const target = resolve(absolute);
    const targetReal = await realpath(target).catch(() => target);
    const path = relative(rootReal, targetReal);
    if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) {
      return path.replaceAll("\\", "/") || ".";
    }
  } catch {
    // Missing/unreadable root → treat as outside.
  }
  return undefined;
}

async function resolveUnderRoot(
  root: string,
  requested: string,
  allowMissing: boolean,
  allowProtected: boolean,
): Promise<string> {
  const rootReal = await realpath(root);
  const lexical = resolve(rootReal, requested);
  assertWithin(rootReal, lexical);
  assertNotProtected(rootReal, lexical, allowProtected);

  try {
    const targetReal = await realpath(lexical);
    assertWithin(rootReal, targetReal);
    assertNotProtected(rootReal, targetReal, allowProtected);
    return targetReal;
  } catch (error) {
    if (allowMissing && isMissing(error)) {
      let parent = resolve(lexical, "..");
      while (true) {
        try {
          const parentReal = await realpath(parent);
          assertWithin(rootReal, parentReal);
          assertNotProtected(rootReal, parentReal, allowProtected);
          return lexical;
        } catch (parentError) {
          if (!isMissing(parentError)) throw mapPathResolutionError(parentError, requested);
          const next = resolve(parent, "..");
          if (next === parent) throw new ToolFailure("PATH_OUTSIDE_WORKSPACE", "No Workspace parent exists");
          parent = next;
        }
      }
    }
    throw mapPathResolutionError(error, requested);
  }
}

function assertWithin(root: string, target: string): void {
  const path = relative(root, target);
  if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) return;
  throw new ToolFailure("PATH_OUTSIDE_WORKSPACE", `Path escapes Workspace root: ${target}`);
}

function assertNotProtected(root: string, target: string, allowProtected: boolean): void {
  if (allowProtected) return;
  const first = relative(root, target).split(/[\\/]/, 1)[0]?.toLowerCase();
  if (first && protectedEntries.has(first)) {
    throw new ToolFailure("PROTECTED_WORKSPACE_PATH", `${first} is reserved for Workspace runtime or VCS state`);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isNotDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOTDIR";
}

/**
 * Confirmed path-resolution failures must be ToolFailure so Effect Journal settles `failed`
 * (not indeterminate) before any host process starts.
 */
function mapPathResolutionError(error: unknown, requested: string): never {
  if (error instanceof ToolFailure) throw error;
  if (isMissing(error)) {
    throw new ToolFailure("PATH_NOT_FOUND", `Path not found: ${requested || "."}`);
  }
  if (isNotDirectory(error)) {
    throw new ToolFailure("NOT_A_DIRECTORY", `${requested || "."} is not a directory`);
  }
  throw error;
}
