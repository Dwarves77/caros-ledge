// Ported from old_repo/scripts/turns/needs-search/schema.mjs (lines 1-11)
// Ported from old_repo/scripts/turns/needs-search/schema.mjs (lines 54-151)
// Ported from old_repo/scripts/maintenance/host-verdicts/load-host-verdicts.mjs (lines 10-60)
// The need-URL validator. A batch names a SOURCE, never a tier (INV-209; CLAUDE.md rule 18): the tier comes from the host class table by the url's host alone, or from a host verdict for that exact host (a committed one, or
// one the entry carries in the host-verdict format). An aggregator or hosting platform is never registered, a verdict included: it republishes someone else's text, so the publisher's own page is cited. An entry that
// carries a `tier` is refused. A below-floor source is rated and registered (rule 18), never refused for being low.
import { hostOf } from "@/core/shared/url";
import { HOST_CLASS_TIER, isKnownHostClass, permanentlyUnregisteredClass, placeHostWithVerdicts, type HostVerdictRef } from "@/core/sources";

import { isObj, nonEmpty, type EntryResult } from "../../kit/session-batch";

import { parseAppliedNote, RESOLVED_BY, type FullFlag, type Need } from "./needs";

export const CEILINGS = { url: 2000, institution: 200, why_authoritative: 600, entries: 200 } as const;
const HOST_VERDICT_SOURCE = "session-lane";
/** A host the way the class table normalises it: no www, lower case, no trailing dot. */
export const normalizeVerdictHost = (host: unknown): string => String(host || "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

/** An accompanying host verdict names a CLASS from the table (never a tier number), with its evidence; the refusal reasons, empty when valid. */
export function validateHostVerdictEntry(entry: unknown): string[] {
  if (!isObj(entry)) return ["entry is not an object"];
  const errors: string[] = [];
  if (!nonEmpty(entry.host) || normalizeVerdictHost(entry.host) === "") errors.push("host is required");
  else if (/[/\s:]/.test(normalizeVerdictHost(entry.host))) errors.push("host must be a bare hostname");
  if (Object.hasOwn(entry, "tier")) errors.push("a verdict names a class, never a tier number");
  if (!isKnownHostClass(entry.class)) errors.push(`unknown class ${JSON.stringify(entry.class)}`);
  if (!nonEmpty(entry.evidence)) errors.push("evidence is required");
  if (entry.verdict_source !== HOST_VERDICT_SOURCE) errors.push(`verdict_source must be "${HOST_VERDICT_SOURCE}"`);
  if (!nonEmpty(entry.generated_at) || Number.isNaN(Date.parse(entry.generated_at))) errors.push("generated_at must be an ISO date-time");
  return errors;
}

export interface NeedsLive { needs: ReadonlyMap<string, Need>; flags: ReadonlyMap<string, FullFlag>; committed: ReadonlyMap<string, HostVerdictRef> | null }
export interface NeedPlan { need: Need; host: string; tier: number; via: string; verdicts: ReadonlyMap<string, HostVerdictRef>; tierClass: string | null }

/** Validate ONE entry: the refusal reasons with no plan, a plan with none, or `done` when the need was already served by this url. */
export function validateNeedEntry(entry: unknown, i: number, live: NeedsLive): EntryResult<NeedPlan> {
  const where = `entry ${i}`;
  if (!isObj(entry)) return { errors: [`${where}: not an object`] };
  if (!nonEmpty(entry.need_id)) return { errors: [`${where}: need_id is missing`] };
  const flag = live.flags.get(entry.need_id);
  if (flag && flag.status === "resolved" && flag.resolved_by === RESOLVED_BY && parseAppliedNote(flag.resolution_note)?.url === entry.url) return { errors: [], done: true };
  const tag = `${where} (need ${entry.need_id})`;
  const need = live.needs.get(entry.need_id);
  if (!need) return { errors: [`${tag}: unknown need (no open need flag with this id)`] };
  const errs: string[] = [];
  if (Object.hasOwn(entry, "tier")) errs.push(`${tag}: an entry names a source, never a tier; the tier is read from the class table`);
  let host = "";
  if (!nonEmpty(entry.url)) errs.push(`${tag}: url is missing`);
  else if (entry.url.length > CEILINGS.url) errs.push(`${tag}: url is ${entry.url.length} characters, ceiling ${CEILINGS.url}`);
  else {
    let u: URL | null = null;
    try {
      u = new URL(entry.url);
    } catch {
      errs.push(`${tag}: url is not a valid absolute url`);
    }
    if (u && u.protocol !== "http:" && u.protocol !== "https:") errs.push(`${tag}: url must be http or https`);
    else if (u && (u.username || u.password)) errs.push(`${tag}: url carries credentials`);
    else if (u) {
      host = hostOf(entry.url);
      if (!host) errs.push(`${tag}: url has no host`);
    }
  }
  if (!nonEmpty(entry.institution)) errs.push(`${tag}: institution is missing`);
  else if (entry.institution.length > CEILINGS.institution) errs.push(`${tag}: institution is ${entry.institution.length} characters, ceiling ${CEILINGS.institution}`);
  if (!nonEmpty(entry.why_authoritative)) errs.push(`${tag}: why_authoritative is missing`);
  else if (entry.why_authoritative.length > CEILINGS.why_authoritative) errs.push(`${tag}: why_authoritative is ${entry.why_authoritative.length} characters, ceiling ${CEILINGS.why_authoritative}`);
  if (typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) errs.push(`${tag}: confidence must be a number from 0 to 1 (got ${JSON.stringify(entry.confidence)})`);

  const verdicts = new Map(live.committed ?? []);
  const hv = entry.host_verdict;
  if (hv !== undefined && hv !== null) {
    const verr = validateHostVerdictEntry(hv);
    const h = isObj(hv) ? normalizeVerdictHost(hv.host) : "";
    if (verr.length) errs.push(`${tag}: host_verdict: ${verr.join("; ")}`);
    else if (host && h !== host) errs.push(`${tag}: host_verdict host ${JSON.stringify((hv as { host: unknown }).host)} is not the url's host ${JSON.stringify(host)}`);
    else verdicts.set(h, { class: String((hv as { class: unknown }).class), batch: "needs-search" });
  }
  if (!host || errs.length) return { errors: errs };
  if (permanentlyUnregisteredClass(host) != null) return { errors: [`${tag}: host ${host} is an aggregator or hosting platform; it republishes someone else's text and is never registered, a verdict included. Cite the publisher's own page`] };
  const placed = placeHostWithVerdicts(host, null, verdicts);
  if (placed.tier == null) return { errors: [`${tag}: the class table does not rate host ${host} and no host verdict places it; add "host_verdict" (host, class, evidence, verdict_source, generated_at) or cite a host the table rates`] };
  const via = placed.via === "verdict" ? (live.committed?.has(host) ? "committed_host_verdict" : "accompanying_host_verdict") : "class_table";
  return { errors: [], plan: { need, host, tier: placed.tier, via, verdicts, tierClass: Object.keys(HOST_CLASS_TIER).find((k) => HOST_CLASS_TIER[k] === placed.tier) ?? null } };
}
