// Ported from old_repo/scripts/producers/oem/eea-hdv-csv.mjs (lines 14-117)
// Ported from old_repo/src/lib/csv/split.mjs (lines 1-43)
// The one CSV home: an incremental RFC 4180 reader (chunk-safe, byte-limited) and the whole-text splitter built on it.
class CsvFormatError extends Error {}

const UNQUOTED_STOP = /[,"\r\n]/g;

/** push(text) returns the records completed by that text; end() returns the final record. A quote opens a quoted field only at a field start. */
function makeParser(dropTail: () => boolean) {
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let quoteSeen = false;
  let pendingCR = false;
  let atStart = true;
  const endRecord = (out: string[][]) => {
    if (record.length === 0 && field === "") return;
    record.push(field);
    field = "";
    out.push(record);
    record = [];
  };
  return {
    push(text: string): string[][] {
      const out: string[][] = [];
      const n = text.length;
      let i = 0;
      if (n > 0 && atStart) {
        atStart = false;
        if (text.charCodeAt(0) === 0xfeff) i = 1;
      }
      while (i < n) {
        if (inQuotes) {
          if (quoteSeen) {
            if (text[i] === '"') {
              field += '"';
              quoteSeen = false;
              i += 1;
              continue;
            }
            inQuotes = false;
            quoteSeen = false;
          } else {
            const q = text.indexOf('"', i);
            if (q === -1) {
              field += text.slice(i);
              i = n;
              continue;
            }
            field += text.slice(i, q);
            quoteSeen = true;
            i = q + 1;
            continue;
          }
        }
        if (pendingCR) {
          pendingCR = false;
          if (text[i] === "\n") {
            i += 1;
            continue;
          }
        }
        const ch = text[i] as string;
        if (ch === ",") {
          record.push(field);
          field = "";
          i += 1;
        } else if (ch === "\n") {
          endRecord(out);
          i += 1;
        } else if (ch === "\r") {
          endRecord(out);
          pendingCR = true;
          i += 1;
        } else if (ch === '"' && field === "") {
          inQuotes = true;
          i += 1;
        } else {
          UNQUOTED_STOP.lastIndex = i;
          const m = UNQUOTED_STOP.exec(text);
          const j = m ? m.index : n;
          if (j === i) {
            field += ch;
            i += 1;
          } else {
            field += text.slice(i, j);
            i = j;
          }
        }
      }
      return out;
    },
    end(): string[][] {
      if (inQuotes && !quoteSeen) {
        if (dropTail()) return [];
        throw new CsvFormatError("unterminated quoted field at the end of the input");
      }
      if ((record.length === 0 && field === "") || dropTail()) return [];
      record.push(field);
      const last = record;
      record = [];
      field = "";
      return [last];
    },
  };
}

type Chunk = string | Uint8Array;
/**
 * Stream the records of a CSV body. A chunk boundary may fall anywhere (inside a quote, a CRLF or a multibyte character). `dropTail` (a boolean or a function
 * read at the end) omits a final record with no terminating newline, which a byte-limited read must do so a half record is never counted.
 */
export async function* readCsvStream(chunks: AsyncIterable<Chunk> | Iterable<Chunk>, { dropTail = false }: { dropTail?: boolean | (() => boolean) } = {}): AsyncGenerator<string[]> {
  const decoder = new TextDecoder("utf-8");
  const parser = makeParser(typeof dropTail === "function" ? dropTail : () => dropTail);
  for await (const chunk of chunks) {
    for (const r of parser.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }))) yield r;
  }
  const rest = decoder.decode();
  if (rest) for (const r of parser.push(rest)) yield r;
  for (const r of parser.end()) yield r;
}

/** Pass chunks through until `maxBytes` have been read; the chunk that crosses the limit is cut and `state.truncated` set. */
export async function* limitBytes(chunks: AsyncIterable<Chunk> | Iterable<Chunk>, maxBytes: number, state: { truncated: boolean }): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const c of chunks) {
    const buf = typeof c === "string" ? Buffer.from(c, "utf8") : c;
    if (total + buf.length > maxBytes) {
      yield buf.subarray(0, maxBytes - total);
      state.truncated = true;
      return;
    }
    total += buf.length;
    yield buf;
  }
}

/** A whole CSV text as a trimmed lower-case header row plus data rows; blank lines are skipped. A quoted field containing a newline stays one field. */
export function splitCsvText(raw: unknown): { header: string[]; rows: string[][] } {
  const parser = makeParser(() => false);
  const records = [...parser.push(String(raw ?? "")), ...parser.end()].filter((r) => !(r.length === 1 && r[0] === ""));
  const [head, ...rows] = records;
  return { header: (head ?? []).map((h) => h.trim().toLowerCase()), rows };
}
