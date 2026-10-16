// Ported from old_repo/scripts/lib/canonical-key.mjs (lines 1-24)
// The canonical key of an EU instrument from its instrument identifier or its source URL: a CELEX number (with its OJ sequence suffix), or one built from an ELI path. Null when neither carries one.
const ELI_TYPE: Record<string, string> = { reg: "R", dir: "L", dec: "D" };
const CELEX = "([1-9]\d{4}[A-Z]\d{4})";

export function deriveKey(identifier: string | null | undefined, sourceUrl: string | null | undefined): string | null {
  const i = identifier ?? "";
  const u = sourceUrl ?? "";
  const suffixed = (m: RegExpMatchArray | null) => (m ? `${(m[1] ?? "").toUpperCase()}(${(m[2] ?? "").padStart(2, "0")})` : null);
  const bare = (m: RegExpMatchArray | null) => (m ? (m[1] ?? "").toUpperCase() : null);
  const eli = (m: RegExpMatchArray | null) => (m ? `3${m[2]}${ELI_TYPE[m[1] ?? ""]}${(m[3] ?? "").padStart(4, "0")}` : null);
  return (
    suffixed(i.match(new RegExp(`${CELEX}\((\d{1,2})\)`))) ??
    bare(i.match(new RegExp(CELEX))) ??
    eli(i.match(/^eli\/(reg|dir|dec)\/(\d{4})\/(\d+)/)) ??
    suffixed(u.match(new RegExp(`CELEX(?::|%3[Aa])?${CELEX}(?:\(|%28)(\d{1,2})(?:\)|%29)`))) ??
    bare(u.match(new RegExp(`CELEX(?::|%3[Aa])?${CELEX}`))) ??
    eli(u.match(/\/eli\/(reg|dir|dec)\/(\d{4})\/(\d+)/)) ??
    null
  );
}
