// Ported from old_repo/scripts/producers/operations/ukpn-capacity-heatmap-producer.mjs (lines 12-198)
// Ported from old_repo/scripts/producers/operations/ukpn-capacity-heatmap-producer.mjs (lines 213-242)
// UK Power Networks LTDS Capacity Heatmap into grid_connection_queues: per-substation demand headroom and constraint, queue months NULL with obs_status L (missing, never M)
// by ruling 2026-10-08. The catalogue licence and each release file's rights are checked before any row is mapped; the publisher is found by registry identity and must be
// active; the GB jurisdiction entity must already exist (never minted here).
import { makeEnvelope } from "@/core/contracts";
import { fetchAllRows, type Db } from "@/core/db";
import { entityId } from "@/core/entities";
import { registerCitedSource } from "@/core/producers/rows-file";
import { StructureError, type ParseOut, type ProducerCtx, type ProducerSpec } from "@/core/producers/runner";
import { KEYS, type Rec } from "@/core/producers/upsert-plan";
import { hostOf } from "@/core/shared";

export const DATASET_ID = "ukpn-capacity-heatmap";
export const PORTAL_HOST = "ukpowernetworks.opendatasoft.com";
export const METADATA_URL = `https://${PORTAL_HOST}/api/explore/v2.1/catalog/datasets/${DATASET_ID}`;
export const SOURCE_URL = `https://${PORTAL_HOST}/explore/dataset/${DATASET_ID}/`;
export const SOURCE_NAME = "UK Power Networks, Long Term Development Statement Capacity Heatmap";
export const LICENCE = "CC BY 4.0";
export const LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/";
export const GB_JURISDICTION_ID = entityId("jurisdiction", "GB");
export const CONSTRAINTS = ["GREEN", "AMBER", "RED"] as const;
const REFRESHABLE = ["substation_name", "demand_firm_mw", "demand_available_mw", "demand_constraint", "demand_constraint_limiting_factor", "source_id", "origin_class", "derivation"] as const;
const ATTACHMENT = /^LTDS_Heatmap_[A-Z]{3}_.*\.json$/i;

