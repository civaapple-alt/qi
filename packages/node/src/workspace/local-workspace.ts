import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export interface FileObservation {
  observationId: string;
  path: string;
  sha256: string;
  size: number;
  observedAt: string;
}

export class LocalWorkspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async observe(path: string): Promise<FileObservation> {
    const absolute = this.resolvePath(path);
    const [content, info] = await Promise.all([readFile(absolute), stat(absolute)]);
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    return {
      observationId: `obs_${randomUUID()}`,
      path: relative(this.root, absolute).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.byteLength,
      observedAt: new Date().toISOString(),
    };
  }

  async assertFresh(observation: FileObservation): Promise<void> {
    const current = await this.observe(observation.path);
    if (current.sha256 !== observation.sha256) {
      throw new Error(`Stale observation ${observation.observationId}: expected ${observation.sha256}, found ${current.sha256}`);
    }
  }

  resolvePath(path: string): string {
    const absolute = resolve(this.root, path);
    const prefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    if (absolute !== this.root && !absolute.startsWith(prefix)) throw new Error(`${path} is outside Workspace ${this.root}`);
    return absolute;
  }
}
