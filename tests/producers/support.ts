// Shared fixtures for the producer tests: a fetch stub keyed by URL, the producer deps over a memory database, and a hand-built xlsx.
import { deflateRawSync } from "node:zlib";

import type { ProducerDeps } from "@/core/producers/deps";

import { memoryDb } from "../_support/memory-db.ts";

export const NOW = new Date("2026-10-15T12:00:00.000Z");
export interface Call { url: string; init?: { headers?: Record<string, string>; method?: string; body?: string } }

/** A fetch that answers from a url-prefix table; an unlisted URL answers 404 and every call is recorded. */
export function stubFetch(routes: Record<string, string | Buffer | (() => Response)>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: Call["init"]): Promise<Response> => {
    calls.push({ url, ...(init ? { init } : {}) });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const v = routes[key];
    if (typeof v === "function") return v();
    return new Response(v as never, { status: 200, headers: { "content-type": "text/plain" } });
  };
  return { fetch, calls };
}

export function makeDeps(opts: { tables?: Record<string, Record<string, unknown>[]>; env?: Record<string, string>; noDb?: boolean; routes?: Record<string, string | Buffer | (() => Response)>; db?: ReturnType<typeof memoryDb> } = {}) {
  const mem = opts.db ?? memoryDb(opts.tables ?? {});
  const f = stubFetch(opts.routes ?? {});
  const runs: Array<{ family: string; outcome: string; counts: Record<string, number>; notes: string[] }> = [];
  const deps: ProducerDeps = {
    sb: opts.noDb ? null : mem.db,
    fetch: f.fetch as never,
    recorder: { recordRun: async (e) => (runs.push(e), { error: null }), now: () => NOW },
    env: opts.env ?? {},
    sleep: async () => {},
  };
  return { deps, mem, runs, calls: f.calls };
}

const crc = (b: Buffer): number => { let c, n, t = 0xffffffff; for (n = 0; n < b.length; n++) { c = (t ^ (b[n] as number)) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t = (t >>> 8) ^ c; } return (t ^ 0xffffffff) >>> 0; };
/** A minimal valid zip (deflate entries) so the xlsx reader is exercised on real bytes. */
export function zip(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, "utf8");
    const comp = deflateRawSync(data);
    const nameB = Buffer.from(name);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(8, 8); lfh.writeUInt32LE(crc(data), 14); lfh.writeUInt32LE(comp.length, 18); lfh.writeUInt32LE(data.length, 22); lfh.writeUInt16LE(nameB.length, 26);
    parts.push(lfh, nameB, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc(data), 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameB.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(entries).length, 8); eocd.writeUInt16LE(Object.keys(entries).length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

/** A workbook with one named sheet; `rows` is an array of arrays (strings are shared strings, numbers are numeric cells, null is empty). */
export function xlsx(sheetName: string, rows: Array<Array<string | number | null>>): Buffer {
  const shared: string[] = [];
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => v === null ? "" : typeof v === "number" ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${(shared.includes(v) ? shared.indexOf(v) : shared.push(v) - 1)}</v></c>`).join("")}</row>`).join("");
  return zip({
    "xl/workbook.xml": `<workbook><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
  });
}
