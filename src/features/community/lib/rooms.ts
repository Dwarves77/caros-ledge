// Ported from old_repo/src/lib/community/rooms.ts (lines 1-140)
// The seven regional rooms (data: lib/data/rooms.json) and the one classifier from a jurisdiction token to a room. The mapping is TOTAL over the workspace's own jurisdictions (core/workspace): a token listed for a room
// belongs to it, every other workspace jurisdiction belongs to the room its region maps to (data/room-regions.json) unless that file overrides it, and an ISO subdivision code ("US-CA") belongs to its country's room. There is no
// cut at a dash: the old rule folded a slug such as "in-..." to its first two letters by accident. A test fails when a workspace jurisdiction maps to no room. The old MEAF key resolves to the core vocabulary's region code
// MEA; the seeded group slug stays as production holds it.
import { z } from "zod";

import { JURISDICTIONS } from "@/core/workspace/vocabulary";

import roomRegions from "./data/room-regions.json";
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

const regionRooms = z.object({ regions: z.record(z.string(), z.string()), overrides: z.record(z.string(), z.string()) }).parse(roomRegions);
const roomKeys = new Set(ROOMS.map((r) => r.key));
for (const k of [...Object.values(regionRooms.regions), ...Object.values(regionRooms.overrides)]) if (!roomKeys.has(k)) throw new Error(`room-regions.json: ${k} is not a room`);
/** The room of each workspace jurisdiction the token lists do not name: its override, else its region's room. A region with no room is a load error, never a silent null. */
for (const j of JURISDICTIONS) {
  if (BY_TOKEN.has(j.id)) continue;
  const key = regionRooms.overrides[j.id] ?? regionRooms.regions[j.region];
  if (!key) throw new Error(`room-regions.json: the region "${j.region}" of jurisdiction ${j.id} maps to no room`);
  BY_TOKEN.set(j.id, key);
}

/** The room a jurisdiction token belongs to, or null (the caller decides whether an unmatched token folds into the Global room). */
export function roomForJurisdiction(jur: string | null | undefined): RoomKey | null {
  const token = (jur ?? "").toLowerCase().trim();
  if (!token) return null;
  const exact = BY_TOKEN.get(token);
  if (exact) return exact;
  const subdivision = /^([a-z]{2})-[a-z0-9]{1,3}$/.exec(token);
  return subdivision ? (BY_TOKEN.get(subdivision[1] as string) ?? null) : null;
}

export const homeJurisdictionsInRoom = (homes: readonly string[] | null | undefined, key: RoomKey): boolean => !!homes && homes.some((j) => roomForJurisdiction(j) === key);

/** The one meaning of "you belong to this room": a membership row. A home jurisdiction is a hint for the default room, never a membership claim. */
export const isRoomMember = (room: { joined: boolean }): boolean => room.joined;
