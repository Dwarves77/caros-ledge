// The workspace tests' face of the one shared memory database (tests/_support/memdb.ts): unique keys, generated name keys, an updated_at that moves on every update, uuid ids with a created_at tick,
// the two embeds the workspace reads, and failures with a use count. `memClient(db, who)` is the client a handler gets, with the signed-in answers of `who`.
import { MemDb as Shared, type Err, type Row } from "../_support/memdb.ts";

export type { Row };
export type DbError = NonNullable<Err>;
export interface Logged {
  table: string;
  op: string;
  payload?: unknown;
  filters: [string, string, unknown][];
}

const UNIQUE: Record<string, string[][]> = {
  workspace_tags: [["org_id", "name_key"]],
  item_workspace_tags: [["tag_id", "intelligence_item_id"]],
  portfolios: [["org_id", "name_key"]],
  portfolio_members: [["portfolio_id", "item_id"], ["portfolio_id", "entity_id"]],
  workspace_item_overrides: [["org_id", "item_id"]],
  user_item_state: [["user_id", "item_id"]],
  item_assignments: [["item_id", "assignee_user_id"]],
};

export class MemDb extends Shared {
  constructor(seed: Record<string, Row[]> = {}) {
    super({ ids: "uuid", unique: UNIQUE, generatedKey: ["workspace_tags", "portfolios"], touched: ["workspace_settings"], relations: { "org_memberships.profiles": ["user_id", "id"], "user_item_state.intelligence_items": ["item_id", "id"] } }, seed);
  }
  get log(): Logged[] {
    return this.calls;
  }
  /** Inject a failure: `times` matching calls fail (omitted: every one); `when` sees the call's filters. */
  override fail(table: string, op: Parameters<Shared["fail"]>[1], error: DbError | string = { message: "boom" }, opts: { times?: number; when?: (filters: [string, string, unknown][]) => boolean } = {}): this {
    const e = typeof error === "string" ? { message: error } : error;
    return super.fail(table, op, e.message, { ...(e.code ? { code: e.code } : {}), ...(opts.times === undefined ? {} : { times: opts.times }), ...(opts.when ? { when: (c) => opts.when?.(c.filters) ?? true } : {}) });
  }
}

export interface Who {
  claims: { sub: string; email: string } | null;
  admin?: boolean;
}

/** A client over `db`. `who` decides what getClaims answers (null is signed out) and what is_platform_admin answers. */
export function memClient(db: MemDb, who: Who | null = null) {
  return {
    from: (table: string) => db.from(table),
    async rpc(name: string, args?: unknown) {
      if (name === "is_platform_admin") return { data: who?.admin === true, error: null };
      const fn = db.rpcs[name] as unknown as ((a: unknown) => unknown) | undefined;
      return fn ? { data: fn(args), error: null } : { data: null, error: { message: `no rpc ${name}` } };
    },
    auth: {
      async getClaims() {
        return who?.claims ? { data: { claims: who.claims }, error: null } : { data: null, error: { name: "AuthSessionMissingError", message: "Auth session missing" } };
      },
    },
  } as never;
}
