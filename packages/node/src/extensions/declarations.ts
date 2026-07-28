import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

export const WORKSPACE_QI_FILES = new Set([
  "packages.toml",
  "packages.lock.json",
  "qi.verify.json",
]);
export const WORKSPACE_QI_DIRECTORIES = new Set([
  "skills",
  "prompts",
  "themes",
  "agents",
  "workflows",
  "mcp",
]);

const executableExtensions = new Set([
  ".js", ".cjs", ".mjs", ".jsx", ".ts", ".cts", ".mts", ".tsx", ".node",
  ".exe", ".dll", ".so", ".dylib", ".bat", ".cmd", ".ps1", ".sh",
]);
const declarationExtensions = new Set([
  ".md", ".json", ".jsonc", ".toml", ".yaml", ".yml", ".txt",
]);
const secretPatterns = [
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization)\s*[:=]\s*["']?[^\s"'${}]+/i,
  /"(?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization)"\s*:\s*"(?!\$\{)[^"]+"/i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

export interface DeclarationValidationOptions {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

export interface ValidatedDeclarationTree {
  readonly files: readonly string[];
  readonly totalBytes: number;
}

export async function validateWorkspaceQiDirectory(
  workspaceRoot: string,
  options: DeclarationValidationOptions = {},
): Promise<ValidatedDeclarationTree> {
  const qiRoot = resolve(workspaceRoot, ".qi");
  return validateDeclarativeTree(qiRoot, { ...options, workspaceQiRoot: true });
}

export async function validateDeclarativeTree(
  root: string,
  options: DeclarationValidationOptions & { readonly workspaceQiRoot?: boolean } = {},
): Promise<ValidatedDeclarationTree> {
  const maximumFiles = options.maxFiles ?? 2_000;
  const maximumFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  const maximumTotalBytes = options.maxTotalBytes ?? 32 * 1024 * 1024;
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Declarative root must be a real directory: ${root}`);
  }
  const rootReal = await realpath(root);
  const pending = [root];
  const files: string[] = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Symlinks are forbidden in declarative content: ${absolute}`);
      assertContained(rootReal, await realpath(absolute));
      const relativePath = relative(root, absolute).replace(/\\/g, "/");
      if (options.workspaceQiRoot) assertWorkspaceAllowlist(relativePath);
      if (info.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!info.isFile()) throw new Error(`Unsupported declarative entry: ${relativePath}`);
      if (executableExtensions.has(extname(entry.name).toLowerCase())) {
        throw new Error(`Executable content is forbidden in declarative trees: ${relativePath}`);
      }
      const extension = extname(entry.name).toLowerCase();
      if (!declarationExtensions.has(extension)) {
        throw new Error(`Unsupported declarative file type: ${relativePath}`);
      }
      if (info.size > maximumFileBytes) throw new Error(`Declarative file is too large: ${relativePath}`);
      files.push(relativePath);
      totalBytes += info.size;
      if (files.length > maximumFiles) throw new Error(`Declarative tree exceeds ${maximumFiles} files`);
      if (totalBytes > maximumTotalBytes) throw new Error(`Declarative tree exceeds ${maximumTotalBytes} bytes`);
      if (isTextDeclaration(relativePath)) {
        const content = await readFile(absolute, "utf8");
        if (secretPatterns.some((pattern) => pattern.test(content))) {
          throw new Error(`Possible embedded credential in declarative content: ${relativePath}`);
        }
      }
    }
  }
  return { files: files.sort(), totalBytes };
}

function assertWorkspaceAllowlist(path: string): void {
  const [first, ...rest] = path.split("/");
  if (rest.length === 0 && WORKSPACE_QI_FILES.has(first!)) return;
  if (WORKSPACE_QI_DIRECTORIES.has(first!)) return;
  throw new Error(`Path is not allowed in Workspace .qi: ${path}`);
}

function assertContained(root: string, candidate: string): void {
  const result = relative(root, candidate);
  if (result === ".." || result.startsWith(`..${sep}`)) {
    throw new Error(`Declarative path escapes its root: ${candidate}`);
  }
}

function isTextDeclaration(path: string): boolean {
  return /\.(?:md|json|jsonc|toml|ya?ml|txt)$/i.test(path);
}
