import assert from "node:assert/strict";
import test from "node:test";
import { FollowUpQueue } from "../apps/cli/dist/follow-ups.js";

test("FollowUpQueue enqueues multiple items and dequeues FIFO", () => {
  const queue = new FollowUpQueue();
  queue.enqueue("first");
  assert.equal(queue.selectedIndex, 0);
  queue.enqueue("second");
  assert.equal(queue.length, 2);
  assert.equal(queue.selectedIndex, 1);
  assert.equal(queue.selected?.text, "second");
  assert.equal(queue.dequeue()?.text, "first");
  assert.equal(queue.dequeue()?.text, "second");
  assert.equal(queue.dequeue(), undefined);
});

test("FollowUpQueue selectPrev/Next and beginEdit/commitEdit", () => {
  const queue = new FollowUpQueue();
  queue.enqueue("alpha");
  queue.enqueue("beta");
  queue.enqueue("gamma");
  assert.equal(queue.selectLast()?.text, "gamma");
  assert.equal(queue.beginEdit(), "gamma");
  assert.equal(queue.editing, true);
  assert.equal(queue.commitEdit("gamma edited")?.text, "gamma edited");
  assert.equal(queue.editing, false);
  assert.equal(queue.selected?.text, "gamma edited");

  queue.selectPrev();
  assert.equal(queue.selected?.text, "beta");
  queue.beginEdit();
  assert.equal(queue.cancelEdit(), "beta");
  assert.equal(queue.selected?.text, "beta");
});

test("FollowUpQueue removeSelected and moveSelectedToFront", () => {
  const queue = new FollowUpQueue();
  queue.enqueue("a");
  queue.enqueue("b");
  queue.enqueue("c");
  queue.selectLast();
  assert.equal(queue.moveSelectedToFront()?.text, "c");
  assert.deepEqual(queue.items.map((item) => item.text), ["c", "a", "b"]);
  queue.selectNext();
  assert.equal(queue.selected?.text, "a");
  assert.equal(queue.removeSelected()?.text, "a");
  assert.deepEqual(queue.items.map((item) => item.text), ["c", "b"]);
});

test("FollowUpQueue commitEdit with empty text removes the item", () => {
  const queue = new FollowUpQueue();
  queue.enqueue("keep");
  queue.enqueue("drop");
  queue.selectLast();
  queue.beginEdit();
  queue.commitEdit("   ");
  assert.deepEqual(queue.items.map((item) => item.text), ["keep"]);
});

test("FollowUpQueue retains structured image payloads until dequeue", () => {
  const queue = new FollowUpQueue();
  const image = {
    type: "image",
    source: "clipboard",
    originalArtifactRef: `artifact://${"a".repeat(64)}`,
    preparedArtifactRef: `artifact://${"b".repeat(64)}`,
    originalMediaType: "image/png",
    mediaType: "image/png",
    originalByteLength: 20,
    byteLength: 20,
    originalWidth: 10,
    originalHeight: 10,
    width: 10,
    height: 10,
    downsampled: false,
    formatChanged: false,
    orientationApplied: false,
  };
  queue.enqueue("look [image #1 (10×10)]", [{ type: "text", text: "look " }, image]);
  const item = queue.dequeue();
  assert.equal(item.content[1].preparedArtifactRef, image.preparedArtifactRef);
});
