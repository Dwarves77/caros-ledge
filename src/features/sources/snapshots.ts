// Ported from old_repo/src/lib/sources/snapshot-store.mjs (lines 1-106)
// Ported from old_repo/src/lib/sources/freshness-probe.mjs (lines 1-56)
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import type { Db } from "@/core/db";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** SHA-256 hex of a string: the content_hash used for the storage key and the freshness comparison. */
const sha256Hex = (s: string): string => createHash("sha256").update(String(s), "utf8").digest("hex");


/** Download and gunzip a stored snapshot body by its storage key. */
export async function readSnapshotBody(db: Db, filePath: string): Promise<string> {
  const { data, error } = await db.storage.from("raw_fetches").download(filePath);
  if (error || !data) throw new Error(`snapshot body download failed (${filePath}): ${error?.message ?? "no data"}`);
  return (await gunzipAsync(Buffer.from(await data.arrayBuffer()))).toString("utf8");
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

export type Freshness = { status: "fresh" | "changed" | "unknown"; reason: string };

