"use client";

// Ported from old_repo/src/components/portfolio/PortfolioDetailView.tsx (lines 88-366)
import { useRouter } from "next/navigation";
import { useState } from "react";

import { VOCABULARIES } from "@/core/contracts";
import { BAND_ORDER, bandFromPriority, NEUTRAL_BAND, type ListRowFields } from "@/core/lists";
import { countNoun } from "@/core/shared";
import { Button, CardFoot, InlineErrorBanner, Input, ListRow, ListRowHeader, Masthead, Menu, RailCard, SectionCard, SectionHead, StatBlock, StateNote } from "@/ui";
import { PageFrame } from "@/ui/shell";
import { RowActions } from "@/features/watchlist/ui/RowActions";
import type { PortfolioDetailView as Detail, PortfolioItemRow, PortfolioSurfaceKey } from "@/features/workspace/portfolio/types";

import { deletePortfolioRequest, removeMemberRequest, renamePortfolioRequest, type PortfolioCallResult } from "../client";

import { PortfolioAddSearch } from "./PortfolioAddSearch";
import styles from "./portfolio.module.css";

const SURFACE_LABEL: Record<PortfolioSurfaceKey, string> = { regulations: "Regulations", market: "Market Intel", research: "Research", operations: "Operations" };
const WATCH_TYPE: Record<PortfolioSurfaceKey, "reg" | "signal" | "research" | "operations"> = { regulations: "reg", market: "signal", research: "research", operations: "operations" };
const ENTITY_KIND_LABEL: Record<string, string> = { corridor: "Corridor", node: "Place", jurisdiction: "Jurisdiction", organisation: "Organisation", asset: "Vessel or asset", instrument: "Instrument", obligation: "Obligation", method: "Method", technology: "Technology", signpost: "Signpost", person: "Person" };
const fieldsOf = (r: PortfolioItemRow): ListRowFields => r.fields as unknown as ListRowFields;

