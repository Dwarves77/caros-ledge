// Ported from old_repo/src/lib/detail/section-index-data.ts (lines 1-86)
// The fixed-ordinal section index. An ordinal belongs to its section and never moves: a section the item does not have is omitted, never renumbered (operator ruling 2026-10-07).
// The ten sections the page drew keep their ordinals; the eight fact-document sections it never drew (1, 2, 5, 6, 7, 9, 12, 13) gain entries S11 to S18 (DESIGN CHANGES OWED: artboard 03 draws ten).
import type { SectionIndexEntry } from "@/ui/SectionIndex";

export const CONNECTED_SECTION_ID = "across-pages";
export const INFERENCES_SECTION_ID = "inferences";

/** Every section of the regulation page, in page order, with its fixed ordinal. `key` names the fact-document section a stored row feeds (absent for the page's own sections). */
export const SECTION_INDEX: ReadonlyArray<SectionIndexEntry & { key?: string }> = [
  { id: "summary", shortName: "Summary", ord: 1 },
  { id: "obligations", shortName: "Obligations", ord: 2, key: "3" },
  { id: "requirements", shortName: "Requirements", ord: 3, key: "8" },
  { id: "registration", shortName: "Registration", ord: 4, key: "10" },
  { id: "operations", shortName: "Operations", ord: 5, key: "11" },
  { id: "compliance", shortName: "Compliance", ord: 6, key: "4" },
  { id: "purpose", shortName: "Purpose", ord: 11, key: "1" },
  { id: "what-it-is", shortName: "What it is", ord: 12, key: "2" },
  { id: "guidance", shortName: "Guidance", ord: 13, key: "5" },
  { id: "pending-events", shortName: "Pending", ord: 14, key: "6" },
  { id: "thresholds", shortName: "Thresholds", ord: 15, key: "7" },
  { id: "product-status", shortName: "Products", ord: 16, key: "9" },
  { id: "exemptions", shortName: "Exemptions", ord: 17, key: "12" },
  { id: "alternatives", shortName: "Alternatives", ord: 18, key: "13" },
  { id: "penalties", shortName: "Penalties", ord: 7 },
  { id: "sources", shortName: "Sources", ord: 8 },
  { id: CONNECTED_SECTION_ID, shortName: "Connected", ord: 9 },
  { id: INFERENCES_SECTION_ID, shortName: "Inferences", ord: 10 },
];

/** The ordinal of a section the other detail surfaces share (Connected and Inferences follow their own page's last section). */
export function crossPageOrd(surface: string, id: typeof CONNECTED_SECTION_ID | typeof INFERENCES_SECTION_ID): number {
  if (surface === "regulations") return (SECTION_INDEX.find((e) => e.id === id)?.ord ?? 0);
  return id === CONNECTED_SECTION_ID ? 7 : 8;
}

/** The index of a page: the entries whose ids are present, in page order, with their fixed ordinals. */
export const indexFor = (present: ReadonlySet<string>): SectionIndexEntry[] => SECTION_INDEX.filter((e) => present.has(e.id)).map(({ id, shortName, ord }) => ({ id, shortName, ...(ord !== undefined ? { ord } : {}) }));
