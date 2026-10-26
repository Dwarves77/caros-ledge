// New in DOC-DATE-1 (scripts/ci/new-files/doc-date-1.txt): the producer that reads each stored capture's own date (core/fetch/document-date) and writes it to the capture row with its verbatim basis and the extractor's version. It reads stored text only (no fetch);
// a capture it finds no formal date in stays undated, and the velocity detector leaves that capture's claims out. A second run writes nothing. Called by the propagate stage through the producer registry; the connect stage's pattern step reads the dates it wrote.
import { fetchAllRows, type Db } from "@/core/db";
import { datedRows, extractDocumentDate, type Capture, type Dated } from "@/core/fetch/document-date";

import type { ParseOut, ProducerCtx, ProducerSpec } from "./runner";
import type { Rec } from "./upsert-plan";

/** The text one read page carries at most (a capture runs to 17 MB, and a page of such captures would time out the role's 8 s). */
const PAGE_CHARS = 8_000_000;
/** Every undated capture with text, read in pages of bounded size (the sizes first, then the text of each page of ids). */
async function readUndated(sb: Db, limit: number | undefined): Promise<{ read: number; caps: AsyncGenerator<Capture[]> }> {
  const sizes = await fetchAllRows<{ id: string; result_chars: number | null }>((from, to) => sb.from("agent_run_searches").select("id,result_chars").is("document_date", null).not("result_content", "is", null).order("id", { ascending: true }).range(from, to) as never, { cap: 1_000_000 });
  const wanted = limit ? sizes.slice(0, limit) : sizes;
  const pages: string[][] = [];
  let used = 0;
  for (const s of wanted) {
    if (!pages.length || used + (s.result_chars ?? PAGE_CHARS) > PAGE_CHARS) { pages.push([]); used = 0; }
    (pages.at(-1) as string[]).push(s.id);
    used += s.result_chars ?? PAGE_CHARS;
  }
  return { read: wanted.length, caps: (async function* () { for (const ids of pages) { const { data, error } = await sb.from("agent_run_searches").select("id,result_url,result_content").in("id", ids); if (error) throw new Error(`reading captures failed: ${error.message}`); yield (data ?? []) as Capture[]; } })() };
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
    const { read, caps } = await readUndated(ctx.sb, ctx.input.limit);
    const rows: Dated[] = [];
    const refused: string[] = [];
    for await (const page of caps) {
      const r = datedRows(page, extractDocumentDate);
      rows.push(...r.rows);
      refused.push(...r.refused);
    }
    return { text: JSON.stringify({ read, rows, refused }) };
  },
  parse(doc): ParseOut<Rec> {
    const { read, rows, refused } = JSON.parse(doc.text ?? "{}") as { read: number; rows: Dated[]; refused: string[] };
    const byKind = Object.fromEntries(["oj_header", "eli_metadata", "iso_line", "signature_line"].map((k) => [`dated_${k}`, rows.filter((r) => r.kind === k).length]));
    return { rows: rows as unknown as Rec[], warnings: refused.map((id) => `capture ${id}: the basis is not in its text; the date is refused`), counts: { read, undated: read - rows.length - refused.length, refused: refused.length, ...byKind } };
  },
  /** Only a capture still undated is written, and only the three columns. */
  async persist(ctx, rows) {
    let written = 0;
    for (const r of rows as unknown as Dated[]) {
      const { error } = await (ctx.sb as Db).from("agent_run_searches").update({ document_date: r.document_date, document_date_basis: r.document_date_basis, document_date_method: r.document_date_method }).eq("id", r.id).is("document_date", null);
      if (error) throw new Error(`writing the date of capture ${r.id} failed: ${error.message}`);
      written += 1;
    }
    return { written };
  },
};