/** One portfolio: the roll-ups (each over the held items, with its denominator), the members grouped by surface on the shared row, the corridors and entities, and the manage and add cards (hidden from a viewer). */
export function PortfolioDetailView({ view, readOnly, dateLabel, nowIso }: { view: Detail; readOnly: boolean; dateLabel: string; nowIso: string }) {
  const router = useRouter();
  const { portfolio, rollup, groups, entityRows } = view;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState(portfolio.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const allRows = groups.flatMap((g) => g.rows);
  const heldCount = rollup.items.held;
  const nextDueRow = rollup.nextDue ? allRows.find((r) => r.itemUuid === rollup.nextDue?.itemId) : undefined;
  const notHeld = rollup.items.notHeld;
  const weakest = rollup.origin.weakest ? (VOCABULARIES.origin_class?.[rollup.origin.weakest]?.label ?? rollup.origin.weakest) : null;

  async function run(key: string, fn: () => Promise<PortfolioCallResult>, after: () => void) {
    if (busy) return;
    setBusy(key);
    setError(null);
    const res = await fn();
    setBusy(null);
    if (!res.ok) return setError(res.error ?? "That did not go through. Try again.");
    after();
  }
  const remove = (member: { itemId?: string; entityId?: string }) => run(`rm:${member.itemId ?? member.entityId}`, () => removeMemberRequest(portfolio.id, member), () => router.refresh());
  const removeItem = (onRemove: () => void) => [{ key: "remove", label: "Remove from portfolio", onSelect: onRemove }];
  async function clearNotHeld() {
    setBusy("clear");
    setError(null);
    for (const id of notHeld) {
      const res = await removeMemberRequest(portfolio.id, { itemId: id });
      if (!res.ok) {
        setError(res.error ?? "That did not go through. Try again.");
        break;
      }
    }
    setBusy(null);
    router.refresh();
  }

  const dek = (
    <span>
      <b>{rollup.items.held}</b> of {countNoun(rollup.items.members, "item")} held · <b>{rollup.entities.corridors}</b> {rollup.entities.corridors === 1 ? "corridor" : "corridors"} · <b>{rollup.entities.other}</b> {rollup.entities.other === 1 ? "entity" : "entities"}
    </span>
  );
  return (
    <>
      <div className="cl-list-surface-masthead">
        <Masthead title={portfolio.name} dateLabel={dateLabel} nowIso={nowIso} dek={dek} />
      </div>
      <PageFrame
        rail={
          <div className={styles.rail}>
            <RailCard title="By surface">
              {(Object.keys(SURFACE_LABEL) as PortfolioSurfaceKey[]).map((k) => (
                <StatBlock key={k} layout="row" label={SURFACE_LABEL[k]} value={rollup.bySurface[k]} note={`of ${heldCount} held`} />
              ))}
            </RailCard>
            <RailCard title="By urgency">
              {BAND_ORDER.map((b) => (
                <StatBlock key={b.key} layout="row" label={`${b.label} · ${b.window}`} value={rollup.byPriority[b.priority]} note={`of ${heldCount} held`} />
              ))}
              {rollup.byPriority.unscored > 0 && <StatBlock layout="row" label="No band yet" value={rollup.byPriority.unscored} note={`of ${heldCount} held`} />}
            </RailCard>
            <RailCard title="Held data">
              <StatBlock layout="row" label="Next date" value={rollup.nextDue ? `${rollup.nextDue.days}d` : "No date"} note={nextDueRow ? nextDueRow.title : rollup.nextDue ? undefined : "no held item carries a future date"} />
              <StatBlock layout="row" label="Weakest source class" value={weakest ?? "No class"} note={weakest ? `${rollup.origin.classified} of ${heldCount} classified` : heldCount === 0 ? "nothing held yet" : `0 of ${heldCount} classified`} />
              {rollup.origin.unclassified > 0 && rollup.origin.classified > 0 && <p className={styles.fine}>{countNoun(rollup.origin.unclassified, "held item")} carry no class and are not counted in it.</p>}
            </RailCard>
            {!readOnly && (
              <RailCard title="Manage">
                <form className={styles.stack} onSubmit={(e) => (e.preventDefault(), void run("rename", () => renamePortfolioRequest(portfolio.id, name.trim()), () => router.refresh()))}>
                  <label htmlFor="portfolio-rename" className="cl-field-label">
                    Portfolio name
                  </label>
                  <Input id="portfolio-rename" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
                  <Button type="submit" variant="secondary" disabled={busy !== null || name.trim().length === 0 || name.trim() === portfolio.name}>
                    {busy === "rename" ? "Saving..." : "Rename"}
                  </Button>
                </form>
                <div className={styles.stack}>
                  {confirmDelete ? (
                    <>
                      <p className={styles.say}>Delete this portfolio for everyone in your workspace? The items, corridors and entities themselves stay where they are.</p>
                      <Button variant="danger" disabled={busy !== null} onClick={() => void run("delete", () => deletePortfolioRequest(portfolio.id), () => router.push("/dashboard/portfolio"))}>
                        {busy === "delete" ? "Deleting..." : "Yes, delete portfolio"}
                      </Button>
                      <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmDelete(false)}>
                        Keep it
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                      Delete portfolio
                    </Button>
                  )}
                </div>
              </RailCard>
            )}
          </div>
        }
      >
        <div className={styles.column}>
          {error && <InlineErrorBanner message={error} />}
          {notHeld.length > 0 && (
            <StateNote {...(readOnly ? {} : { action: { label: busy === "clear" ? "Removing..." : "Remove them", onClick: () => void clearNotHeld() } })}>
              {countNoun(notHeld.length, "item")} in this portfolio {notHeld.length === 1 ? "is" : "are"} no longer held by the platform (archived or withdrawn). They are counted in the total and left out of every figure.
            </StateNote>
          )}
          {rollup.total === 0 && (
            <SectionCard>
              <SectionHead title="Nothing here yet" aside={readOnly ? "Read only" : "Add your first item below"} />
              <div className={styles.pad}>
                <StateNote>{readOnly ? "This portfolio is empty. Your role in this workspace can read portfolios but not add to them; a member, admin or owner can." : "This portfolio is empty. Search below to add an item, or add an item, corridor or entity from the page that shows it."}</StateNote>
              </div>
            </SectionCard>
          )}
          {groups.map((g) => (
            <SectionCard key={g.surface}>
              <SectionHead title={`${SURFACE_LABEL[g.surface]} · ${g.rows.length}`} aside="Nearest date first" />
              <ListRowHeader />
              {g.rows.map((r) => {
                const f = fieldsOf(r);
                return (
                  <ListRow key={r.itemUuid} href={f.href} band={bandFromPriority(f.priority)} itemType={f.type} jurisdiction={f.jurisdiction} title={f.title} summary={f.summary} due={f.due} tier={f.tier} overflow={<RowActions title={f.title} type={WATCH_TYPE[g.surface]} id={r.uiId} items={readOnly ? [] : removeItem(() => void remove({ itemId: r.itemUuid }))} />} />
                );
              })}
              <CardFoot left={`${g.rows.length} of ${heldCount} held items in this portfolio`} right={null} />
            </SectionCard>
          ))}
          {entityRows.length > 0 && (
            <SectionCard>
              <SectionHead title={`Corridors and entities · ${entityRows.length}`} aside="Spine entities" />
              <ListRowHeader titleLabel="Name" />
              {entityRows.map((e) => (
                <ListRow key={e.entityId} href={`/search?q=${encodeURIComponent(e.label)}`} band={NEUTRAL_BAND} itemType="reference" typeLabel={ENTITY_KIND_LABEL[e.entityKind] ?? e.entityKind} title={e.label} overflow={readOnly ? undefined : <Menu label={`Actions for ${e.label}`} items={removeItem(() => void remove({ entityId: e.entityId }))} />} />
              ))}
              <CardFoot left="Open an entity to search the platform for what it holds about it." right={null} />
            </SectionCard>
          )}
          {view.entitiesUnread > 0 && (
            <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
              {countNoun(view.entitiesUnread, "entity")} could not be read just now and {view.entitiesUnread === 1 ? "is" : "are"} not shown.
            </StateNote>
          )}
          {!readOnly && (
            <SectionCard>
              <SectionHead title="Add to this portfolio" aside="Held items only" />
              <PortfolioAddSearch portfolioId={portfolio.id} memberItemIds={allRows.map((r) => r.itemUuid)} />
            </SectionCard>
          )}
        </div>
      </PageFrame>
    </>
  );
}
