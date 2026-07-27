export class StateTransitionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StateTransitionError";
    this.code = code;
  }
}

export class ConcurrencyError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(`Event stream version mismatch: expected ${expectedVersion}, actual ${actualVersion}`);
    this.name = "ConcurrencyError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}
