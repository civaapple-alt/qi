import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { InMemoryEventStore } from "@civaapple/qi-kernel";
import { parseSessionEvent } from "@civaapple/qi-protocol";
import { EventStreamService, SessionEventHub, encodeSseEvent } from "@civaapple/qi-stream";

const fixtureUrl = new URL("../fixtures/golden/authority-denied.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")).map(parseSessionEvent);

test("Event stream catches up from history and continues live without duplicates", async () => {
  const store = new InMemoryEventStore();
  store.append("ses_golden_001", 0, fixture.slice(0, 2));
  const hub = new SessionEventHub();
  const service = new EventStreamService(store, hub);
  const controller = new AbortController();
  const iterator = service.events("ses_golden_001", 1, controller.signal)[Symbol.asyncIterator]();

  const historical = await iterator.next();
  assert.equal(historical.value.sequence, 2);

  store.append("ses_golden_001", 2, [fixture[2]]);
  hub.publish(fixture[2]);
  const live = await iterator.next();
  assert.equal(live.value.sequence, 3);

  controller.abort();
  assert.equal((await iterator.next()).done, true);
});

test("SSE projection preserves durable sequence, event type and full payload", () => {
  const encoded = encodeSseEvent(fixture[0]);
  assert.match(encoded, /^id: 1\nevent: session\.created\ndata: /);
  assert.ok(encoded.endsWith("\n\n"));
  const dataLine = encoded.split("\n").find((line) => line.startsWith("data: "));
  assert.deepEqual(JSON.parse(dataLine.slice("data: ".length)), fixture[0]);
});

test("slow live subscribers fail explicitly instead of losing events silently", async () => {
  const hub = new SessionEventHub(1);
  const subscription = hub.subscribe("ses_golden_001");
  hub.publish(fixture[0]);
  hub.publish(fixture[1]);

  const iterator = subscription[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), /overflowed 1 queued events/);
});
