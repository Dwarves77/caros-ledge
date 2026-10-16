// Barrel: the learning loop's import surface (new in P2-07).
export { buildEntityItemsReader, describeChange, EMITTING_TABLES, eventTypeForOutboxRow, MAX_ITEMS_PER_EVENT, readOutboxEvents, runQuestionsOnChange } from "./questions-on-change";
export type { ChangeDeps, ChangeEvent, ChangeResult } from "./questions-on-change";
export { buildLedgerRows, deadlineMs, isDeadlinePassed, matchEventsToSignposts, OUTCOME_BY_DIRECTION, outcomeForDirection, runSignpostStep, SCORED_BY, signpostMetrics } from "./signpost-scoring";
export type { OutboxEvent, SignpostStepDeps, SignpostStepResult } from "./signpost-scoring";
export { buildSignpostStepDeps, hydrateEventRows } from "./signpost-scoring-deps";
export { generateTriggerQuestions, isTriggerQuestionFlag, PRODUCT_QUESTIONS, QUESTION_ACQUISITION, questionFlagRow, surfacesForDomain, TRIGGER_EVENT_TYPES, triggerQuestionFlagRow, triggerQuestionsForItem, writeQuestions } from "./trigger-questions";
export type { QuestionDeps, QuestionItem, TriggerQuestion } from "./trigger-questions";
