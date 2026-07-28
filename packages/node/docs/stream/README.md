# `@civaapple/qi-node/stream`

Ordered catch-up and live delivery of committed Session events.

## Purpose

This package bridges durable event history to live subscribers and HTTP Server-Sent Events without turning
transport buffers into truth.

## Non-goals

- It does not persist events or synthesize missing history.
- It does not project domain state.
- It does not silently drop events for a slow consumer.

## Core model

`EventStreamService` first catches a subscriber up from `EventStore`, then follows committed events from
`SessionEventHub`. `encodeSseEvent()` preserves durable sequence, type, and payload.

## Behavioral invariants

- Catch-up plus live delivery contains no duplicates or gaps within the service contract.
- Subscriber backpressure fails explicitly when bounded capacity is exceeded.
- Only committed events are published as durable Session facts.
- Transport disconnection does not change Session state.

## Failure semantics

A slow or failed subscriber is closed explicitly. Reconnection resumes from durable history rather than
pretending an in-memory buffer is complete.

## Install and minimal use

```sh
npm install @civaapple/qi-node/stream
```

```ts
import { SessionEventHub } from "@civaapple/qi-node/stream";

const hub = new SessionEventHub(100);
// Publishing is for events that have already committed to an EventStore.
```

## Public API

`SessionEventHub`, `EventStreamService`, `EventSubscription`, and `encodeSseEvent()`.

## Change guide

Keep delivery ordering and resume behavior explicit. Any transport optimization must preserve the event payload
and sequence used by projections and user interfaces.

## Verification

`tests/event-stream.test.mjs` covers catch-up/live handoff, SSE fidelity, and slow subscribers.

## Further reading

- [Delivery guarantees](docs/delivery-guarantees.md)
- [Protocol event model](../protocol/docs/event-model.md)
