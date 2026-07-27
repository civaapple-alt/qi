import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ToolFailure } from "./errors.js";

const protectedEntries = new Set([".git", ".qi", ".artifacts"]);
const mountPathPattern = /^mount:([a-z][a-z0-9-]{0,63})\/(.*)$/s;

export interface WorkspaceMount {
  readonly id: string;
  readonly path: string;
  readonly mode: "read";
}

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
  if (!requested || isAbsolute(requested) || mountPathPattern.test(requested)) {
    throw new ToolFailure("PATH_OUTSIDE_WORKSPACE", "Path must be relative to the Workspace root");
  }
  return resolveUnderRoot(root, requested, allowMissing, allowProtected);
}

export async function resolveWorkspaceEntry(
  root: string,
  requested: string,
  allowProtected = false,
): Promise<string> {
  if (!requested || isAbsolute(requested) || mountPathPattern.test(requested)) {
    throw new ToolFailure("PATH_OUTSIDE_WORKSPACE", "Path must be relative to the Workspace root");
  }
  const rootReal = await realpath(root);
  const lexical = resolve(rootReal, requested);
  assertWithin(rootReal, lexical);
  assertNotProtected(rootReal, lexical, allowProtected);
  const info = await lstat(lexical);
  if (info.isSymbolicLink()) throw new ToolFailure("SYMLINK_NOT_ALLOWED", `${requested} must not be a symbolic link`);
  const targetReal = await realpath(lexical);
  assertWithin(rootReal, targetReal);
  assertNotProtected(rootReal, targetReal, allowProtected);
  return lexical;
}

/**
 * Resolve a path for read/discovery tools against the primary Workspace and read-only mounts.
 * Mount paths use `mount:<id>/relative…`. Absolute paths outside authorized roots request a human grant.
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
    const underWorkspace = await tryContainment(root, absolute);
    if (underWorkspace) {
      throw new ToolFailure(
        "PATH_OUTSIDE_WORKSPACE",
        "Use a path relative to the Workspace root instead of an absolute Workspace path",
      );
    }
    for (const mount of mounts) {
      if (await tryContainment(mount.path, absolute)) {
        throw new ToolFailure(
          "PATH_OUTSIDE_WORKSPACE",
          `Use mount:${mount.id}/… instead of an absolute path under that mount`,
          { mountId: mount.id },
        );
      }
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
    if (!allowMissing || !isMissing(error)) throw error;
    let parent = resolve(lexical, "..");
    while (true) {
      try {
        const parentReal = await realpath(parent);
        assertWithin(rootReal, parentReal);
        assertNotProtected(rootReal, parentReal, allowProtected);
        return lexical;
      } catch (parentError) {
        if (!isMissing(parentError)) throw parentError;
        const next = resolve(parent, "..");
        if (next === parent) throw new ToolFailure("PATH_OUTSIDE_WORKSPACE", "No Workspace parent exists");
        parent = next;
      }
    }
  }
}

async function tryContainment(root: string, absolute: string): Promise<boolean> {
  try {
    const rootReal = await realpath(root);
    const targetReal = await realpath(absolute).catch(async () => absolute);
    const path = relative(rootReal, targetReal);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  } catch {
    return false;
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
