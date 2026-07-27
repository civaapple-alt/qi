import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "./registry.js";
import { ToolFailure } from "./errors.js";

export class FileArtifactStore implements ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async put(content: Uint8Array, mediaType: string): Promise<{ ref: string; size: number; sha256: string }> {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const directory = join(this.#root, sha256.slice(0, 2));
    await mkdir(directory, { recursive: true });
    const path = join(directory, sha256);
    await writeFile(path, content, { flag: "wx" }).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) {
        throw error;
      }
    });
    await writeFile(`${path}.media-type`, mediaType, { flag: "w" });
    return { ref: `artifact://${sha256}`, size: content.byteLength, sha256 };
  }

  async get(ref: string): Promise<{ content: Uint8Array; mediaType: string }> {
    const match = /^artifact:\/\/([a-f0-9]{64})$/.exec(ref);
    if (!match?.[1]) throw new ToolFailure("INVALID_ARTIFACT_REF", `Invalid artifact reference: ${ref}`);
    const path = join(this.#root, match[1].slice(0, 2), match[1]);
    try {
      const [content, mediaType] = await Promise.all([readFile(path), readFile(`${path}.media-type`, "utf8")]);
      return { content, mediaType };
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ToolFailure("ARTIFACT_NOT_FOUND", `Artifact does not exist: ${ref}`);
      }
      throw error;
    }
  }
}
