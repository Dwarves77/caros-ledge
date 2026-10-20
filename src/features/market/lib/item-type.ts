// New in R2d: the ONE customer word for each of the twelve stored item types (register surfaces:20). A list row's meta line printed the stored code ("research_finding", "market_signal") and, for an item
// with no type, the placeholder "uncertain"; a type the table does not hold draws nothing. `rowMeta` is the meta line the surface lists draw until core/lists' metaLine takes the same table.
import { z } from "zod";

import raw from "./data/item-type.json";

const ITEM_TYPE_LABEL: Readonly<Record<string, string>> = Object.freeze(z.record(z.string(), z.string().min(1)).parse(raw));

export const itemTypeLabel = (stored: string | null | undefined): string | null => (typeof stored === "string" && Object.hasOwn(ITEM_TYPE_LABEL, stored) ? (ITEM_TYPE_LABEL[stored] as string) : null);

/** The meta line of a list row: the type's word, the modes and the topic, in that order, whichever are present. */
export const rowMeta = (r: { type?: string | null | undefined; modes?: readonly string[] | undefined; topic?: string | undefined }): string => [itemTypeLabel(r.type), r.modes?.length ? r.modes.join(", ") : null, r.topic].filter(Boolean).join(" · ");
