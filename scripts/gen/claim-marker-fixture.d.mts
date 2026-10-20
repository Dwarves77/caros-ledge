export interface ClaimMarkerCases {
  claims: { id: string; kind: string; text: string }[];
  paragraphs: { name: string; md: string; expected: string }[];
  separators: string[];
  expectedCounts: { marked: number; unmarked: number; already: number; skipped: number };
}
export function renderClaimMarkerFixture(cases: ClaimMarkerCases): { fixture: string; assertions: string };
