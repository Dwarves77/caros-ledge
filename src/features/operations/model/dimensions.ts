// Ported from old_repo/src/lib/agent/formats/operations-matrix.ts (lines 5-33)
// Ported from old_repo/src/components/operations/OperationsLedger.tsx (lines 77-123)
// The seven Operations dimensions, once: the database key (migration 378's CHECK), the display name and the D number. The matrix rows, the rail facet, the coverage counts and the statements all read this
// list, so a dimension added here reaches every one of them. Grid carbon intensity is the seventh: a system need the artboard draws no row for (DESIGN CHANGES OWED, artboard 08).
const OPERATIONS_DIMENSIONS = [
  { db: "regulatory_feasibility", name: "Regulatory feasibility" },
  { db: "regional_resources", name: "Regional resource availability" },
  { db: "labor_markets", name: "Labor markets" },
  { db: "materials_sourcing", name: "Materials sourcing" },
  { db: "infrastructure", name: "Infrastructure capacity" },
  { db: "operational_cost", name: "Operational cost" },
  { db: "grid_intensity", name: "Grid carbon intensity" },
] as const;

export type OperationsDimension = (typeof OPERATIONS_DIMENSIONS)[number]["db"];
export interface Dimension {
  db: OperationsDimension;
  name: string;
  /** D1 to D7: the rail and the matrix prefix every dimension with it, from the list's order, never from a filtered subset. */
  num: number;
}
export const DIMENSIONS: readonly Dimension[] = OPERATIONS_DIMENSIONS.map((d, i) => ({ ...d, num: i + 1 }));
const ALL_OPERATIONS_DIMENSIONS: readonly OperationsDimension[] = DIMENSIONS.map((d) => d.db);
/** The dimension whose cell opens the fully-loaded labour chain. */
export const LABOUR_DIMENSION: OperationsDimension = "labor_markets";

export const dimensionLabel = (d: Pick<Dimension, "name" | "num">): string => `D${d.num} ${d.name}`;
export const dimensionByDb = (db: string): Dimension | undefined => DIMENSIONS.find((d) => d.db === db);

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** The masthead states how many dimensions a region has, from the list itself: it moves with the list. */
export const DIMENSION_COUNT_WORD: string = NUMBER_WORDS[DIMENSIONS.length] ?? String(DIMENSIONS.length);
