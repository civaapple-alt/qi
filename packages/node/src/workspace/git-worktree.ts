import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { hostProcessRunner, type ProcessRunner } from "./process.js";

export interface WorkspaceBranch {
  branch: string;
  root: string;
  base: string;
}

export class GitWorktreeAdapter {
  readonly #repositoryRoot: string;
  readonly #runner: ProcessRunner;

  constructor(repositoryRoot: string, runner: ProcessRunner = hostProcessRunner) {
    this.#repositoryRoot = resolve(repositoryRoot);
    this.#runner = runner;
  }

  async assertAvailable(): Promise<void> {
    const result = await this.#runner.run("git", ["rev-parse", "--show-toplevel"], { cwd: this.#repositoryRoot });
    if (result.exitCode !== 0) throw new Error(`Workspace is not a Git repository: ${result.stderr.trim()}`);
  }

  async branch(branch: string, destination: string, base = "HEAD"): Promise<WorkspaceBranch> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes("..")) {
      throw new TypeError(`Invalid Git branch name: ${branch}`);
    }
    const root = resolve(destination);
    if (await exists(root)) throw new Error(`Worktree destination already exists: ${root}`);
    const result = await this.#runner.run("git", ["worktree", "add", "-b", branch, root, base], { cwd: this.#repositoryRoot });
    if (result.exitCode !== 0) throw new Error(`git worktree add failed: ${result.stderr.trim()}`);
    return { branch, root, base };
  }

  async diff(worktreeRoot = this.#repositoryRoot): Promise<string> {
    const result = await this.#runner.run("git", ["diff", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"], { cwd: worktreeRoot });
    if (result.exitCode !== 0) throw new Error(`git diff failed: ${result.stderr.trim()}`);
    return result.stdout;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}
