// The one door to the pattern packets (DIGEST-1 PR A, D1). src/core/digest/packets.ts is CONNECT-2 PR B's and is not on main, so this function answers an empty list and says so: `marker` is the stated
// reason the packets are absent, never a made-up packet. When packets.ts lands, only this body changes; the exporters already declare the packet input in their bundle type and read it here.
const PACKETS_PENDING = "packets: PENDING CONNECT-2 PR B";

/** A packet member row, by table and primary key; `entity_kind` is the coupling class of the entity the row is joined through. */
export interface PacketMember { table: string; id: string; entity_kind?: string | null }
/** The bundle a reader sees for a pattern, a theme or an item (CONNECT-2 C4); nothing outside it may be cited. */
export interface Packet { kind: "pattern" | "theme" | "item"; id: string; members: PacketMember[]; [column: string]: unknown }
export interface PacketRead { packets: Packet[]; marker: string | null }

export async function readPackets(ids: readonly string[]): Promise<PacketRead> {
  return { packets: [], marker: ids.length ? PACKETS_PENDING : null };
}
