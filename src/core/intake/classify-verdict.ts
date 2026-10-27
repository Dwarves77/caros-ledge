// Ported from old_repo/src/lib/llm/first-fetch-classify.ts (lines 17-71)
// Ported from old_repo/src/lib/llm/first-fetch-classify.ts (lines 87-139)
// Ported from old_repo/src/lib/llm/first-fetch-classify.ts (lines 154-169)
// Ported from old_repo/src/lib/llm/first-fetch-classify.ts (lines 190-213)
// Ported from old_repo/src/lib/llm/first-fetch-classify.ts (lines 261-342)
// The free classifier. The metered call is gone: a SESSION authors the verdict (the verdict file the ledger-consume driver already
// reads), and this module is the deterministic half that survives: the instruction text and its content-hash version pin, the
// user-message builder, the error-body pre-gate, the verdict validator, and the verdict-file reader. The verdict carries
// surface_tags (ruling 4: no model, no second classifier).
import { createHash } from "node:crypto";

import { z } from "zod";

import { asDomain, domainForItemType, type Domain, type SourceCategory } from "@/core/shared/domains";

import instruction from "./data/classify-instruction.json";

const instructionText = z.object({ text: z.string().min(100) }).parse(instruction).text;
/** The author's instruction for a classify verdict (byte-identical to the one existing verdict files were written under). */
export const CLASSIFY_INSTRUCTION: string = instructionText;
/** A content hash of the instruction: every verdict entry pins the version it was produced under, so drift is a detectable mismatch. */
export const CLASSIFY_PROMPT_VERSION = `sha256:${createHash("sha256").update(instructionText, "utf8").digest("hex").slice(0, 16)}`;
/** The excerpt cap: the text a session reads is byte-identical to what the validator was given. */
export const CONTENT_MAX_CHARS = 6_000;

const SURFACES = ["regulations", "operations", "market_intel", "research"] as const;
const ENTITY_VERDICTS = ["specific_document", "portal", "uncertain"] as const;
export type EntityVerdict = (typeof ENTITY_VERDICTS)[number];

export interface ClassifyInput { source_id: string; source_url: string; source_name?: string | null; source_tier?: number | null; source_category?: SourceCategory; text: string }
export interface ClassifyVerdict {
  entity_verdict: EntityVerdict;
  item_type: string | null;
  domain: Domain | null;
  surface_tags: string[];
  relevance: number | null;
  severity: string;
  priority: string;
  urgency_tier: string;
  topic_tags: string[];
  jurisdictions: string[];
  title_candidate: string;
  summary: string;
  rationale: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).filter((t): t is string => typeof t === "string") : []);

/**
 * Validate an authored verdict against the input. The error-body pre-gate runs FIRST and deterministically (a bot-block body is
 * never a document, whatever the author inferred from the URL). An omitted or unrecognised verdict, or specific_document with no
 * item_type, is an honest `uncertain`, never a default positive. Domain is validated 1-7 with the routing function as the net,
 * never coerced to 1. surface_tags are validated against the four surfaces and are empty unless the document is specific.
 */
export function validateClassifyVerdict(input: ClassifyInput, raw: unknown, opts: { isErrorBody: (text: string) => boolean }): { ok: true; result: ClassifyVerdict } | { ok: false; error: string } {
  const fallbackTitle = input.source_name || input.source_url;
  if (opts.isErrorBody(input.text)) {
    return { ok: true, result: { entity_verdict: "uncertain", item_type: null, domain: null, surface_tags: [], relevance: null, severity: "monitoring", priority: "LOW", urgency_tier: "informational", topic_tags: [], jurisdictions: [], title_candidate: fallbackTitle, summary: "", rationale: "entity-gate: error / bot-block response body detected: not content; not minted" } };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "verdict must be a JSON object" };
  const p = raw as Record<string, unknown>;
  const itemTypeRaw = typeof p.item_type === "string" && p.item_type.trim() ? p.item_type.trim() : null;
  const entity: EntityVerdict = p.entity_verdict === "portal" ? "portal" : p.entity_verdict === "specific_document" && itemTypeRaw ? "specific_document" : "uncertain";
  const itemType = entity === "specific_document" ? itemTypeRaw : null;
  const domain: Domain | null = asDomain(p.domain) ?? (itemType ? domainForItemType(itemType, input.source_category ?? null) : null);
  const surfaces = entity === "specific_document" ? [...new Set(strings(p.surface_tags).filter((t) => (SURFACES as readonly string[]).includes(t)))] : [];
  const relevance = typeof p.relevance === "number" && Number.isFinite(p.relevance) ? Math.max(0, Math.min(100, Math.round(p.relevance))) : null;
  const str = (k: string, d: string) => (typeof p[k] === "string" ? (p[k] as string) : d);
  return {
    ok: true,
    result: {
      entity_verdict: entity, item_type: itemType, domain, surface_tags: surfaces, relevance,
      severity: str("severity", "MONITORING"), priority: str("priority", "MODERATE"), urgency_tier: str("urgency_tier", "stable"),
      topic_tags: strings(p.topic_tags), jurisdictions: strings(p.jurisdictions),
      title_candidate: typeof p.title_candidate === "string" && p.title_candidate.trim() ? p.title_candidate.trim().slice(0, 200) : fallbackTitle,
      summary: typeof p.summary === "string" ? p.summary.trim().slice(0, 1000) : "",
      rationale: typeof p.rationale === "string" ? p.rationale.slice(0, 400) : "",
    },
  };
}

