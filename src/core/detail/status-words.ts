// The status token of an inference in the words a customer reads (INV-272): a customer never reads CONFIRMED or HYPOTHESIS as code. No imports, so a client component can read it.
const STATUS_WORDS: Readonly<Record<string, string>> = { CONFIRMED: "Confirmed", HYPOTHESIS: "Hypothesis", REFUTED: "Refuted" };
/** The word for a token, or null for a token this table does not know (nothing is drawn for it). */
export const statusWord = (token: string | null | undefined): string | null => (token ? (STATUS_WORDS[token] ?? null) : null);
