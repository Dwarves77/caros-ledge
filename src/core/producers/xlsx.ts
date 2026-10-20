// Ported from old_repo/scripts/gen/fetch-desnz-factors.mjs (lines 24-208)
// Ported from old_repo/src/lib/market/oil-bulletin-workbook.mjs (lines 14-120)
// One minimal xlsx reader for the producers that read a workbook (SBTi, the oil bulletin): stored and deflate zip entries, shared strings, sheet names, rows.
import { inflateRawSync } from "node:zlib";

import { StructureError } from "./runner";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

export interface Zip {
  names(): string[];
  has(name: string): boolean;
  read(name: string): Buffer;
}
/** Open a zip buffer (no zip64). `read` decompresses; a missing entry or an unsupported method is a StructureError naming it. */
function readZip(buf: Buffer): Zip {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new StructureError("not a valid zip/xlsx: End Of Central Directory record not found");
  const count = buf.readUInt16LE(eocd + 10);
  const entries = new Map<string, { method: number; size: number; offset: number }>();
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new StructureError(`zip central directory entry ${i} has a bad signature at offset ${p}`);
    const nameLen = buf.readUInt16LE(p + 28);
    entries.set(buf.toString("utf8", p + 46, p + 46 + nameLen), { method: buf.readUInt16LE(p + 10), size: buf.readUInt32LE(p + 20), offset: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) throw new StructureError(`xlsx has no zip entry "${name}" (entries: ${[...entries.keys()].join(", ")})`);
      if (buf.readUInt32LE(e.offset) !== LFH_SIG) throw new StructureError(`local file header for "${name}" has a bad signature`);
      const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
      const data = buf.subarray(start, start + e.size);
      if (e.method === 0) return data;
      if (e.method === 8) return inflateRawSync(data);
      throw new StructureError(`xlsx entry "${name}" uses zip compression method ${e.method}; only stored (0) and deflate (8) are supported`);
    },
  };
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1] as string] = decodeXml((m[2] ?? m[3]) as string);
  return out;
}

function parseSharedStrings(xml: string): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => [...(m[1] ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map((t) => decodeXml(t[1] ?? "")).join(""));
}

/** Sheet name to its package path. A sheet whose relationship is missing is a StructureError; an external target is refused. */
function parseSheetNames(workbookXml: string, relsXml: string): Record<string, string> {
  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const a = attrs(m[0]);
    if (a.Id && a.Target) rels.set(a.Id, a.Target);
  }
  const sheets: Record<string, string> = {};
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*\/>/g)) {
    const a = attrs(m[0]);
    const rid = a["r:id"];
    if (!a.name || !rid) continue;
    const target = rels.get(rid);
    if (!target) throw new StructureError(`workbook.xml: sheet "${a.name}" references r:id="${rid}" with no matching Relationship`);
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) throw new StructureError(`workbook.xml.rels: sheet "${a.name}" has an external target "${target}"`);
    sheets[a.name] = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  }
  if (!Object.keys(sheets).length) throw new StructureError("workbook.xml: no <sheet> entry resolved to a path");
  return sheets;
}

export interface Cell {
  raw: string | null;
  type: string;
}
export interface SheetRow {
  rowNum: number;
  cells: Map<string, Cell>;
}
/** Rows of a worksheet, cells keyed by column letter. A cell with no reference is skipped rather than positioned by guess. */
function parseSheetRows(sheetXml: string): SheetRow[] {
  if (!/<sheetData\b/.test(sheetXml)) throw new StructureError("worksheet XML has no <sheetData> element: not a recognisable sheet");
  const rows: SheetRow[] = [];
  for (const rm of sheetXml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNum = Number(attrs(`<row ${rm[1]}/>`).r);
    if (!Number.isFinite(rowNum)) continue;
    const cells = new Map<string, Cell>();
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(`<c ${cm[1]}/>`);
      const col = a.r?.match(/^[A-Z]+/)?.[0];
      if (!col) continue;
      const inner = cm[2] ?? "";
      const raw = a.t === "inlineStr" ? decodeXml(inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "") : (inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? null);
      cells.set(col, { raw: raw === null ? null : a.t === "s" ? raw : decodeXml(raw), type: a.t || "n" });
    }
    rows.push({ rowNum, cells });
  }
  return rows.sort((a, b) => a.rowNum - b.rowNum);
}

/** A cell's text: a shared string is resolved (out of range is a StructureError), anything else is its trimmed raw value. */
export function cellText(cell: Cell | undefined, shared: readonly string[]): string {
  if (!cell || cell.raw === null) return "";
  if (cell.type !== "s") return cell.raw.trim();
  const i = Number(cell.raw);
  if (!Number.isInteger(i) || i < 0 || i >= shared.length) throw new StructureError(`shared-string index ${cell.raw} is out of range (0..${shared.length - 1})`);
  return shared[i] as string;
}

/** The sheet's rows and shared strings from an xlsx buffer; a missing sheet names the sheets present. */
export function readSheet(buf: Buffer, sheetName: string): { rows: SheetRow[]; shared: string[] } {
  const zip = readZip(buf);
  const sheets = parseSheetNames(zip.read("xl/workbook.xml").toString("utf8"), zip.read("xl/_rels/workbook.xml.rels").toString("utf8"));
  const path = sheets[sheetName];
  if (!path) throw new StructureError(`workbook has no sheet named "${sheetName}" (sheets present: ${Object.keys(sheets).join(", ") || "none"})`);
  return { rows: parseSheetRows(zip.read(path).toString("utf8")), shared: parseSharedStrings(zip.has("xl/sharedStrings.xml") ? zip.read("xl/sharedStrings.xml").toString("utf8") : "") };
}
