// Barrel: the learning loop's import surface (new in P2-07).
export { buildEntityItemsReader, runQuestionsOnChange } from "./questions-on-change";
export type { ChangeDeps, ChangeEvent, ChangeResult } from "./questions-on-change";
export { deadlineMs, runSignpostStep } from "./signpost-scoring";
export type { OutboxEvent, SignpostStepDeps, SignpostStepResult } from "./signpost-scoring";
export { buildSignpostStepDeps } from "./signpost-scoring-deps";
export { generateTriggerQuestions, questionFlagRow, TRIGGER_EVENT_TYPES, triggerQuestionsForItem, writeQuestions } from "./trigger-questions";
export type { QuestionDeps, QuestionItem, TriggerQuestion } from "./trigger-questions";
