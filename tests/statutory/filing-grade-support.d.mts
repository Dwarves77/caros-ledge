// The types of filing-grade-support.mjs, which the drift guard (filing-grade.test.ts) imports from TypeScript.
export declare const GENERATED_PATH: string;
export declare const CAPTURES_DIR: string;
export declare function headerOf(): string;
/** capture id to text. */
export declare function exportedCaptures(): Map<string, string>;
export declare function derivedFilingGrade(now: Date): { instruments: Record<string, unknown> };
export declare function committedFilingGrade(): { _generated: string; instruments: Record<string, { years: number[]; [field: string]: unknown }> };
