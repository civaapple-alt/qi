# Portable model protocol

The portable protocol keeps the Agent runtime independent of provider-owned conversation state.

## Request boundary

A `ModelRequest` contains:

- an explicit model reference and capabilities;
- portable user, assistant, and completed tool-result history;
- currently offered tool schemas;
- bounded metadata needed for the current call.

Unsupported content fails schema or adapter validation before a provider request is made.

## Stream boundary

A model stream may emit content deltas, reasoning metadata, action proposals, usage, and one terminal event. An
Action becomes eligible for Loop processing only after the provider response reaches the valid terminal boundary.

This prevents partial streams from releasing effects the model may still revise or abandon.

## Portability rules

- Provider response IDs are optional adapter details, not required Session history.
- Completed tool calls are represented through portable assistant and tool-result messages.
- Provider-specific features must declare a capability and a deterministic unsupported path.
- Cancellation propagates through the port and cannot be reported as a normal completion.

`ScriptedModelPort` is the reference deterministic implementation for protocol tests.