type Meta = { dataset_id?: string; metas?: { default?: { license?: string; publisher?: string } }; attachments?: Array<{ mimetype?: string; title?: string; url?: string }> };
/** Only https attachments on the portal host whose title is a heatmap release file. */
export const selectAttachments = (meta: Meta) => (Array.isArray(meta?.attachments) ? meta.attachments : []).filter((a) => a && a.mimetype === "application/json" && ATTACHMENT.test(String(a.title ?? "")) && hostOf(String(a.url ?? "")) === PORTAL_HOST && String(a.url).startsWith("https://"));
export function checkMetadata(meta: Meta) {
  const d = meta?.metas?.default;
  if (!d || typeof d !== "object") throw new StructureError("catalogue metadata has no metas.default");
  if (meta.dataset_id !== DATASET_ID) throw new StructureError(`metadata dataset_id is ${JSON.stringify(meta.dataset_id)}, expected ${DATASET_ID}`);
  if (d.license !== LICENCE) throw new StructureError(`dataset licence is ${JSON.stringify(d.license)}, expected ${LICENCE}: refusing to use the data`);
  const files = selectAttachments(meta);
  if (!files.length) throw new StructureError("no heatmap JSON attachment listed in the catalogue metadata");
  return { licence: d.license, publisher: d.publisher ?? null, files };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
export function mapHeatmapFile(file: Rec, o: { sourceId?: string | null } = {}) {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new StructureError("release file is not a JSON object");
  if (file.identifier !== DATASET_ID) throw new StructureError(`release file identifier is ${JSON.stringify(file.identifier)}, expected ${DATASET_ID}`);
  if (file.rights !== LICENCE_URL) throw new StructureError(`release file rights is ${JSON.stringify(file.rights)}, expected ${LICENCE_URL}: refusing`);
  if (!isText(file.publisher) || !isText(file.coverage)) throw new StructureError("release file states no publisher or coverage (licence area)");
  const issued = /^(\d{4}-\d{2}-\d{2})(T|$)/.exec(String(file.issued ?? ""));
  if (!issued) throw new StructureError(`release file issued date is ${JSON.stringify(file.issued)}, expected an ISO date (the clock is never read)`);
  if (!Array.isArray(file.Substations)) throw new StructureError("release file has no Substations array");
  const asOf = issued[1] as string;
  const dsoName = `${file.publisher.trim()}, ${file.coverage.trim()}`;
  const warnings: string[] = [];
  const rows: Rec[] = [];
  const envelopes = new Map<string, unknown>();
  const seen = new Set<string>();
  for (const s of file.Substations as Rec[]) {
    const ref = s?.mRID;
    const name = String(s?.name ?? "");
    if (!isText(ref) || !isText(s?.name)) { warnings.push(`substation without mRID and name skipped: ${JSON.stringify(ref ?? null)}`); continue; }
    if (seen.has(ref)) { warnings.push(`duplicate mRID ${ref} (${name}): first kept, later one ignored`); continue; }
    if (!isNum(s.demandFirmCapacity) || s.demandFirmCapacity < 0) { warnings.push(`${name} (${ref}): demandFirmCapacity ${JSON.stringify(s.demandFirmCapacity)} is not a non-negative number, skipped`); continue; }
    if (!isNum(s.demandAvailableCapacity)) { warnings.push(`${name} (${ref}): demandAvailableCapacity ${JSON.stringify(s.demandAvailableCapacity)} is not a number, skipped`); continue; }
    if (!(CONSTRAINTS as readonly unknown[]).includes(s.demandConstraint)) { warnings.push(`${name} (${ref}): demandConstraint ${JSON.stringify(s.demandConstraint)} is not one of ${CONSTRAINTS.join("/")}, skipped`); continue; }
    seen.add(ref);
    const env = (value: number) => makeEnvelope({ value, unit: "MW", derivation: "observed", origin_class: "official", obs_status: "A", as_of: { event_date: asOf, source_published_at: asOf }, expected_refresh: "biannual", provenance: { source: SOURCE_NAME, url: SOURCE_URL, licence: LICENCE, substation_ref: ref } });
    envelopes.set(`${ref}:demand_firm_mw`, env(s.demandFirmCapacity));
    envelopes.set(`${ref}:demand_available_mw`, env(s.demandAvailableCapacity));
    rows.push({ jurisdiction_id: GB_JURISDICTION_ID, dso_name: dsoName, capacity_band_mw: null, queue_months_p50: null, queue_months_p90: null, as_of: asOf, obs_status: "L", substation_ref: ref, substation_name: name.trim(), demand_firm_mw: s.demandFirmCapacity, demand_available_mw: s.demandAvailableCapacity, demand_constraint: s.demandConstraint, demand_constraint_limiting_factor: isText(s.demandConstraintLimitingFactor) ? s.demandConstraintLimitingFactor.trim() : null, source_id: o.sourceId ?? null, origin_class: "official", derivation: "observed", confidence_admiralty: null });
  }
  return { rows, warnings, envelopes, dso_name: dsoName, as_of: asOf };
}

export const ukpnHeatmap: ProducerSpec = {
  name: "ukpn-capacity-heatmap",
  table: "grid_connection_queues",
  licenceKey: null,
  enabled: false,
  enabledRuling: "operator 2026-10-04: no data population before every build layer is complete (ADR-023: flipping this is a reviewed code change)",
  killSwitchEnv: "OPERATIONS_PRODUCER_UKPN_HEATMAP_ENABLED",
  /** The document is `{ meta, files: [{ title, json }] }`: fetched from the portal catalogue, or injected as recorded input. */
  async fetchDoc(ctx: ProducerCtx) {
    const meta = (await (await ctx.get(METADATA_URL, { headers: { accept: "application/json" } })).json()) as Meta;
    const files: Array<{ title: string; json: unknown }> = [];
    for (const a of checkMetadata(meta).files) files.push({ title: a.title as string, json: await (await ctx.get(a.url as string, { headers: { accept: "application/json" } })).json() });
    return { text: JSON.stringify({ meta, files }) };
  },
  parse(doc): ParseOut<Rec> {
    const bundle = JSON.parse(doc.text ?? "") as { meta: Meta; files: Array<{ title: string; json: Rec }> };
    checkMetadata(bundle.meta);
    const rows: Rec[] = [];
    const warnings: string[] = [];
    const keys = new Set<string>();
    for (const f of bundle.files) {
      const m = mapHeatmapFile(f.json);
      warnings.push(...m.warnings.map((w) => `${f.title}: ${w}`));
      for (const r of m.rows) {
        const k = KEYS.dsoSubstationAsOf(r) as string;
        if (keys.has(k)) warnings.push(`${f.title}: duplicate key ${r.dso_name} | ${r.substation_ref}, ignored`);
        else {
          keys.add(k);
          rows.push(r);
        }
      }
    }
    return { rows, warnings, counts: { files: bundle.files.length } };
  },
  /** Apply only: the publisher is registered at its class-table tier and must be an active registry row; the GB jurisdiction entity must exist. */
  async resolve(ctx, rows) {
    const sb = ctx.sb as Db;
    const src = await registerCitedSource({ url: SOURCE_URL, title: SOURCE_NAME }, { sb });
    if (src.refused) throw new Error(`publisher source not rated: ${src.reason}`);
    const row = await sb.from("sources").select("id, status").eq("id", src.source_id).maybeSingle();
    if (row.error) throw new Error(`reading sources failed: ${row.error.message}`);
    if ((row.data as { status?: string } | null)?.status !== "active") throw new Error(`sources row ${src.source_id} is not active; a figure never cites an inactive or absent source`);
    const ent = await sb.from("entities").select("entity_id").eq("entity_id", GB_JURISDICTION_ID);
    if (ent.error) throw new Error(`reading entities failed: ${ent.error.message}`);
    if (!(ent.data ?? []).length) throw new Error(`jurisdiction entity ${GB_JURISDICTION_ID} (GB) is not in entities; the spine is seeded elsewhere, this producer never mints one`);
    return { rows: rows.map((r) => ({ ...r, source_id: src.source_id })), refused: [] };
  },
  plan: {
    read: (sb) => fetchAllRows<Rec>((from, to) => sb.from("grid_connection_queues").select(["queue_id", "dso_name", "substation_ref", "as_of", ...REFRESHABLE].join(", ")).not("substation_ref", "is", null).order("queue_id", { ascending: true }).range(from, to) as never, { cap: 200_000 }),
    key: KEYS.dsoSubstationAsOf,
    patchable: REFRESHABLE,
    pk: "queue_id",
  },
};
