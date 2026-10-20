// New in the clean-room tree (UI-1 U3): the phone form of a row's source-bias chips, as data so it renders on the server and the tests read it without a browser.
import { biasChips, type BiasTagInput } from "@/core/sources";

/** Characters one phone meta line holds at 11 px under the title, beside the jurisdiction code (measured at 375: the narrowest line is 207 px, about 36 characters; the budget keeps a margin so a label is never cut). */
const META_LINE_BUDGET = 34;
const SEPARATOR = 3;
const COUNT_ROOM = 5;

/**
 * The bias labels that fit one meta line after `used` characters already on it (an absence reason, a grade chip), as whole labels in confidence order, then "+N" for every tag not named.
 * A label that does not fit is dropped whole, never cut: the count says how many went.
 */
export function biasSummary(tags: BiasTagInput[] | null | undefined, used = 0): string[] {
  const all = biasChips(tags, 2);
  const parts: string[] = [];
  let length = used;
  for (const chip of all.shown) {
    const next = length + (length > 0 ? SEPARATOR : 0) + chip.label.length;
    const hiddenAfter = all.total - parts.length - 1;
    if (next + (hiddenAfter > 0 ? COUNT_ROOM : 0) > META_LINE_BUDGET) break;
    parts.push(chip.label);
    length = next;
  }
  const hidden = all.total - parts.length;
  const count = `+${hidden}`;
  // The count is drawn only when it fits too: a line that cannot hold it stays one line, whole.
  return hidden > 0 && length + (length > 0 ? SEPARATOR : 0) + count.length <= META_LINE_BUDGET ? [...parts, count] : parts;
}
