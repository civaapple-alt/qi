import assert from "node:assert/strict";
import test from "node:test";
import { LineInputBatcher } from "@civaapple/qi-tui";

test("TUI coalesces one multi-line paste into one input and preserves blank lines", () => {
  const received = [];
  const batcher = new LineInputBatcher({
    delayMs: 10_000,
    onInput: (input) => received.push(input),
  });

  batcher.push(" npm start");
  batcher.push("");
  batcher.push("> openai-ts-example@1.0.0 start");
  batcher.push("> tsx src/index.ts");

  assert.deepEqual(received, []);
  assert.equal(
    batcher.flush(),
    " npm start\n\n> openai-ts-example@1.0.0 start\n> tsx src/index.ts",
  );
  assert.deepEqual(received, [
    " npm start\n\n> openai-ts-example@1.0.0 start\n> tsx src/index.ts",
  ]);
});

test("TUI submits an ordinary line after the paste window", async () => {
  const received = [];
  const batcher = new LineInputBatcher({
    delayMs: 5,
    onInput: (input) => received.push(input),
  });

  batcher.push("hello");
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(received, ["hello"]);
  assert.equal(batcher.flush(), undefined);
});

test("TUI can discard a pending batch during shutdown", async () => {
  const received = [];
  const batcher = new LineInputBatcher({
    delayMs: 5,
    onInput: (input) => received.push(input),
  });

  batcher.push("do not submit");
  batcher.cancel();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(received, []);
});
