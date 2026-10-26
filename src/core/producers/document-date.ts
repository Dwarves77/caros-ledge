// New in DOC-DATE-1 (scripts/ci/new-files/doc-date-1.txt): the producer that reads each stored capture's own date (core/fetch/document-date) and writes it to the capture row with its verbatim basis and the extractor's version. It reads stored text only (no fetch);
// a capture it finds no formal date in stays undated, and the velocity detector leaves that capture's claims out. A second run writes nothing. Called by the propagate stage through the producer registry; the connect stage's pattern step reads the dates it wrote.
// DOC-DATE-2: a capture dated by a retired method version is read again on its own stored text; a stored basis the current method re-produces is re-stamped with it, any other is set back to NULL (all three columns together).
import { fetchAllRows, type Db } from "@/core/db";
import { DOC_DATE_METHOD, datedRows, extractDocumentDate, reconcileStale, type Capture, type Change, type StoredCapture } from "@/core/fetch/document-date";

import type { ParseOut, ProducerCtx, ProducerSpec } from "./runner";
import type { Rec } from "./upsert-plan";

/** The text one read page carries at most (a capture runs to 17 MB, and a page of such captures would time out the role's 8 s). */
const PAGE_CHARS = 8_000_000;
const COLUMNS = "id,result_url,result_content,document_date,document_date_basis,document_date_method";
type Sized = { id: string; result_chars: number | null };
/** The captures one read covers, in pages of bounded size (the sizes first, then the text of each page of ids). `stale` selects the dated captures a retired method version dated; otherwise the undated captures with text. */
async function readCaptures(sb: Db, limit: number | undefined, stale: boolean): Promise<{ read: number; caps: AsyncGenerator<StoredCapture[]> }> {
  const sizes = await fetchAllRows<Sized>((from, to) => {
    if (stale) return sb.from("agent_run_searches").select("id,result_chars").not("document_date", "is", null).neq("document_date_method", DOC_DATE_METHOD).order("id", { ascending: true }).range(from, to) as never;
    return sb.from("agent_run_searches").select("id,result_chars").is("document_date", null).not("result_content", "is", null).order("id", { ascending: true }).range(from, to) as never;
  }, { cap: 1_000_000 });
  const wanted = limit ? sizes.slice(0, limit) : sizes;
  const pages: string[][] = [];
  let used = 0;
  for (const s of wanted) {
    if (!pages.length || used + (s.result_chars ?? PAGE_CHARS) > PAGE_CHARS) { pages.push([]); used = 0; }
    (pages.at(-1) as string[]).push(s.id);
    used += s.result_chars ?? PAGE_CHARS;
  }
  return { read: wanted.length, caps: (async function* () { for (const ids of pages) { const { data, error } = await sb.from("agent_run_searches").select(COLUMNS).in("id", ids); if (error) throw new Error(`reading captures failed: ${error.message}`); yield (data ?? []) as StoredCapture[]; } })() };
}

export const documentDate: ProducerSpec<Rec> = {
  name: "document-date",
  table: "agent_run_searches",
  licenceKey: null,
  enabled: true,
  enabledRuling: "operator and scope reviewer 2026-10-26 under ADR-053 section 2 (DOC-DATE-1): a document's own date is a formal code, read from the stored capture; nothing is fetched",
  killSwitchEnv: "DOCUMENT_DATE_PRODUCER_ENABLED",
  fetches: false,
  gap: "no stored capture to read",
  async fetchDoc(ctx: ProducerCtx) {
    if (!ctx.sb) throw new Error("no database client: the stored captures cannot be read");
    const fresh = await readCaptures(ctx.sb, ctx.input.limit, false);
    const stale = await readCaptures(ctx.sb, ctx.input.limit, true);
    const rows: Change[] = [];
    const refused: string[] = [];
    for await (const page of fresh.caps) {
      const r = datedRows(page as Capture[], extractDocumentDate);
      rows.push(...r.rows.map((d): Change => ({ ...d, op: "date" })));
      refused.push(...r.refused);
    }
    for await (const page of stale.caps) rows.push(...reconcileStale(page, extractDocumentDate));
    return { text: JSON.stringify({ read: fresh.read, stale: stale.read, rows, refused }) };
  },
  parse(doc): ParseOut<Rec> {
    const { read, stale, rows, refused } = JSON.parse(doc.text ?? "{}") as { read: number; stale: number; rows: Change[]; refused: string[] };
    const dated = rows.filter((r) => r.op === "date");
    const byKind = Object.fromEntries(["oj_header", "eli_metadata"].map((k) => [`dated_${k}`, dated.filter((r) => r.kind === k).length]));
    return { rows: rows as unknown as Rec[], warnings: refused.map((id) => `capture ${id}: the basis is not in its text; the date is refused`), counts: { read, stale, undated: read - dated.length - refused.length, refused: refused.length, reverted: rows.filter((r) => r.op === "revert").length, restamped: rows.filter((r) => r.op === "restamp").length, ...byKind } };
  },
  /** A new date is written to a capture still undated; a re-stamp or a revert to a capture still dated by an older method; always the three columns together and nothing else. */
  async persist(ctx, rows) {
    let written = 0;
    for (const r of rows as unknown as Change[]) {
      const set = { document_date: r.document_date, document_date_basis: r.document_date_basis, document_date_method: r.document_date_method };
      const q = (ctx.sb as Db).from("agent_run_searches").update(set).eq("id", r.id);
      const { error } = await (r.op === "date" ? q.is("document_date", null) : q.not("document_date", "is", null).neq("document_date_method", DOC_DATE_METHOD));
      if (error) throw new Error(`writing the date of capture ${r.id} failed: ${error.message}`);
      written += 1;
    }
    return { written };
  },
};