// ---- the verdict file --------------------------------------------------------------------------------------------
const PROMPT_VERSION_RE = /^sha256:[0-9a-f]{16}$/;
const entry = z
  .object({
    candidate_id: z.string().min(1),
    url: z.string().min(1),
    entity_verdict: z.enum(ENTITY_VERDICTS),
    item_type: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
    classified_by: z.literal("session-haiku"),
    classified_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date-time"),
    prompt_version: z.string().regex(PROMPT_VERSION_RE),
    domain: z.number().int().min(1).max(7).nullable().optional(),
    severity: z.string().nullable().optional(),
    priority: z.string().nullable().optional(),
    urgency_tier: z.string().nullable().optional(),
    topic_tags: z.array(z.string()).optional(),
    jurisdictions: z.array(z.string()).optional(),
    surface_tags: z.array(z.enum(SURFACES)).optional(),
    relevance: z.number().int().min(0).max(100).nullable().optional(),
    title_candidate: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.entity_verdict === "specific_document") {
      for (const k of ["domain", "severity", "priority", "urgency_tier", "title_candidate"] as const) if (e[k] === undefined || e[k] === null) ctx.addIssue({ code: "custom", message: `${k} is required for a specific_document verdict` });
      if (!e.item_type) ctx.addIssue({ code: "custom", message: "item_type is required for a specific_document verdict" });
    } else if (e.item_type !== null) ctx.addIssue({ code: "custom", message: "item_type must be null unless entity_verdict is specific_document" });
  });
const file = z.object({ batch: z.string().min(1), generated_at: z.string(), prompt_version: z.string().regex(PROMPT_VERSION_RE), classified_by: z.literal("session-haiku"), entries: z.array(z.unknown()) });
export type VerdictEntry = z.infer<typeof entry>;

/**
 * Read a verdict file (parsed JSON). A STRUCTURAL violation (a missing or malformed field) fails the whole file; an entry produced
 * under another instruction version is excluded per entry and COUNTED (a stale prompt is never silently accepted, and never a
 * reason to discard a valid batch). One verdict per URL: the newest classified_at wins.
 */
export function readVerdictFile(parsed: unknown, opts: { promptVersion?: string } = {}): { ok: true; batch: string; byUrl: Map<string, VerdictEntry>; stale: number; superseded: number } | { ok: false; errors: string[] } {
  const head = file.safeParse(parsed);
  if (!head.success) return { ok: false, errors: head.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`) };
  const want = opts.promptVersion ?? CLASSIFY_PROMPT_VERSION;
  const errors: string[] = [];
  const byUrl = new Map<string, VerdictEntry>();
  let stale = 0;
  let superseded = 0;
  head.data.entries.forEach((raw, i) => {
    const e = entry.safeParse(raw);
    if (!e.success) return void errors.push(...e.error.issues.map((x) => `entries[${i}].${x.path.join(".")}: ${x.message}`));
    if (e.data.prompt_version !== want) return void (stale += 1);
    const old = byUrl.get(e.data.url);
    if (old) {
      superseded += 1;
      if (Date.parse(old.classified_at) > Date.parse(e.data.classified_at)) return;
    }
    byUrl.set(e.data.url, e.data);
  });
  return errors.length ? { ok: false, errors } : { ok: true, batch: head.data.batch, byUrl, stale, superseded };
}
