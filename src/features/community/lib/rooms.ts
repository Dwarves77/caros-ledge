// Ported from old_repo/src/lib/community/rooms.ts (lines 1-140)
// The seven regional rooms (data: lib/data/rooms.json) and the one classifier from a jurisdiction token to a room: the exact token first, then the token cut at a dash in its first two characters ("us-ca" is the US;
// "sri-lanka" is not cut). That cut is the old rule, kept so the room counts stay the ones the current site prints (it also folds a slug such as "in-..." to its two letters; changing it moves items between rooms and is
// a decision for the coordinator). The old MEAF key resolves to the core vocabulary's region code MEA; the seeded group slug stays as production holds it.
import { z } from "zod";

import roomsJson from "./data/rooms.json";
import { REGION_CODES } from "./labels";

const roomSchema = z.object({ key: z.string().min(1), slug: z.string().min(1), regionCode: z.string().min(1), name: z.string().min(1), short: z.string().min(1), jurisdictions: z.array(z.string().min(1)).min(1) });
export const ROOMS = z.array(roomSchema).length(7).parse(roomsJson);
export type RoomDef = (typeof ROOMS)[number];
export type RoomKey = RoomDef["key"];

for (const r of ROOMS) if (!REGION_CODES.includes(r.regionCode)) throw new Error(`rooms.json: ${r.key} names region ${r.regionCode}, which the core vocabulary does not define`);

export const CANONICAL_ROOM_SLUGS: readonly string[] = ROOMS.map((r) => r.slug);
const BY_TOKEN = new Map<string, RoomKey>(ROOMS.flatMap((r) => r.jurisdictions.map((j) => [j, r.key] as const)));
if (BY_TOKEN.size !== ROOMS.reduce((n, r) => n + r.jurisdictions.length, 0)) throw new Error("rooms.json: a jurisdiction token belongs to two rooms");

/** The room a jurisdiction token belongs to, or null (the caller decides whether an unmatched token folds into the Global room). */
export function roomForJurisdiction(jur: string | null | undefined): RoomKey | null {
  const token = (jur ?? "").toLowerCase().trim();
  if (!token) return null;
  const exact = BY_TOKEN.get(token);
  if (exact) return exact;
  const dash = token.indexOf("-");
  return dash > 0 && dash <= 2 ? (BY_TOKEN.get(token.slice(0, dash)) ?? null) : null;
}

export const homeJurisdictionsInRoom = (homes: readonly string[] | null | undefined, key: RoomKey): boolean => !!homes && homes.some((j) => roomForJurisdiction(j) === key);

/** The one meaning of "you belong to this room": a membership row. A home jurisdiction is a hint for the default room, never a membership claim. */
export const isRoomMember = (room: { joined: boolean }): boolean => room.joined;
