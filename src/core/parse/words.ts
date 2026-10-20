// Whole-word matching for prose (R2a P3): a word is matched as a word, never as a piece of a longer one ("cost" is not in "costume", "SB-261" is not in
// "SB-2610"). The stop words that carry no topic are data (./data/stopwords.json), so a slot description's "with" and "that" cannot make every sentence cover it.
import { z } from "zod";

import stopFile from "./data/stopwords.json";
import { escapeRe } from "./data";

const file = z.object({ minLetters: z.number().int().positive(), stopwords: z.array(z.string().min(1)) }).parse(stopFile);
const STOP = new Set(file.stopwords);
const WORD = new RegExp(`\\p{L}{${file.minLetters},}`, "gu");

/** The distinctive words of a text: lower-case, at least the data's minimum letters, not a stop word. */
export const contentWords = (text: string): Set<string> => new Set((String(text ?? "").toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)));

/** `word` occurs in `text` as a whole word (or whole phrase), ignoring case. */
export const hasWord = (text: string, word: string): boolean => word !== "" && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word)}(?![\\p{L}\\p{N}])`, "iu").test(text);
