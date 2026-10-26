// The title a list row draws: the formal act head of an EU instrument ("Implementing Regulation (EU) 2023/2122"), taken from the leading words of the stored title. The words are the act-type vocabulary in data/act-heads.json and
// the numbers and dates are the title's own characters; no sentence is written here (ADR-050, ADR-053 decision 2: a formal code has a grammar). A title with no recognisable head is returned as stored, and the detail page keeps the full title.
import { z } from "zod";

import heads from "./data/act-heads.json";

const H = z.object({ issuers: z.array(z.string()), qualifiers: z.array(z.string()), types: z.array(z.string()), legalBases: z.array(z.string()), numberWord: z.string(), dateJoiner: z.string(), months: z.array(z.string()) }).parse(heads);

const words = (list: readonly string[]): string => [...list].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|");
const LEAD = `(?:(${words(H.issuers)})\\s+)?(?:(${words(H.qualifiers)})\\s+)?(${words(H.types)})`;
const LB = words(H.legalBases);
const NUM = `(?:(${H.numberWord})\\.?\\s+)?`;
// Bracketed basis: "(EU) 2023/2122", "(EC) No 1272/2008". Basis suffix: "2008/50/EC", "No 377/2013/EU". Number first: "2001/118/EC: Commission Decision". No number: "Commission Decision of 15 December 2022".
const BRACKETED = new RegExp(`^\\s*${LEAD}\\s+\\((${LB})\\)\\s+${NUM}(\\d+/\\d+)(?![\\d/])`, "i");
const SUFFIXED = new RegExp(`^\\s*${LEAD}\\s+${NUM}(\\d{2,4}/\\d+/(?:${LB}))(?!\\w)`, "i");
const NUMBER_FIRST = new RegExp(`^\\s*(\\d{2,4}/\\d+/(?:${LB})):\\s*${LEAD}\\b`, "i");
const DATED = new RegExp(`^\\s*${LEAD}\\s+${H.dateJoiner}\\s+(\\d{1,2})\\s+(${words(H.months)})\\s+(\\d{4})\\b`, "i");

const canon = (list: readonly string[], found: string | undefined): string | undefined => (found === undefined ? undefined : list.find((w) => w.toLowerCase() === found.replace(/\s+/g, " ").toLowerCase()));
const join = (...parts: (string | undefined)[]): string => parts.filter(Boolean).join(" ");
/** "2008/50/ec" -> "2008/50/EC": the basis suffix in the vocabulary's own spelling. */
const withBasis = (number: string): string => number.replace(/\/([a-z]+)$/i, (_, b: string) => `/${canon(H.legalBases, b)}`);

/** The formal act head of `title`, or `title` itself when it has none. */
export function displayTitle(title: string): string {
  const qual = (m: RegExpMatchArray, at = 2): string | undefined => canon(H.qualifiers, m[at]);
  const type = (m: RegExpMatchArray, at = 3): string | undefined => canon(H.types, m[at]);
  let m = BRACKETED.exec(title);
  if (m) return join(qual(m), type(m), `(${canon(H.legalBases, m[4])})`, m[5] ? H.numberWord : undefined, m[6]);
  m = SUFFIXED.exec(title);
  if (m) return join(qual(m), type(m), m[4] ? H.numberWord : undefined, withBasis(m[5]!));
  m = NUMBER_FIRST.exec(title);
  if (m) return join(qual(m, 3), type(m, 4), withBasis(m[1]!));
  m = DATED.exec(title);
  if (m) return join(canon(H.issuers, m[1]), qual(m), type(m), H.dateJoiner, m[4], canon(H.months, m[5]), m[6]);
  return title;
}
