import assert from "node:assert/strict";
import test from "node:test";
import {
  dependencyClosure,
  internalDependencyNames,
} from "../scripts/lib/package-consumer.mjs";

test("per-package consumer closure contains only declared transitive Qi dependencies", () => {
  const candidates = [
    { name: "@civaapple/qi-base", internalDependencies: [] },
    { name: "@civaapple/qi-tool", internalDependencies: ["@civaapple/qi-base"] },
    { name: "@civaapple/qi-agent", internalDependencies: ["@civaapple/qi-tool"] },
    { name: "@civaapple/qi-unrelated", internalDependencies: [] },
  ];
  assert.deepEqual(
    dependencyClosure("@civaapple/qi-agent", candidates),
    ["@civaapple/qi-agent", "@civaapple/qi-base", "@civaapple/qi-tool"],
  );
});

test("consumer closure rejects missing internal dependencies and reads every dependency section", () => {
  assert.deepEqual(
    internalDependencyNames({
      dependencies: { "@civaapple/qi-a": "1.0.0", external: "1.0.0" },
      optionalDependencies: { "@civaapple/qi-b": "1.0.0" },
      peerDependencies: { "@civaapple/qi-c": "1.0.0" },
    }),
    ["@civaapple/qi-a", "@civaapple/qi-b", "@civaapple/qi-c"],
  );
  assert.throws(
    () => dependencyClosure("@civaapple/qi-a", [
      { name: "@civaapple/qi-a", internalDependencies: ["@civaapple/qi-missing"] },
    ]),
    /declares missing internal dependency/u,
  );
});
