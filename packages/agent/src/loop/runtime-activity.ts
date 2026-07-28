import type { ActionId, RunId, SessionId, StepId } from "@civaapple/qi-protocol";

export type RuntimeActivity =
  | {
      readonly type: "model.text";
      readonly sessionId: SessionId;
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly text: string;
      readonly provisional: true;
    }
  | {
      readonly type: "action.output";
      readonly sessionId: SessionId;
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly actionId: ActionId;
      readonly stream: "stdout" | "stderr";
      readonly text: string;
      readonly truncated: boolean;
      readonly provisional: true;
    }
  | {
      readonly type: "task.output";
      readonly sessionId: string;
      readonly taskId: string;
      readonly stream: "stdout" | "stderr";
      readonly text: string;
      readonly truncated: boolean;
      readonly provisional: true;
    };
