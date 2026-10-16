// Ported from old_repo/src/lib/sources/snapshot-store.mjs (lines 1-106)
// Ported from old_repo/src/lib/sources/freshness-probe.mjs (lines 1-56)
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { contentFingerprint, isContentChange, normalizeForFingerprint } from "@/core/capture/change-detection";
import type { Db } from "@/core/db";
import { assertFetchAllowed, type HoldDeps } from "@/core/fetch/hold";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** SHA-256 hex of a string: the content_hash used for the storage key and the freshness comparison. */
export const sha256Hex = (s: string): string => createHash("sha256").update(String(s), "utf8").digest("hex");

export interface SnapshotRow {
  id?: string;
  content_hash?: string;
  file_path?: string;
  fetched_at?: string;
  created_at?: string;
  http_status?: number | null;
  html_bytes?: number;
}
/** The newest snapshot row by fetched_at, then created_at; null on empty. */
export function pickLatest(rows: SnapshotRow[] | null | undefined): SnapshotRow | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return [...rows].sort((a, b) => String(b.fetched_at ?? b.created_at ?? "").localeCompare(String(a.fetched_at ?? a.created_at ?? "")))[0] ?? null;
}

/** The latest snapshot metadata row for a source (no body download); null when none. A read error throws: no snapshot is never inferred from a failed read. */
export async function findSnapshotRow(db: Db, q: { sourceId: string }): Promise<SnapshotRow | null> {
  if (!q?.sourceId) return null;
  const { data, error } = await db.from("raw_fetches").select("id, content_hash, file_path, fetched_at, created_at, http_status, html_bytes").eq("source_id", q.sourceId).order("fetched_at", { ascending: false }).limit(1);
  if (error) throw new Error(`snapshot lookup failed: ${error.message}`);
  return pickLatest((data ?? []) as SnapshotRow[]);
}
/** Download and gunzip a stored snapshot body by its storage key. */
export async function readSnapshotBody(db: Db, filePath: string): Promise<string> {
  const { data, error } = await db.storage.from("raw_fetches").download(filePath);
  if (error || !data) throw new Error(`snapshot body download failed (${filePath}): ${error?.message ?? "no data"}`);
  return (await gunzipAsync(Buffer.from(await data.arrayBuffer()))).toString("utf8");
}
export type SnapshotLookup = { found: false } | { found: true; content: string; contentHash: string; fetchedAt: string; filePath: string; httpStatus: number | null };
/** Snapshot-first lookup: metadata plus body, or { found: false }. */
export async function getSnapshot(db: Db, q: { sourceId: string }): Promise<SnapshotLookup> {
  const row = await findSnapshotRow(db, q);
  if (!row?.file_path) return { found: false };
  return { found: true, content: await readSnapshotBody(db, row.file_path), contentHash: String(row.content_hash ?? ""), fetchedAt: String(row.fetched_at ?? row.created_at ?? ""), filePath: row.file_path, httpStatus: row.http_status ?? null };
}
/**
 * Write a snapshot on acquisition (I3): hash, gzip, upload to the `raw_fetches` bucket, upsert the metadata row (idempotent on source_id and content_hash). The capture
 * pass is the caller, so the change reader always has two captures to compare (B-0226). The day is the caller's: this function reads no clock.
 */
export async function writeSnapshot(db: Db, sourceId: string, fetchResult: { html: string; status?: number; isoDay: string }): Promise<{ contentHash: string; filePath: string; rawFetchId: string }> {
  if (!sourceId) throw new Error("writeSnapshot: sourceId required (an acquiring run must attribute its snapshot)");
  const html = String(fetchResult.html ?? "");
  const contentHash = sha256Hex(html);
  const filePath = `${sourceId}/${fetchResult.isoDay}/${contentHash}.html.gz`;
  const up = await db.storage.from("raw_fetches").upload(filePath, await gzipAsync(Buffer.from(html, "utf8")), { contentType: "application/gzip", upsert: true });
  if (up.error) throw new Error(`snapshot upload failed: ${up.error.message}`);
  const { data, error } = await db.from("raw_fetches").upsert({ source_id: sourceId, content_hash: contentHash, file_path: filePath, http_status: fetchResult.status ?? null, html_bytes: html.length }, { onConflict: "source_id,content_hash" }).select("id").single();
  if (error || !data) throw new Error(`raw_fetches upsert failed: ${error?.message ?? "no data"}`);
  return { contentHash, filePath, rawFetchId: (data as { id: string }).id };
}

export { contentFingerprint, isContentChange, normalizeForFingerprint };

export type Freshness = { status: "fresh" | "changed" | "unknown"; reason: string };
/** The pure freshness decision from the stored capture and a HEAD response. */
export function compareFreshness(stored: { fetchedAt?: string | null; storedEtag?: string | null } | null | undefined, head: { lastModified?: string | null; etag?: string | null; ok?: boolean } | null): Freshness {
  if (!head || head.ok === false) return { status: "unknown", reason: "HEAD unavailable or non-ok" };
  if (stored?.storedEtag && head.etag) return head.etag === stored.storedEtag ? { status: "fresh", reason: "etag matches stored" } : { status: "changed", reason: "etag differs from stored" };
  const lm = head.lastModified ? Date.parse(head.lastModified) : NaN;
  const cap = stored?.fetchedAt ? Date.parse(stored.fetchedAt) : NaN;
  if (Number.isNaN(lm)) return { status: "unknown", reason: "no parseable Last-Modified header" };
  if (Number.isNaN(cap)) return { status: "unknown", reason: "no parseable snapshot fetched_at" };
  return lm <= cap + 1000 ? { status: "fresh", reason: "Last-Modified at/before snapshot capture" } : { status: "changed", reason: "Last-Modified after snapshot capture" };
}
/**
 * HEAD-only freshness probe, behind the hold gate (it bypassed it before). Never downloads a body; any failure of the request itself is `unknown`,
 * so the caller continues on stored content. A refused hold is thrown, not folded into `unknown`.
 */
export async function probeFreshness(url: string, stored: { fetchedAt?: string | null; storedEtag?: string | null }, deps: HoldDeps & { caller?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<Freshness & { httpStatus: number | null }> {
  await assertFetchAllowed(url, deps.caller, deps);
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000) });
    return { ...compareFreshness(stored, { ok: res.ok, lastModified: res.headers.get("last-modified"), etag: res.headers.get("etag") }), httpStatus: res.status ?? null };
  } catch (e) {
    return { status: "unknown", reason: `HEAD failed: ${(e as Error).message || "error"}`, httpStatus: null };
  }
}
