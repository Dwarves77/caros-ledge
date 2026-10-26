// New in DOC-DATE-1 (scripts/ci/new-files/doc-date-1.txt): the date a stored document states about itself, read from formal codes only (ADR-053 section 2): the Official Journal header and a date metadata property. DOC-DATE-2 retired the English word triggers (a dated header label, the signature line).
// Pure: no read, no clock. The accepted metadata property names are data (data/document-date.json); every date is parsed by the one date grammar (@/core/parse/date-grammar); the basis is the verbatim fragment the date came from. Anything else is null; no stored date is ever a fallback.
import { tryParseDateAt } from "@/core/parse/date-grammar";

import tokens from "./data/document-date.json";

export const DOC_DATE_METHOD = tokens.version;
export type DocDateKind = "oj_header" | "eli_metadata";
export interface DocumentDate {
  date: string;
  basis: string;
  kind: DocDateKind;
}

const pad = (n: string): string => n.padStart(2, "0");
// the OJ issue header: `OJ L, YYYY/NNNN, D.M.YYYY` (from 2023) or `OJ L NNN, D.M.YYYY` (before). A citation of another act is preceded by a bracket or gives a single start page (`, p. 1`); the header gives a page range, an ELI or none.
const OJ = /OJ L(?:,\s*(\d{4})\/(\d{1,5})|\s+\d{1,4}),?\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/g;
const CITES_START_PAGE = /^,\s*p\.\s/;
const ELI_ACT = /\/eli\/\w+\/(\d{4})\/(\d+)\//;

const dayAt = (text: string, pos: number) => {
  const hit = tryParseDateAt(text, pos);
  return hit && hit.precision === "day" && hit.skip === 0 ? hit : null;
};

function ojHeader(text: string, url: string): DocumentDate | null {
  const act = ELI_ACT.exec(url);
  for (const m of text.matchAll(OJ)) {
    const before = text.slice(0, m.index).trimEnd().slice(-1);
    if (before === "(" || before === ")" || CITES_START_PAGE.test(text.slice(m.index + m[0].length, m.index + m[0].length + 12))) continue;
    if (m[1] && act && `${m[1]}/${Number(m[2])}` !== `${act[1]}/${Number(act[2])}`) continue;
    const date = dayAt(`${m[5]}-${pad(m[4] as string)}-${pad(m[3] as string)}`, 0);
    if (date) return { date: date.iso, basis: m[0], kind: "oj_header" };
  }
  return null;
}

/** The first of the metadata property names followed, with nothing but non-digits between and within the gap, by an ISO day the date grammar parses. */
function metadataDate(text: string): Pick<DocumentDate, "date" | "basis"> | null {
  for (const t of tokens.metadata) {
    for (let i = text.indexOf(t); i >= 0; i = text.indexOf(t, i + t.length)) {
      const gap = text.slice(i + t.length, i + t.length + tokens.gapChars);
      const at = gap.search(/\d/);
      const date = at < 0 || /[<>]/.test(gap.slice(0, at)) ? null : dayAt(text, i + t.length + at);
      if (date && /^\d{4}-/.test(date.matchText)) return { date: date.iso, basis: text.slice(i, i + t.length + at + date.length) };
    }
  }
  return null;
}

/** The document's own date and the fragment it was read from, or null. Formal codes only: an English word ("Date:", "Done at") is the digest reader's, with a verbatim quote (ADR-053 section 2, DOC-DATE-2). */
export function extractDocumentDate(text: string, url: string): DocumentDate | null {
  const oj = ojHeader(text, url);
  if (oj) return oj;
  const meta = metadataDate(text);
  return meta ? { ...meta, kind: "eli_metadata" } : null;
}

export interface Capture { id: string; result_url: string | null; result_content: string | null }
export interface Dated { id: string; document_date: string; document_date_basis: string; document_date_method: string; kind: DocDateKind }

/** The dates the captures state about themselves. A date whose basis is not a substring of its capture's text is refused, whatever read it (INV-DD-1). */
export function datedRows(caps: readonly Capture[], read: (text: string, url: string) => DocumentDate | null): { rows: Dated[]; refused: string[] } {
  const rows: Dated[] = [];
  const refused: string[] = [];
  for (const c of caps) {
    const hit = c.result_content ? read(c.result_content, c.result_url ?? "") : null;
    if (!hit) continue;
    if (!(c.result_content as string).includes(hit.basis)) refused.push(c.id);
    else rows.push({ id: c.id, document_date: hit.date, document_date_basis: hit.basis, document_date_method: DOC_DATE_METHOD, kind: hit.kind });
  }
  return { rows, refused };
}

export interface StoredCapture extends Capture { document_date: string | null; document_date_basis: string | null; document_date_method: string | null }
/** One write of the producer: a date read now ("date"), a stored date the current method re-produces and re-stamps ("restamp"), or one it does not and sets back to NULL, all three columns together ("revert"). */
export interface Change { id: string; op: "date" | "restamp" | "revert"; document_date: string | null; document_date_basis: string | null; document_date_method: string | null; kind?: DocDateKind }

/** The captures a retired method dated: a stored basis the current method reads again, on the capture's own text, to the same date is re-stamped with the current method; any other (the retired word-list dates, or a capture with no text left) is reverted (DOC-DATE-2). */
export function reconcileStale(caps: readonly StoredCapture[], read: (text: string, url: string) => DocumentDate | null): Change[] {
  return caps.map((c): Change => {
    const hit = c.result_content ? read(c.result_content, c.result_url ?? "") : null;
    const same = hit !== null && hit.basis === c.document_date_basis && hit.date === c.document_date && (c.result_content as string).includes(hit.basis);
    return same ? { id: c.id, op: "restamp", document_date: hit.date, document_date_basis: hit.basis, document_date_method: DOC_DATE_METHOD, kind: hit.kind } : { id: c.id, op: "revert", document_date: null, document_date_basis: null, document_date_method: null };
  });
}
