// New in R2d: the ONE customer word for each of the twelve stored item types (register surfaces:20). A list row printed the stored code ("research_finding", "market_signal") and, for an item with no type, the placeholder "uncertain";
// a type the table does not hold draws nothing.
import { z } from "zod";

import raw from "./data/item-type.json";

const ITEM_TYPE_LABEL: Readonly<Record<string, string>> = Object.freeze(z.record(z.string(), z.string().min(1)).parse(raw));

export const itemTypeLabel = (stored: string | null | undefined): string | null => (typeof stored === "string" && Object.hasOwn(ITEM_TYPE_LABEL, stored) ? (ITEM_TYPE_LABEL[stored] as string) : null);
