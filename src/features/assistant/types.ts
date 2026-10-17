// Ported from old_repo/src/app/api/ask/route.ts (lines 109-141)
// The Assistant's answer as the route sends it and the panel draws it. No imports, so the client reads it too.
export interface AskHit {
  id: string;
  title: string;
  href: string;
  priority: string | null;
  jurisdiction: string;
  meta: string;
  /** The rating of the item's source (INV-213), or null when it has none. */
  tier: number | null;
  summary: string | null;
  /** The start of the item's brief with every suppressed claim removed. */
  excerpt: string | null;
  intersection: string | null;
  relatedCount: number;
  source: { name: string | null; url: string | null; citationCount: number | null; recency: string | null } | null;
}
/** An answer a session wrote to one of the item's standard questions, labelled as an inference with its status and confidence (ADR-044). */
export interface AskAnswer {
  itemId: string;
  itemTitle: string;
  question: string;
  text: string;
  statusToken: string;
  confidence: number | null;
  cited: { id: string; title: string; href: string }[];
  computedAt: string;
}
export interface AskResponse {
  question: string;
  hits: AskHit[];
  answers: AskAnswer[];
  passages: { id: string; heading: string; text: string }[];
  /** Operations facts the question and the hits name, as plain lines with their source. */
  operations: string[];
  disclaimer: string;
  /** The platform holds nothing matching the question. */
  empty: boolean;
}
export const ASK_DISCLAIMER =
  "This response surfaces relevant platform content for your research. It is not legal, regulatory, financial, or operational advice. Verify specifics against the cited platform items and consult appropriate professional counsel before taking action.";
