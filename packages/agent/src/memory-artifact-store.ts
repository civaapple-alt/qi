import { createHash } from "node:crypto";
import type { ArtifactStore } from "@civaapple/qi-agent/tools";

interface StoredArtifact {
  readonly content: Uint8Array;
  readonly mediaType: string;
}

/**
 * Process-local ArtifactStore for examples, tests, and short-lived embedded Agents.
 * Durable applications should supply FileArtifactStore or another persistent adapter.
 */
export class InMemoryArtifactStore implements ArtifactStore {
  readonly #artifacts = new Map<string, StoredArtifact>();

  async put(
    content: Uint8Array,
    mediaType: string,
  ): Promise<{ ref: string; size: number; sha256: string }> {
    if (!mediaType.trim()) throw new TypeError("Artifact mediaType must not be empty");
    const bytes = Uint8Array.from(content);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const ref = `artifact://${sha256}`;
    this.#artifacts.set(ref, { content: bytes, mediaType });
    return { ref, size: bytes.byteLength, sha256 };
  }

  async get(ref: string): Promise<{ content: Uint8Array; mediaType: string }> {
    const artifact = this.#artifacts.get(ref);
    if (!artifact) throw new Error(`Artifact does not exist: ${ref}`);
    return {
      content: Uint8Array.from(artifact.content),
      mediaType: artifact.mediaType,
    };
  }
}
