import type { ContextBlock } from "@civaapple/qi-context";
import type { ArtifactStore } from "@civaapple/qi-tools";

/** Load allowlisted Artifact refs into Context Compiler blocks for an isolated child Turn. */
export async function contextBlocksFromRefs(
  artifactStore: ArtifactStore,
  contextRefs: readonly string[],
  options: { maxCharsPerRef?: number } = {},
): Promise<ContextBlock[]> {
  const maxChars = options.maxCharsPerRef ?? 12_000;
  const blocks: ContextBlock[] = [];
  for (const [index, ref] of contextRefs.entries()) {
    const stored = await artifactStore.get(ref);
    const text = Buffer.from(stored.content).toString("utf8");
    const truncated = text.length > maxChars
      ? `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`
      : text;
    blocks.push({
      id: `delegation-context:${index}`,
      kind: "workspace",
      source: ref,
      role: "user",
      content: `<delegated-context ref="${ref}">\n${truncated}\n</delegated-context>`,
      priority: 80,
      required: true,
      retentionReason: "Parent-allowlisted contextRef for isolated Subagent",
    });
  }
  return blocks;
}
