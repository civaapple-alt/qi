# Attention and presence

Continuity can feel alive without pretending the system has human emotions. Qi models attention and presence
as explicit, inspectable runtime state.

## Attention decision

A proactive candidate is currently checked against an explicit attention policy containing timezone, quiet hours,
and a maximum interruption count. A relevant memory or external event alone is not enough to interrupt.

`AttentionDecision` reports `allowed` plus a reason. An allowed `requestAttention()` appends a durable interruption
record and consumes budget; a denied request appends no interruption. Urgency, per-channel policy, preference
ranking, and a durable deferred queue are not implemented by `ContinuityController`.

## Presence

Presence reports operational availability and focus: active Session, waiting at a boundary, observing a watcher,
or unavailable. It must not claim feelings, consciousness, or fabricated off-screen activity.

## Separation of concerns

- Memory answers what prior claims may be relevant.
- Scheduler answers when a watcher produced a candidate trigger.
- Attention policy answers whether proactive delivery is appropriate.
- UI explains the decision and gives the user control.

See `tests/memory-continuity.test.mjs` and `tests/watcher-scheduler.test.mjs`.
