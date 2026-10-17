"use client";

// Ported from old_repo/src/components/coverage/CoveragePageView.tsx (lines 1-294)
import Link from "next/link";

import { ALL, coverageHref, UNTAGGED, type buildCoverageView, type CoverageMatrix, type CoverageQuery } from "@/core/coverage/matrix";
import { formatLocaleDate, formatNumber } from "@/core/shared";
import { Button, CoverageState, FormField, Masthead, RailCard, SectionCard, SectionHead, Select } from "@/ui";
import { PageFrame } from "@/ui/shell/PageFrame";

import { RequestableCoverageState } from "../client";

import styles from "./coverage.module.css";
import { ExportButton } from "./ExportButton";

type View = ReturnType<typeof buildCoverageView>;
const dateOf = (iso: string | null): string | null => (iso ? formatLocaleDate(new Date(iso), { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : null);

const Fraction = ({ numerator, denominator }: { numerator: number; denominator: number }) => (
  <span className={styles.fraction}>{formatNumber(numerator)} of {formatNumber(denominator)}</span>
);

/** The scope of a view in words, from the labels the matrix itself carries. Pure. */
export function scopeLabel(matrix: Pick<CoverageMatrix, "dataClasses" | "geographies" | "modes">, query: CoverageQuery): string {
  const cls = query.dataClass === ALL ? "every data class" : (matrix.dataClasses.find((c) => c.code === query.dataClass)?.label ?? query.dataClass);
  const geo = query.geography === ALL ? "every geography" : (matrix.geographies.find((g) => g.code === query.geography)?.label ?? query.geography);
  const mode = query.mode === ALL ? "all modes" : (matrix.modes.find((m) => m.code === query.mode)?.label ?? query.mode);
  return `${cls}, ${geo}, ${mode}`;
}

/** The coverage page: what the platform watches and what it does not, by data class, place and mode. A read that failed is the error state with Retry and no numbers; a cell with nothing catalogued is "not covered" with a request control, never a zero. */
export function CoveragePage({ matrix, view, query, error, nowIso }: { matrix: CoverageMatrix; view: View; query: CoverageQuery; error: string | null; nowIso: string }) {
  const here = coverageHref(query);
  const dateLabel = formatLocaleDate(new Date(nowIso), { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const rail = error ? undefined : (
    <aside>
      <RailCard title="How to read this" dataAudit="coverage-definitions">
        <p className="cl-coverage-line"><b>Denominator.</b> {matrix.definitions.denominator}</p>
        <p className="cl-coverage-line"><b>Numerator.</b> {matrix.definitions.numerator}</p>
        <p className="cl-coverage-line"><b>Verified briefs.</b> {matrix.verifiedBriefs === null ? "The count could not be read just now." : `${formatNumber(matrix.verifiedBriefs)} on the platform. ${matrix.definitions.verified_briefs}`}</p>
      </RailCard>
    </aside>
  );
  return (
    <div>
      <div className={styles.head}>
        <Masthead title="Coverage" dateLabel={dateLabel} nowIso={nowIso} dek={<>What the platform watches and what it does not · instruments catalogued per data class and place, and how many are <b>dual-verified</b> · generated from the data</>} />
      </div>
      <PageFrame {...(rail ? { rail } : {})}>
        <div className={styles.stack}>
          {error ? (
            <SectionCard as="section" aria-label="Coverage matrix"><div className="cl-form-body"><CoverageState state="error" variant="block" subject="The coverage matrix" reason={error} retryHref={here} /></div></SectionCard>
          ) : (
            <>
              <SectionCard as="section" aria-label="Coverage matrix">
                <SectionHead title={`Coverage matrix · ${formatNumber(matrix.geographies.length)} places`} aside={<span data-part="coverage-version">Version {matrix.version} · generated {dateOf(matrix.generatedAt)} · data as of {dateOf(matrix.dataAsOf) ?? "not recorded by the index yet"}</span>} />
                <div className="cl-form-body">
                  <details data-part="coverage-methodology">
                    <summary className={styles.summary}>How these figures are made</summary>
                    <p className="cl-coverage-line">{matrix.definitions.numerator_one_line}</p>
                  </details>
                  <form method="get" action="/dashboard/coverage" className={styles.form}>
                    <FormField label="Data class">{(c) => <Select {...c} name="data_class" defaultValue={query.dataClass}><option value={ALL}>All data classes</option>{matrix.dataClasses.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}</Select>}</FormField>
                    <FormField label="Geography">{(c) => <Select {...c} name="geography" defaultValue={query.geography}><option value={ALL}>All geographies</option>{matrix.geographies.map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}</Select>}</FormField>
                    <FormField label="Mode">{(c) => <Select {...c} name="mode" defaultValue={query.mode}><option value={ALL}>All modes</option>{matrix.modes.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}</Select>}</FormField>
                    <Button type="submit" variant="secondary">Show</Button>
                  </form>
                  {matrix.modeTagging.tagged > 0 && matrix.modeTagging.tagged < matrix.modeTagging.total ? (
                    <p data-part="coverage-mode-tagging" className="cl-coverage-line">Transport mode is tagged on <Fraction numerator={matrix.modeTagging.tagged} denominator={matrix.modeTagging.total} /> catalogued instruments; the rest sit under Mode not tagged.</p>
                  ) : null}
                  {matrix.modeTagging.tagged === 0 ? <RequestableCoverageState state="not_covered" variant="block" subject="Transport mode on the catalogue" reason={matrix.definitions.untagged_mode} requestRef={coverageHref({ mode: UNTAGGED })} /> : null}
                  <p className="cl-coverage-line"><b><Fraction numerator={view.scoped.numerator} denominator={view.scoped.denominator} /></b> catalogued instruments in this view are dual-verified. An instrument tagged to two data classes counts in both columns; the platform total is <Fraction numerator={matrix.totals.numerator} denominator={matrix.totals.denominator} />.</p>
                  {view.rows.length > 0 ? <ExportButton query={query} label={scopeLabel(matrix, query)} /> : null}
                  {view.rows.length === 0 ? (
                    <RequestableCoverageState state="not_covered" variant="block" subject="This view of the catalogue" reason="No catalogued instrument matches the data class, geography and mode you chose." requestRef={here} />
                  ) : (
                    <div data-audit="coverage-rows">
                      {view.rows.map((row) => (
                        <div key={row.geography} data-part="coverage-row" className={styles.row}>
                          <span data-guard-title className={styles.geo}>{row.label}</span>
                          <span className={styles.cells}>
                            {row.cells.map((c) => (
                              <Link key={c.dataClass} href={c.href} className={styles.cell} aria-label={c.present ? `${c.dataClassLabel} in ${row.label}: ${c.numerator} of ${c.denominator} dual-verified` : `${c.dataClassLabel} in ${row.label}: not covered, open the cell to request coverage`}>
                                <span>{c.dataClassLabel}</span>
                                {c.present ? <b><Fraction numerator={c.numerator} denominator={c.denominator} /></b> : <CoverageState state="not_covered" variant="cell" subject={`${c.dataClassLabel} in ${row.label}`} />}
                              </Link>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </SectionCard>
              {view.selected ? (
                <SectionCard as="section" aria-label="Selected cell">
                  <SectionHead title="Selected cell" aside={scopeLabel(matrix, query)} />
                  <div className="cl-form-body">
                    {view.selected.present ? (
                      <>
                        <p className="cl-coverage-line"><b><Fraction numerator={view.selected.numerator} denominator={view.selected.denominator} /></b> catalogued instruments here are dual-verified.</p>
                        <p className="cl-coverage-line">This cell has its own address. Copy the page address to share exactly this view.</p>
                      </>
                    ) : (
                      <RequestableCoverageState state="not_covered" variant="block" subject={scopeLabel(matrix, query).slice(0, 100)} reason={view.selected.validAxes ? "Nothing has been catalogued in this cell yet." : "This combination is not in the catalogue."} requestRef={here} />
                    )}
                  </div>
                </SectionCard>
              ) : null}
            </>
          )}
        </div>
      </PageFrame>
    </div>
  );
}
