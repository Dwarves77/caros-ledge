// Ported from old_repo/scripts/lib/canonical-key.mjs (lines 3-24)
// The canonical key of an EU instrument from its instrument identifier or its source URL: a CELEX number (with its OJ sequence suffix), or one built from an ELI path. Null when neither carries one.
const ELI_TYPE: Record<string, string> = { reg: "R", dir: "L", dec: "D" };

const upper = (m: RegExpMatchArray | null): string | null => (m ? (m[1] ?? "").toUpperCase() : null);
const withSuffix = (m: RegExpMatchArray | null): string | null => (m ? `${(m[1] ?? "").toUpperCase()}(${(m[2] ?? "").padStart(2, "0")})` : null);
const fromEli = (m: RegExpMatchArray | null): string | null => (m ? `3${m[2]}${ELI_TYPE[m[1] ?? ""]}${(m[3] ?? "").padStart(4, "0")}` : null);

export function deriveKey(identifier: string | null | undefined, sourceUrl: string | null | undefined): string | null {
  const i = identifier ?? "";
  const u = sourceUrl ?? "";
  return (
    withSuffix(i.match(/([1-9]\d{4}[A-Z]\d{4})\((\d{1,2})\)/)) ??
    upper(i.match(/([1-9]\d{4}[A-Z]\d{4})/)) ??
    fromEli(i.match(/^eli\/(reg|dir|dec)\/(\d{4})\/(\d+)/)) ??
    withSuffix(u.match(/CELEX(?::|%3[Aa])?([1-9]\d{4}[A-Z]\d{4})(?:\(|%28)(\d{1,2})(?:\)|%29)/)) ??
    upper(u.match(/CELEX(?::|%3[Aa])?([1-9]\d{4}[A-Z]\d{4})/)) ??
    fromEli(u.match(/\/eli\/(reg|dir|dec)\/(\d{4})\/(\d+)/)) ??
    null
  );
}
