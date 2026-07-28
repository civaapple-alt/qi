import type {
  HumanControlService,
  RunQuestionAnswer,
  RunQuestionInput,
} from "@civaapple/qi-agent/loop";
import type {
  ActionId,
  QuestionId,
  RunId,
  SessionId,
  StepId,
} from "@civaapple/qi-protocol";
import { ToolFailure, defineTool } from "@civaapple/qi-node/tools";
import { Type, type Static } from "@sinclair/typebox";

const QuestionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" }),
  header: Type.String({ minLength: 1, maxLength: 48 }),
  prompt: Type.String({ minLength: 1, maxLength: 1_000 }),
  selection: Type.Union([Type.Literal("single"), Type.Literal("multiple"), Type.Literal("text")]),
  options: Type.Optional(Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  }, { additionalProperties: false }), { maxItems: 8 })),
  allowText: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const AskQuestionInputSchema = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 3 }),
}, { additionalProperties: false });

type AskQuestionInput = Static<typeof AskQuestionInputSchema>;

interface PendingQuestion {
  sessionId: SessionId;
  refs: { runId: RunId; stepId: StepId; actionId: ActionId; questionSetId: QuestionId };
  resolve: (answers: RunQuestionAnswer[]) => void;
  reject: (error: Error) => void;
}

export class RunQuestionCoordinator {
  readonly #humanControl: HumanControlService;
  readonly #pending = new Map<QuestionId, PendingQuestion>();

  constructor(humanControl: HumanControlService) {
    this.#humanControl = humanControl;
  }

  wait(
    sessionId: SessionId,
    refs: { runId: RunId; stepId: StepId; actionId: ActionId },
    questions: readonly RunQuestionInput[],
    signal: AbortSignal,
  ): Promise<RunQuestionAnswer[]> {
    const asked = this.#humanControl.askRunQuestion(sessionId, refs, questions);
    const questionSetId = asked.questionSetId;
    return new Promise<RunQuestionAnswer[]>((resolve, reject) => {
      const pending: PendingQuestion = {
        sessionId,
        refs: { ...refs, questionSetId },
        resolve,
        reject,
      };
      this.#pending.set(questionSetId, pending);
      signal.addEventListener("abort", () => {
        if (!this.#pending.delete(questionSetId)) return;
        try {
          this.#humanControl.cancelRunQuestion(sessionId, pending.refs, "Run cancelled while awaiting user input");
        } catch {
          // Recovery may already have settled the durable Question.
        }
        reject(signal.reason instanceof Error ? signal.reason : new Error("Question cancelled"));
      }, { once: true });
    });
  }

  answer(questionSetId: QuestionId, answers: readonly RunQuestionAnswer[]): void {
    const pending = this.#pending.get(questionSetId);
    if (!pending) throw new Error(`Question set ${questionSetId} is not waiting in this process`);
    this.#humanControl.answerRunQuestion(pending.sessionId, pending.refs, answers);
    this.#pending.delete(questionSetId);
    pending.resolve(answers.map((answer) => ({ ...answer })));
  }

  cancel(questionSetId: QuestionId, reason: string): void {
    const pending = this.#pending.get(questionSetId);
    if (!pending) throw new Error(`Question set ${questionSetId} is not waiting in this process`);
    this.#humanControl.cancelRunQuestion(pending.sessionId, pending.refs, reason);
    this.#pending.delete(questionSetId);
    pending.reject(new Error(reason));
  }
}

export function createAskQuestionTool(
  coordinator: RunQuestionCoordinator,
): import("@civaapple/qi-node/tools").AnyToolDefinition {
  return defineTool({
    description:
      "Ask the user 1–3 blocking clarification questions during this Plan Run. Supports single choice, " +
      "multiple choice, free text, optional custom text, and explicit skipping. Execution resumes in this Run.",
    input: AskQuestionInputSchema,
    output: Type.Object({
      answers: Type.Array(Type.Object({
        questionId: Type.String(),
        selectedOptionIds: Type.Array(Type.String()),
        text: Type.Optional(Type.String()),
        skipped: Type.Boolean(),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }),
    }, { additionalProperties: false }),
    effect: () => "read",
    resources: () => ["run-question:user"],
    execute: async (input: AskQuestionInput, context) => {
      const questions: RunQuestionInput[] = input.questions.map((question) => {
        const options = question.options ?? [];
        if (question.selection === "text" && options.length > 0) {
          throw new ToolFailure("QUESTION_TEXT_OPTIONS", "Text questions cannot declare choices");
        }
        if (question.selection !== "text" && options.length === 0) {
          throw new ToolFailure("QUESTION_OPTIONS_REQUIRED", "Choice questions require options");
        }
        return {
          id: question.id,
          header: question.header,
          prompt: question.prompt,
          selection: question.selection,
          options,
          allowText: question.selection === "text" || question.allowText === true,
        };
      });
      const answers = await coordinator.wait(
        context.sessionId as SessionId,
        {
          runId: context.runId as RunId,
          stepId: context.stepId as StepId,
          actionId: context.actionId as ActionId,
        },
        questions,
        context.signal ?? new AbortController().signal,
      );
      return {
        answers: answers.map((answer) => ({
          questionId: answer.questionId,
          selectedOptionIds: [...(answer.selectedOptionIds ?? [])],
          ...(answer.text === undefined ? {} : { text: answer.text }),
          skipped: answer.skipped,
        })),
      };
    },
  });
}
