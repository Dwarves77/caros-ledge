// Ported from old_repo/scripts/maintenance/host-verdicts/load-host-verdicts.mjs (lines 10-60)
// Host verdicts (IMP-054): a session rules which CLASS of the institution class table a host the table does not place belongs to, with the evidence; the batch is validated whole (the entry format of a needs-search verdict:
// host, class, evidence, verdict_source, generated_at; a class, never a tier), and each ruling lands in host_verdicts (migration 0042), read back. The turn reads the table (loadHostVerdicts) into the map every rating takes.
// An aggregator or hosting platform is never registered, a verdict included. A verdict already stored with the same class is "already applied".
import { rowsByIds } from "@/core/db";
import { permanentlyUnregisteredClass } from "@/core/sources";

import { applyEntries, isObj, type ApplyOpts, type BatchDeps, type EntrySpec } from "../../kit/session-batch";
import { normalizeVerdictHost, validateHostVerdictEntry } from "../needs-search/validate";

type Stored = { host: string; class: string };

export const hostVerdictsSpec: EntrySpec<Map<string, string>, { host: string }> = {
  kind: "host-verdicts",
  batchRe: /^host-verdicts-[A-Za-z0-9._-]+$/,
  ceiling: 150,
  keyOf: (e) => (typeof e.host === "string" ? normalizeVerdictHost(e.host) : null),
  async load(deps, file) {
    const hosts = (file.entries as unknown[]).map((e) => (isObj(e) ? normalizeVerdictHost(e.host) : "")).filter(Boolean);
    return new Map((await rowsByIds<Stored>(deps.sb, "host_verdicts", "host, class", hosts, "host", "host")).map((r) => [r.host, r.class]));
  },
  entry(e, i, stored) {
    const errors = validateHostVerdictEntry(e).map((m) => `entry ${i}: ${m}`);
    if (errors.length || !isObj(e)) return { errors: errors.length ? errors : [`entry ${i}: not an object`] };
    const host = normalizeVerdictHost(e.host);
    if (permanentlyUnregisteredClass(host) != null) return { errors: [`entry ${i} (${host}): an aggregator or hosting platform is never registered, a verdict included`] };
    return stored.get(host) === e.class ? { errors: [], done: true } : { errors: [], plan: { host } };
  },
  async write(deps, _stored, item, batch) {
    const e = item.entry;
    const { error } = await deps.sb.from("host_verdicts").upsert({ host: item.plan.host, class: String(e.class), reason: String(e.evidence), batch_id: batch, ruled_by: String(e.verdict_source), ruled_at: deps.now().toISOString() }, { onConflict: "host" });
    if (error) throw new Error(error.message);
    return { ref: item.plan.host, counts: { verdicts_written: 1 } };
  },
  async readBack(deps, _stored, written) {
    const now = new Map((await rowsByIds<Stored>(deps.sb, "host_verdicts", "host, class", written.map((w) => w.ref), "host", "host")).map((r) => [r.host, r.class]));
    return written.filter((w) => now.get(w.ref) !== w.entry.class).map((w) => w.ref);
  },
};

export const applyHostVerdicts = (deps: BatchDeps, file: unknown, o: ApplyOpts) => applyEntries(hostVerdictsSpec, deps, file, o);
