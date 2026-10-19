// Ported from old_repo/src/lib/portfolio/portfolio-core.mjs (lines 60-386)
import { admitItems } from "@/core/derived/admissible";
import type { Db } from "@/core/db/clients";
import { fetchAllRows } from "@/core/db/query";
import { dbError, HttpError, LookupError } from "@/core/http/errors";
import { isUuid } from "@/core/http/parse";

import { PORTFOLIO_LIST_CAP, PORTFOLIO_MEMBER_CAP, PORTFOLIO_NAME_MAX, SURFACE_KEYS, type MemberDbRow, type MemberInput, type MemberRow, type PortfolioRow, type PortfolioSummary, type PortfolioSurfaceKey, type Rollup } from "./types";

// The portfolio model: a selection of HELD things (items and entities), never customer-entered data (ADR-042). Every statement is
// filtered by the caller's org, and another org's portfolio id answers 404 exactly like a missing one. Failures throw HttpError: a failed
// read is a 503 (LookupError), never an empty list or "not found".
const ENTITY_ID_RE = /^cl:([a-z]+):(.+)$/;
const MAX_ENTITY_ID_LEN = 200;
const MAX_MERGE_HOPS = 5;
/** Every portfolio count is read from member rows; the DB caps a workspace at 100 portfolios of 500 members. */
const COUNT_READ_CAP = PORTFOLIO_LIST_CAP * PORTFOLIO_MEMBER_CAP;
const PORTFOLIO_COLUMNS = "id, name, created_at";
const MEMBER_COLUMNS = "id, member_kind, item_id, entity_id, added_at";

const isUnique = (err: { code?: string | null; message?: string }) => err.code === "23505" || /duplicate key/i.test(err.message ?? "");
const isCap = (err: { message?: string }) => /portfolio_(member_)?cap_reached/.test(err.message ?? "");
const toPortfolio = (r: { id: string; name: string; created_at: string }): PortfolioRow => ({ id: r.id, name: r.name, createdAt: r.created_at });
const notFound = (what: string) => new HttpError(404, `${what} not found in your workspace`);

// ── 1. input rules ──────────────────────────────────────────────────────────────────────────────────

/** Trim and collapse whitespace; null when empty or over the limit (the route answers 400 without a trip). */
export function normalizePortfolioName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  return trimmed.length === 0 || trimmed.length > PORTFOLIO_NAME_MAX ? null : trimmed;
}

/** "corridor" for cl:corridor:*, "entity" for any other well-formed entity id, null when malformed. */
export function memberKindForEntityId(entityId: unknown): "corridor" | "entity" | null {
  if (typeof entityId !== "string" || entityId.length > MAX_ENTITY_ID_LEN) return null;
  const m = ENTITY_ID_RE.exec(entityId);
  return m ? (m[1] === "corridor" ? "corridor" : "entity") : null;
}

/** One member from a request body: exactly one of `itemId` (a uuid; the route resolves a legacy id first) or `entityId`. */
export function parseMemberInput(body: unknown): { ok: true; member: MemberInput } | { ok: false; error: string } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const hasItem = typeof b.itemId === "string" && b.itemId.length > 0;
  const hasEntity = typeof b.entityId === "string" && b.entityId.length > 0;
  if (hasItem === hasEntity) return { ok: false, error: "Send exactly one of itemId or entityId." };
  if (hasItem) {
    if (!isUuid(b.itemId)) return { ok: false, error: "itemId must be an item id." };
    return { ok: true, member: { kind: "item", itemId: (b.itemId as string).toLowerCase() } };
  }
  const kind = memberKindForEntityId(b.entityId);
  if (!kind) return { ok: false, error: "entityId must look like cl:<kind>:<id>." };
  return { ok: true, member: { kind, entityId: b.entityId as string } };
}

const memberColumn = (m: MemberInput) => (m.kind === "item" ? ({ col: "item_id", val: m.itemId } as const) : ({ col: "entity_id", val: m.entityId } as const));
const parsedMember = (input: unknown): MemberInput => {
  const parsed = parseMemberInput(input);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  return parsed.member;
};

// ── 2. the service ──────────────────────────────────────────────────────────────────────────────────

/** The portfolios of one workspace, newest first, each with its member count. */
export async function listPortfolios(client: Db, orgId: string): Promise<PortfolioSummary[]> {
  const { data, error } = await client.from("portfolios").select(PORTFOLIO_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: false }).order("id", { ascending: true }).limit(PORTFOLIO_LIST_CAP);
  if (error) throw new LookupError("portfolios", error);
  const rows = (data ?? []) as { id: string; name: string; created_at: string }[];
  let members: { portfolio_id: string }[] = [];
  if (rows.length > 0) {
    try {
      members = await fetchAllRows((from, to) => client.from("portfolio_members").select("portfolio_id").eq("org_id", orgId).order("id", { ascending: true }).range(from, to), { cap: COUNT_READ_CAP });
    } catch (e) {
      throw new LookupError("portfolio_members", e);
    }
  }
  const counts = new Map<string, number>();
  for (const m of members) counts.set(m.portfolio_id, (counts.get(m.portfolio_id) ?? 0) + 1);
  return rows.map((r) => ({ ...toPortfolio(r), memberCount: counts.get(r.id) ?? 0 }));
}

