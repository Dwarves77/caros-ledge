// The one door to the pattern packets (DIGEST-1 PR A, D1; wired to CONNECT-2 PR B's packets.ts in PR B). packets.ts builds the packet from the typed rows; this door adds what a finding cites: each member's text (its verbatim spans, then its typed columns) and the surface it sits on (its item's surface, else the surface its table belongs to).
import { rowsByIds, type Db } from "@/core/db";
import { surfaceOf } from "@/core/routing";

import { readPackets as readRaw, type Packet as RawPacket, type PacketMember as RawMember } from "./packets";

export interface PacketMember extends RawMember {
  /** The verbatim text the row offers a finding to cite (its spans, then its typed columns). */
  text: string;
  /** The surface the row sits on; null when neither its item nor its table names one. */
  surface: string | null;
}
export type Packet = RawPacket & { members: PacketMember[] };
export interface PacketRead { packets: Packet[]; marker: string | null }
/** The injection seam the exporters and validators read packets through: a test supplies packets, the turn supplies this door over its client. */
export type PacketReader = (ids: readonly string[]) => Promise<PacketRead>;

/** The surface of a row that belongs to no item: the surface its table is read on. */
const TABLE_SURFACE: Readonly<Record<string, string>> = {
  obligation_objects: "regulations", statutory_computations: "regulations", market_series: "market", oem_tech_roadmaps: "market", research_assessments: "research",
  emission_factors: "operations", grid_connection_queues: "operations", reroute_events: "operations", regional_data_facts: "operations",
};

/** A row's text: its verbatim spans, then its typed columns as `name value` pairs. */
const memberText = (m: RawMember): string =>
  [...m.spans.map((s) => s.text), Object.entries(m.columns).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("; ")].filter(Boolean).join("\n");

async function readPackets(sb: Db, ids: readonly string[]): Promise<PacketRead> {
  const read = await readRaw(sb, ids);
  const itemIds = [...new Set(read.packets.flatMap((p) => p.members.flatMap((m) => (m.table === "intelligence_items" ? [m.id] : m.item_id ? [m.item_id] : []))))];
  const items = new Map((itemIds.length ? await rowsByIds<{ id: string; item_type: string | null; domain: number | null }>(sb, "intelligence_items", "id, item_type, domain", itemIds) : []).map((i) => [i.id, surfaceOf(i.item_type, i.domain)]));
  const adapt = (m: RawMember): PacketMember => ({ ...m, text: memberText(m), surface: items.get(m.table === "intelligence_items" ? m.id : (m.item_id ?? "")) ?? TABLE_SURFACE[m.table] ?? null });
  return { packets: read.packets.map((p) => ({ ...p, members: p.members.map(adapt) })), marker: read.marker };
}

/** The reader the turn and the exporters default to: packets.ts over the batch's own client. */
export const packetReader = (sb: Db): PacketReader => (ids) => readPackets(sb, ids);
