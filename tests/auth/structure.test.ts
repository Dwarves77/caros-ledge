// R2e structure tests: what must hold of the code's SHAPE, not of one run. A permission is decided in one place; membership and admin routes use the caller's own client; every admin write either goes through a database function that
// records its event or is named here with the record it already has; no function that changes membership or an organisation forgets to write its event.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n).replace(/\\/g, "/")]));
const code = (p: string): string => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (p: string): string => readFileSync(p, "utf8");

// ── one decider ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A decision about an organisation role in code: a comparison with a role word, or a rank lookup. */
const DECIDES = /(?:===|!==)\s*["'](?:owner|admin|member|viewer)["']|["'](?:owner|admin|member|viewer)["']\s*(?:===|!==)|ROLE_RANK\[/;
/** The deciders this tree has. The database function org_actions is the one place a role becomes a permission (org_can asks it); requireOrgRole is the older rank gate of the workspace routes, listed so that a third cannot appear unseen. */
const KNOWN_TS_DECIDERS = [
  "src/core/http/guard.ts", // requireOrgRole: the minimum-role gate of the workspace routes (to be replaced by org_can when the workspace routes call the database functions)
  "src/features/admin/ui/WorkspacesOverview.tsx", // counts the owners in a roster for a tile: a figure, not a decision
  "src/features/workspace/api/overrides.ts", // the archive pre-check before archive_item_for_team, which asks the role again in the database (owned by the workspace slice)
  "src/features/workspace/ui/DetailTagRow.tsx", // shows or hides a control by role (owned by the workspace slice)
];

test("W:4: a permission is decided in ONE place with one answer: the deciders in the tree are exactly org_actions and the listed rank gate, and the membership routes decide nothing", () => {
  const files = ["src/features/auth", "src/features/admin", "src/core/auth", "src/core/http", "src/features/workspace", "src/features/account"].flatMap((d) => walk(d)).filter((p) => /\.(ts|tsx)$/.test(p));
  const found = files.filter((p) => DECIDES.test(code(p)));
  assert.deepEqual(found.sort(), [...KNOWN_TS_DECIDERS].sort(), "a new place that compares an organisation role must use org_can (the database) or be listed here with its reason");
  for (const p of walk("src/features/auth").filter((x) => /\.(ts|tsx)$/.test(x))) assert.doesNotMatch(code(p), DECIDES, `${p} decides nothing about roles: the database function does`);
  // SQL: the only table of role-to-action is org_role_actions, read by org_actions; every function that changes membership asks org_can
  const sql = ["0100_admin_events", "0101_membership_authority_rpcs"].map((f) => read(`supabase/migrations/${f}.sql`)).join("\n");
  const fn = (name: string) => new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(sql)?.[0] ?? "";
  for (const name of ["set_member_role", "remove_member", "ban_member", "rename_org", "invite_member", "revoke_invitation", "org_roster", "set_priority_override", "restore_team_item"]) assert.match(fn(name), /org_can\(/, `${name} asks org_can`);
  assert.doesNotMatch(fn("set_member_role") + fn("remove_member") + fn("ban_member") + fn("rename_org") + fn("invite_member") + fn("org_roster"), /m\.role (?:IN|=) \('?(?:owner|admin)|v_actor_role|user_org_role/, "none of them reads the caller's role itself");
  assert.match(fn("org_actions"), /org_role_actions/);
});

// ── the caller's own client ────────────────────────────────────────────────────────────────────────────────────────

test("SEC-3b: the membership, organisation-rename and account routes never use the service client (it is exempt from the membership guard)", () => {
  for (const p of ["src/features/auth/api/members.ts", "src/features/auth/api/account.ts", "src/features/auth/api/invitations.ts", "src/features/auth/api/invitation-revoke.ts"]) assert.doesNotMatch(code(p), /serviceClient|service\(\)/, p);
  const org = code("src/features/auth/api/org.ts");
  const patch = org.slice(org.indexOf("export const PATCH"));
  assert.doesNotMatch(patch, /serviceClient|service\(\)/, "the rename runs on the caller's client through rename_org");
  assert.doesNotMatch(code("src/features/auth/api/members.ts"), /profiles_by_email|auth\.admin|getUserById/, "W:1: no route reads which e-mail addresses have accounts");
  assert.doesNotMatch(code("src/core/auth/invitations.ts").split("export async function pendingInvitationsFor")[0] ?? "", /profiles_by_email/, "issuing an invitation never looks an account up");
});

// ── admin writes carry a reason and an event ───────────────────────────────────────────────────────────────────────

/** The admin write handlers that are NOT one of the six events-with-a-reason acts, each with the record it already writes (M2 names the six; these have their own audit rows, ruled outside this slice). */
const OWN_RECORD: Record<string, string> = {
  "bulk-import.ts": "bulk_imports (the import row and its counts)",
  "candidates-pending.ts": "provisional_sources decisions and source_trust_events",
  "corrections.ts": "item_corrections (the correction and its evidence)",
  "pipeline.ts": "the harness ledger of the dispatched stage",
  "run-intake.ts": "the harness ledger of the dispatched stage",
  "source-controls.ts#postTierOverride": "source_trust_events (INV-288)",
  "source-controls.ts#commitTierChange": "source_trust_events (INV-288)",
  "source-controls.ts#patchBiasTag": "source_trust_events (INV-288)",
  "source-controls.ts#fetchNow": "sources.last_checked (a stamp, not a decision)",
  "source-decisions.ts": "source_trust_events and provisional_sources",
  "statutory-rows.ts": "statutory_rows (the upload row)",
  "tier-opinions.ts": "source_trust_events and the opinions' dismissal",
  "themes.ts": "the theme brief version history",
  "corpus-turns.ts#POST": "admin_events through admin_request_corpus_turns (the sweep branch dispatches a turn and writes the harness ledger)",
};

test("INV-R2e-2: every admin write handler is one of the six acts that write an event through a database function (adminDone), or is listed with the record it already writes; a new write handler with neither fails", () => {
  const dir = "src/features/admin/api";
  const writes: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const text = code(`${dir}/${f}`);
    for (const m of text.matchAll(/export const (\w+) = adminRoute/g)) {
      if (/^(?:GET|get|list|read)/.test(m[1] ?? "")) continue; // a read
      const start = m.index ?? 0;
      const next = text.indexOf("export const ", start + 10);
      const block = text.slice(start, next < 0 ? undefined : next);
      const writing = /\.(?:insert|update|upsert|delete)\(|\.rpc\(|writeTrustEvent|applyTierOverride|runTurn\(|adminDone[<(]/.test(block) || /\bPOST\b|\bPATCH\b|\bPUT\b|\bDELETE\b/.test(m[1] ?? "");
      if (!writing) continue;
      const read = !/\.(?:insert|update|upsert|delete)\(|writeTrustEvent|applyTierOverride|runTurn\(|adminDone[<(]|\.rpc\(/.test(block);
      if (read) continue;
      writes.push(`${f}#${m[1]}`);
    }
  }
  const events = new Set(writes.filter((w) => code(`${dir}/${w.split("#")[0]}`).split(`export const ${w.split("#")[1]} = adminRoute`)[1]?.split("export const ")[0]?.includes("adminDone")));
  const covered = (w: string): boolean => events.has(w) || w in OWN_RECORD || w.split("#")[0]! in OWN_RECORD;
  assert.deepEqual(writes.filter((w) => !covered(w)), [], "an adminRoute write handler writes an admin_events row (adminDone) or names the record it writes here");
  for (const six of ["source-controls.ts#pauseSource", "source-controls.ts#setVisibility", "integrity-flags.ts#PATCH", "integrity-flags.ts#resolveBriefFlag", "triage.ts#triageRejection", "triage.ts#resolveJurisdictionReview", "pause-global.ts#POST"]) assert.ok(events.has(six), `${six} writes its event`);
  assert.ok(Object.keys(OWN_RECORD).every((k) => k.includes("#") || readdirSync(dir).includes(k)), "every listed file exists");
});

test("INV-R2e-2: every function of migrations 0101 to 0103 that changes membership, an organisation, an invitation or a group's privacy writes its event (record_admin_event) in the same function", () => {
  const sql = ["0101_membership_authority_rpcs", "0102_admin_action_rpcs", "0103_community_trust_marks"].map((f) => read(`supabase/migrations/${f}.sql`)).join("\n");
  const mutating = ["set_member_role", "remove_member", "ban_member", "rename_org", "invite_member", "revoke_invitation", "accept_invitation_by_id", "create_org_for_self", "set_priority_override", "restore_team_item", "admin_set_source_switch", "admin_set_flag_status",
    "admin_resolve_brief_flag", "admin_triage_rejection", "admin_resolve_jurisdiction_review", "admin_set_hold", "admin_request_corpus_turns", "record_domain_verification", "admin_mark_verified", "set_group_privacy"];
  for (const name of mutating) {
    const body = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(sql)?.[0] ?? "";
    assert.ok(body.length > 0, `${name} is defined`);
    assert.match(body, /record_admin_event\(/, `${name} writes its event`);
  }
});
