export interface PlanDrainIo {
  now(): Date;
  makeDb(): unknown;
  buildExporters(sb: unknown): Promise<Record<string, (o: { limit: number; mode: string }) => Promise<unknown>>>;
  listBatchDir(kind: unknown): string[];
  planPath(runId: string, out: string | null): string;
  writePlan(path: string, text: string): void;
  readPlan(path: string): string;
  log(line: string): void;
}
export function runPlanDrain(argv: string[], io: PlanDrainIo): Promise<number>;