/** One portfolio row, or null when it is not in this org (another org's id looks exactly like a missing one). */
export async function getPortfolio(client: Db, orgId: string, portfolioId: string): Promise<PortfolioRow | null> {
  if (!isUuid(portfolioId)) return null;
  const { data, error } = await client.from("portfolios").select(PORTFOLIO_COLUMNS).eq("id", portfolioId).eq("org_id", orgId).maybeSingle();
  if (error) throw new LookupError("portfolios", error);
  return data ? toPortfolio(data as { id: string; name: string; created_at: string }) : null;
}

async function requirePortfolio(client: Db, orgId: string, portfolioId: string): Promise<PortfolioRow> {
  const found = await getPortfolio(client, orgId, portfolioId);
  if (!found) throw notFound("Portfolio");
  return found;
}

/** Create; a case-insensitive duplicate name returns the EXISTING portfolio (`existed: true`), not an error. */
export async function createPortfolio(client: Db, args: { orgId: string; userId: string; name: unknown }): Promise<{ existed: boolean; portfolio: PortfolioRow }> {
  const clean = normalizePortfolioName(args.name);
  if (!clean) throw new HttpError(400, `name is required (1-${PORTFOLIO_NAME_MAX} characters)`);
  const { data, error } = await client.from("portfolios").insert({ org_id: args.orgId, name: clean, created_by: args.userId }).select(PORTFOLIO_COLUMNS).single();
  if (!error) return { existed: false, portfolio: toPortfolio(data as { id: string; name: string; created_at: string }) };
  if (isCap(error)) throw new HttpError(409, "A workspace holds at most 100 portfolios.");
  if (!isUnique(error)) throw dbError(error);
  const existing = await client.from("portfolios").select(PORTFOLIO_COLUMNS).eq("org_id", args.orgId).eq("name_key", clean.toLowerCase()).maybeSingle();
  if (existing.error) throw new LookupError("portfolios", existing.error);
  if (!existing.data) throw dbError(error);
  return { existed: true, portfolio: toPortfolio(existing.data as { id: string; name: string; created_at: string }) };
}

export async function renamePortfolio(client: Db, args: { orgId: string; portfolioId: string; name: unknown }): Promise<PortfolioRow> {
  const clean = normalizePortfolioName(args.name);
  if (!clean) throw new HttpError(400, `name is required (1-${PORTFOLIO_NAME_MAX} characters)`);
  const found = await requirePortfolio(client, args.orgId, args.portfolioId);
  const { error } = await client.from("portfolios").update({ name: clean }).eq("id", args.portfolioId).eq("org_id", args.orgId);
  if (error) throw isUnique(error) ? new HttpError(409, "Another portfolio in your workspace already has that name.") : dbError(error);
  return { ...found, name: clean };
}

export async function deletePortfolio(client: Db, args: { orgId: string; portfolioId: string }): Promise<void> {
  await requirePortfolio(client, args.orgId, args.portfolioId);
  // Members go with it (ON DELETE CASCADE on the composite FK).
  const { error } = await client.from("portfolios").delete().eq("id", args.portfolioId).eq("org_id", args.orgId);
  if (error) throw dbError(error);
}

/** The members of one portfolio (the DB caps it at 500; a read that reaches the cap is an error, never a cut-off list). */
export async function listMembers(client: Db, args: { orgId: string; portfolioId: string }): Promise<MemberDbRow[]> {
  try {
    return await fetchAllRows((from, to) => client.from("portfolio_members").select(MEMBER_COLUMNS).eq("portfolio_id", args.portfolioId).eq("org_id", args.orgId).order("added_at", { ascending: true }).order("id", { ascending: true }).range(from, to), { cap: PORTFOLIO_MEMBER_CAP });
  } catch (e) {
    throw new LookupError("portfolio_members", e);
  }
}

/** Resolve an entity for adding: follow a merge tombstone to the survivor (never 404), refuse a retired one. */
async function resolveEntityForAdd(client: Db, entityId: string): Promise<string> {
  let id = entityId;
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop += 1) {
    const { data, error } = await client.from("entities").select("entity_id, kind, status, merged_into").eq("entity_id", id).maybeSingle();
    if (error) throw new LookupError("entities", error);
    if (!data) throw notFound("Entity");
    if (data.status === "merged" && data.merged_into) {
      id = data.merged_into as string;
      continue;
    }
    if (data.status === "retired") throw new HttpError(409, "That entity is retired and cannot be added.");
    return data.entity_id as string;
  }
  throw new HttpError(409, "That entity's merge chain is too long to follow.");
}

const shapeMember = (row: MemberDbRow): MemberRow => ({ id: row.id, kind: row.member_kind, itemId: row.item_id ?? null, entityId: row.entity_id ?? null, addedAt: row.added_at });

