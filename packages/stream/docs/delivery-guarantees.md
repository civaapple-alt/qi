# Delivery guarantees

The stream service provides ordered durable catch-up followed by bounded live delivery. It is not an exactly-once
transport across arbitrary networks; durable sequence lets clients detect and resume delivery.

## Subscription handoff

1. Read committed history after the client's last durable sequence.
2. Subscribe to the live hub without allowing a handoff gap.
3. Suppress events already included during catch-up.
4. Continue in durable order until cancellation or explicit subscriber failure.

## Backpressure

Each subscriber is bounded. When it cannot keep pace, the service fails that subscription explicitly instead of
dropping an event and presenting a false contiguous history. The client reconnects from its last acknowledged
durable sequence.

## SSE representation

`encodeSseEvent()` includes durable sequence, event type, and the full event payload. UI-specific projections are
built downstream and never replace this replay cursor.

## Evidence

`tests/event-stream.test.mjs` covers handoff deduplication, SSE fidelity, and explicit slow-consumer failure.
