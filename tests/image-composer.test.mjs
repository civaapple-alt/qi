import assert from "node:assert/strict";
import test from "node:test";
import { readClipboardPaste } from "../apps/cli/dist/clipboard.js";
import {
  imagePlaceholder,
  structuredComposerContent,
} from "../apps/cli/dist/image-composer.js";

const image = {
  type: "image",
  source: "clipboard",
  originalArtifactRef: `artifact://${"a".repeat(64)}`,
  preparedArtifactRef: `artifact://${"b".repeat(64)}`,
  originalMediaType: "image/png",
  mediaType: "image/png",
  originalByteLength: 10,
  byteLength: 10,
  originalWidth: 20,
  originalHeight: 10,
  width: 20,
  height: 10,
  downsampled: false,
  formatChanged: false,
  orientationApplied: false,
};

test("clipboard paste prefers image bytes and falls back to text", async () => {
  const preferred = await readClipboardPaste({
    hasImage: () => true,
    getImageBinary: async () => [137, 80, 78, 71],
    getText: async () => "ignored",
  });
  assert.equal(preferred.type, "image");
  assert.deepEqual([...preferred.bytes], [137, 80, 78, 71]);

  const fallback = await readClipboardPaste({
    hasImage: () => false,
    getImageBinary: async () => [],
    getText: async () => "pasted text",
  });
  assert.deepEqual(fallback, { type: "text", text: "pasted text" });
});

test("composer preserves multi-image order and detaches deleted or damaged placeholders", () => {
  const first = imagePlaceholder(1, image);
  const secondImage = { ...image, preparedArtifactRef: `artifact://${"c".repeat(64)}` };
  const second = imagePlaceholder(2, secondImage);
  const attachments = new Map([[first, image], [second, secondImage]]);
  const content = structuredComposerContent(`before ${first} middle ${second} after`, attachments);
  assert.deepEqual(content.map((part) => part.type), ["text", "image", "text", "image", "text"]);
  assert.equal(content[1].preparedArtifactRef, image.preparedArtifactRef);
  assert.equal(content[3].preparedArtifactRef, secondImage.preparedArtifactRef);

  const damaged = structuredComposerContent(`before ${first.replace("image", "img")} after`, attachments);
  assert.equal(damaged, undefined);
});