async function findMember(client: Db, orgId: string, portfolioId: string, member: MemberInput): Promise<MemberDbRow | null> {
  const { col, val } = memberColumn(member);
  const { data, error } = await client.from("portfolio_members").select(MEMBER_COLUMNS).eq("portfolio_id", portfolioId).eq("org_id", orgId).eq(col, val).maybeSingle();
  if (error) throw new LookupError("portfolio_members", error);
  return (data as MemberDbRow | null) ?? null;
}

/**
 * Add one HELD item or entity: the item exists, is verified and is not archived (the customer read gate), or the entity exists and is
 * active. Idempotent: adding what is already a member returns that member with `existed: true`.
 */
export async function addMember(client: Db, args: { orgId: string; userId: string; portfolioId: string; input: unknown }): Promise<{ existed: boolean; member: MemberRow }> {
  let member = parsedMember(args.input);
  await requirePortfolio(client, args.orgId, args.portfolioId);
  if (member.kind === "item") {
    const { data, error } = await admitItems(client.from("intelligence_items").select("id").eq("id", member.itemId)).maybeSingle();
    if (error) throw new LookupError("intelligence_items", error);
    if (!data) throw new HttpError(404, "That item is not held by the platform, so it cannot be added.");
  } else {
    const entityId = await resolveEntityForAdd(client, member.entityId);
    member = { kind: memberKindForEntityId(entityId) ?? "entity", entityId };
  }
  const existing = await findMember(client, args.orgId, args.portfolioId, member);
  if (existing) return { existed: true, member: shapeMember(existing) };
  const { col, val } = memberColumn(member);
  const { data, error } = await client.from("portfolio_members").insert({ portfolio_id: args.portfolioId, org_id: args.orgId, member_kind: member.kind, added_by: args.userId, [col]: val }).select(MEMBER_COLUMNS).single();
  if (error) {
    if (isUnique(error)) {
      // Two adds raced: the other one won, which is the same record.
      const again = await findMember(client, args.orgId, args.portfolioId, member);
      if (again) return { existed: true, member: shapeMember(again) };
    }
    if (isCap(error)) throw new HttpError(409, `A portfolio holds at most ${PORTFOLIO_MEMBER_CAP} members.`);
    throw dbError(error);
  }
  return { existed: false, member: shapeMember(data as MemberDbRow) };
}

/** Remove one member (by item or entity id) from a portfolio of this org. Removing what is absent is not an error. */
export async function removeMember(client: Db, args: { orgId: string; portfolioId: string; input: unknown }): Promise<void> {
  const member = parsedMember(args.input);
  await requirePortfolio(client, args.orgId, args.portfolioId);
  const { col, val } = memberColumn(member);
  const { error } = await client.from("portfolio_members").delete().eq("portfolio_id", args.portfolioId).eq("org_id", args.orgId).eq(col, val);
  if (error) throw dbError(error);
}

// ── 3. roll-ups, computed at read time from held data only ──────────────────────────────────────────

/** Roll-ups over the members and the HELD member items. Every aggregate carries its denominator. */
export function computeRollup(args: { members: { kind: string; itemId: string | null; entityId: string | null }[]; heldItems: { id: string; surface: string; priority: string | null; dueDays: number | null; originClass: string | null }[] }, weakestOriginClass: (classes: string[]) => string | null): Rollup {
  const { members, heldItems } = args;
  const itemMembers = members.filter((m) => m.kind === "item");
  const heldIds = new Set(heldItems.map((h) => h.id));
  const bySurface = Object.fromEntries(SURFACE_KEYS.map((k) => [k, 0])) as Record<PortfolioSurfaceKey, number>;
  const byPriority = { CRITICAL: 0, HIGH: 0, MODERATE: 0, LOW: 0, unscored: 0 };
  let otherSurface = 0;
  let nextDue: Rollup["nextDue"] = null;
  const classes: string[] = [];
  for (const h of heldItems) {
    if (h.surface in bySurface) bySurface[h.surface as PortfolioSurfaceKey] += 1;
    else otherSurface += 1;
    if (h.priority && h.priority in byPriority) byPriority[h.priority as keyof typeof byPriority] += 1;
    else byPriority.unscored += 1;
    if (typeof h.dueDays === "number" && h.dueDays >= 0 && (nextDue === null || h.dueDays < nextDue.days)) nextDue = { itemId: h.id, days: h.dueDays };
    if (h.originClass) classes.push(h.originClass);
  }
  return {
    total: members.length,
    items: { members: itemMembers.length, held: heldItems.length, notHeld: itemMembers.filter((m) => !heldIds.has(m.itemId ?? "")).map((m) => m.itemId as string) },
    entities: { corridors: members.filter((m) => m.kind === "corridor").length, other: members.filter((m) => m.kind === "entity").length },
    bySurface,
    otherSurface,
    byPriority,
    nextDue,
    origin: { weakest: weakestOriginClass(classes), classified: classes.length, unclassified: heldItems.length - classes.length },
  };
}

