// The host-verdicts exporter (IMP-114): the hosts registerAndRate could not place (host_worklist, migration 0064), most-seen first, with the classes a verdict may name and the entry a session authors. The bundle goes to the kit's
// scratch directory like every other kind; the session fills the entries in, and the batch comes back through the kind's apply (apply.ts), whose write closes the host's worklist row in the same statement (the
// host_verdicts trigger of 0064). Called by exportBatch and, through drainExporters, by the judgement drain's plan; it reads one table and writes nothing.
import { isMissingObject, type Db } from "@/core/db";
import { HOST_CLASS_TIER } from "@/core/sources";

import type { BatchExport } from "../../kit/session-batch";

interface WorklistRow {
  host: string;
  reason: string;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  last_name: string | null;
}

export const hostVerdictsExporter = (sb: Db) => async (o: { limit: number; mode: string }): Promise<BatchExport> => {
  const { data, error } = await sb.from("host_worklist").select("host, reason, first_seen_at, last_seen_at, seen_count, last_name").order("seen_count", { ascending: false }).order("host", { ascending: true }).limit(o.limit);
  if (error) return { ok: false, items: [], error: isMissingObject(error) ? "host_worklist is absent (migration 0064 is not applied): there is no queue of unplaced hosts to export" : `host_worklist could not be read: ${error.message}` };
  const items = ((data ?? []) as WorklistRow[]).map((r) => ({ host: r.host, reason: r.reason, seen_count: r.seen_count, first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at, last_name: r.last_name }));
  return {
    ok: true,
    items,
    source: { type: "table", table: "host_worklist" },
    summary: {
      classes: Object.keys(HOST_CLASS_TIER).sort(),
      entry: { host: "<host from the item>", class: "<one of classes>", evidence: "<what the host is, with the page you read>", verdict_source: "session-lane", generated_at: "<ISO timestamp>" },
      batch: "host-verdicts-<name>, authored_by session-lane, at most 150 entries",
    },
  };
};
