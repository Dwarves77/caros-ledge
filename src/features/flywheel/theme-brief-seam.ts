// Ported from old_repo/scripts/connections/generate-theme-brief.mjs (lines 33-101)
// Ported from old_repo/scripts/connections/generate-theme-brief.mjs (lines 129-155)
// The free theme-brief seam: a session authors a theme brief from a bundle, and this validates it against the theme's LIVE members and writes the
// theme_briefs row stamped generated_by "session-executor". A payload authored against stale membership is refused (INV-191): its member_hash must equal
// computeMemberHash(live member ids). No model is called here. The writer is injectable (the theme-briefs apply of the turn runtime owns the structured form).
import type { Db } from "@/core/db";
import { computeMemberHash } from "@/core/flywheel/themes";
import type { RunResult } from "@/core/sources/run-result";

export interface ThemeBriefPayload {
  theme_id: string;
  title: string;
  brief_md: string;
  member_hash: string;
}
export type Parsed = ({ ok: true } & ThemeBriefPayload) | { ok: false; error: string };
export interface ThemeBriefRow {
  theme_id: string;
  member_hash: string;
  member_count: number;
  title: string;
  brief_md: string;
  generated_at: string;
  generated_by: "session-executor";
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

function parseFrontmatterMd(text: string): Parsed | { ok: true; theme_id?: string; title?: string; member_hash?: string; brief_md: string } {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { ok: false, error: "Markdown payload must start with a '---' frontmatter block (theme_id / title / member_hash) followed by '---' and the brief body." };
  const fields: Record<string, string> = {};
  for (const line of (m[1] as string).split("\n")) {
    const kv = /^([a-zA-Z_]+):\s*(.+)$/.exec(line.trim());
    if (kv) fields[kv[1] as string] = (kv[2] as string).trim().replace(/^["']|["']$/g, "");
  }
  return { ok: true, ...(fields.theme_id ? { theme_id: fields.theme_id } : {}), ...(fields.title ? { title: fields.title } : {}), ...(fields.member_hash ? { member_hash: fields.member_hash } : {}), brief_md: (m[2] as string).trim() };
}

/** A session-authored payload (JSON object text or Markdown with a frontmatter block) to its four required fields. Malformed input is an error value, never a throw. */
export function parseThemeBriefPayload(format: "json" | "md", content: string): Parsed {
  let raw: Partial<Record<keyof ThemeBriefPayload, unknown>>;
  if (format === "json") {
    try {
      raw = JSON.parse(content) as typeof raw;
    } catch (e) {
      return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  } else {
    const fm = parseFrontmatterMd(content);
    if (!fm.ok) return fm;
    raw = fm as unknown as typeof raw;
  }
  const missing = (["theme_id", "title", "brief_md", "member_hash"] as const).filter((k) => !raw?.[k]);
  if (missing.length) return { ok: false, error: `payload is missing required field(s): ${missing.join(", ")}.` };
  return { ok: true, theme_id: String(raw.theme_id), title: String(raw.title), brief_md: String(raw.brief_md), member_hash: String(raw.member_hash) };
}

/** The row to write, or the refusal: the payload's hash must be the live membership's hash. The clock is injected. */
export function validateAgainstLiveMembers(payload: ThemeBriefPayload, liveMemberIds: readonly string[], now: Date): { ok: true; row: ThemeBriefRow } | { ok: false; error: string } {
  const liveHash = computeMemberHash(liveMemberIds);
  if (payload.member_hash !== liveHash) {
    return { ok: false, error: `member_hash mismatch: payload was authored against ${payload.member_hash}, but the theme's LIVE membership now hashes to ${liveHash}. Fetch the current bundle and re-author.` };
  }
  return { ok: true, row: { theme_id: payload.theme_id, member_hash: liveHash, member_count: liveMemberIds.length, title: payload.title, brief_md: payload.brief_md, generated_at: now.toISOString(), generated_by: "session-executor" } };
}

export interface SeamDeps {
  sb: Db;
  now: () => Date;
  writeRow?: (row: ThemeBriefRow) => Promise<{ error: string | null }>;
}
/** Validate and (unless dry) write one authored brief. The theme must still exist; a dissolved theme refuses. */
export async function applyThemeBrief(deps: SeamDeps, input: { format: "json" | "md"; content: string; dry: boolean }): Promise<RunResult> {
  const payload = parseThemeBriefPayload(input.format, input.content);
  if (!payload.ok) return { counts: { refused: 1 }, outcome: "failed", notes: [`payload invalid: ${payload.error}`] };
  const theme = await deps.sb.from("connection_themes").select("id, member_ids").eq("id", payload.theme_id).maybeSingle();
  if (theme.error) throw new Error(`theme read failed: ${theme.error.message}`);
  if (!theme.data) return { counts: { refused: 1 }, outcome: "failed", notes: [`theme ${payload.theme_id} does not exist in connection_themes (it may have dissolved since the bundle was fetched)`] };
  const v = validateAgainstLiveMembers(payload, (theme.data as { member_ids: string[] }).member_ids, deps.now());
  if (!v.ok) return { counts: { refused: 1 }, outcome: "failed", notes: [v.error] };
  if (input.dry) return { counts: { valid: 1, members: v.row.member_count }, outcome: "ok", notes: ["dry: payload valid, nothing written"] };
  const write = deps.writeRow ?? (async (row: ThemeBriefRow) => {
    const { error } = await deps.sb.from("theme_briefs").upsert(row, { onConflict: "theme_id" });
    return { error: error ? error.message : null };
  });
  const w = await write(v.row);
  return w.error ? { counts: { written: 0 }, outcome: "failed", notes: [`theme_briefs write failed: ${w.error}`] } : { counts: { written: 1, members: v.row.member_count }, outcome: "ok", notes: [] };
}
