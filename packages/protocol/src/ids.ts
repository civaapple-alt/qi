import { randomUUID } from "node:crypto";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const suffixPattern = "[A-Za-z0-9][A-Za-z0-9_-]{2,127}";

function idSchema<const Prefix extends string>(prefix: Prefix) {
  return Type.String({ pattern: `^${prefix}_${suffixPattern}$` });
}

export const SessionIdSchema = idSchema("ses");
export const RunIdSchema = idSchema("run");
export const StepIdSchema = idSchema("stp");
export const ActionIdSchema = idSchema("act");
export const EventIdSchema = idSchema("evt");
export const EvaluationIdSchema = idSchema("evl");
export const LeaseIdSchema = idSchema("lea");
export const GoalIdSchema = idSchema("gol");
export const EvidenceIdSchema = idSchema("evi");
export const ReceiptIdSchema = idSchema("rcp");
export const MemoryIdSchema = idSchema("mem");
export const TaskIdSchema = idSchema("tsk");
export const PlanIdSchema = idSchema("pln");
export const PlanItemIdSchema = idSchema("pit");
export const QuestionIdSchema = idSchema("qst");
export const WorkPlanIdSchema = idSchema("wpl");
export const WorkItemIdSchema = idSchema("wit");

export type SessionId = Static<typeof SessionIdSchema>;
export type RunId = Static<typeof RunIdSchema>;
export type StepId = Static<typeof StepIdSchema>;
export type ActionId = Static<typeof ActionIdSchema>;
export type EventId = Static<typeof EventIdSchema>;
export type EvaluationId = Static<typeof EvaluationIdSchema>;
export type LeaseId = Static<typeof LeaseIdSchema>;
export type GoalId = Static<typeof GoalIdSchema>;
export type EvidenceId = Static<typeof EvidenceIdSchema>;
export type ReceiptId = Static<typeof ReceiptIdSchema>;
export type MemoryId = Static<typeof MemoryIdSchema>;
export type TaskId = Static<typeof TaskIdSchema>;
export type PlanId = Static<typeof PlanIdSchema>;
export type PlanItemId = Static<typeof PlanItemIdSchema>;
export type QuestionId = Static<typeof QuestionIdSchema>;
export type WorkPlanId = Static<typeof WorkPlanIdSchema>;
export type WorkItemId = Static<typeof WorkItemIdSchema>;

export type IdPrefix =
  | "ses"
  | "run"
  | "stp"
  | "act"
  | "evt"
  | "evl"
  | "lea"
  | "gol"
  | "evi"
  | "rcp"
  | "mem"
  | "tsk"
  | "pln"
  | "pit"
  | "qst"
  | "wpl"
  | "wit";

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}

export function assertSchema<T extends TSchema>(schema: T, value: unknown, label: string): Static<T> {
  if (Value.Check(schema, value)) {
    return value as Static<T>;
  }

  const details = [...Value.Errors(schema, value)]
    .slice(0, 5)
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
  throw new TypeError(`${label} is invalid: ${details}`);
}
