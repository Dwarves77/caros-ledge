// Ported from old_repo/src/lib/entities/source-role.mjs (lines 1-34)
// A source URL's role (primary document, news or press, other) and the intake congruence rule: a primary-artifact type on a news source is a
// market signal (1a); a study-backed research finding on a press release keeps its type and seeks the study (1b). URL patterns are data.
import { z } from "zod";

import raw from "./data/source-role.json";

const cfg = z.object({ newsPattern: z.string(), primaryPattern: z.string(), primaryArtifactTypes: z.array(z.string()), studyBackedTypes: z.array(z.string()) }).parse(raw);
const NEWS_RE = new RegExp(cfg.newsPattern, "i");
const PRIMARY_URL_RE = new RegExp(cfg.primaryPattern, "i");
const PRIMARY_ARTIFACT_TYPES: ReadonlySet<string> = new Set(cfg.primaryArtifactTypes);
const STUDY_BACKED_TYPES: ReadonlySet<string> = new Set(cfg.studyBackedTypes);

export type Role = "primary" | "news" | "other";
export function sourceRole(url: unknown): Role {
  const s = String(url ?? "");
  return PRIMARY_URL_RE.test(s) ? "primary" : NEWS_RE.test(s) ? "news" : "other";
}

export function congruence(itemType: string, url: unknown): { itemType: string; changed: boolean; incongruentSource: boolean; reason?: string } {
  const role = sourceRole(url);
  if (PRIMARY_ARTIFACT_TYPES.has(String(itemType)) && role === "news") {
    return { itemType: "market_signal", changed: true, incongruentSource: false, reason: "1a: primary-artifact type on a news source, market_signal (news is the signal's correct primary)" };
  }
  if (STUDY_BACKED_TYPES.has(String(itemType)) && role === "news") {
    return { itemType, changed: false, incongruentSource: true, reason: "1b: research_finding on a press-release/news source, keep type, seek the study as primary (press release is a corroborator)" };
  }
  return { itemType, changed: false, incongruentSource: false };
}
