# Safe boundaries

A safe boundary is a point where no executor is running and every proposed Action has a durable settlement or an
explicit not-started outcome. Steering, parking, cancellation, and handoff apply at these boundaries.

## Why mid-action steering is unsafe

Changing direction while an external effect is running cannot prove whether the old instruction took effect.
Treating it as cancelled could duplicate a write on the next attempt. Qi therefore records steering in a
mailbox and applies it after settlement.

## Boundary cases

- Before model call: safe to incorporate queued direction.
- During provider stream: cancellation can stop generation; no Action proposal is released before terminality.
- After proposal, before Action start: safe to deny or cancel with an explicit event.
- After Action start: wait for known settlement or park as indeterminate.
- After Step completion: safe to apply steering, compact context, pause, or begin the next Step.

`tests/turn-loop.test.mjs` proves next-boundary steering and batch settlement. `tests/session-supervisor.test.mjs`
proves the crash distinction between granted-only and started Actions.
