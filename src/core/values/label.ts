// Ported from old_repo/src/lib/spec09/label.mjs (lines 1-50)
// Spec 09 labels: a value is statutory, an estimate, or M (missing, with a stated reason). Never a zero-fill, never a guessed bucket.
import { DERIVATION } from "@/core/contracts";

export type Spec09Label = "statutory" | "estimate" | "M";
export const SPEC09_LABELS: readonly Spec09Label[] = Object.freeze(["statutory", "estimate", "M"] as const);

/** Bucket a `derivation` into statutory or estimate; an unknown or absent derivation is "M", never guessed into either. */
export function spec09Label(derivation: string | null | undefined): Spec09Label {
  const entry = derivation == null ? null : DERIVATION[derivation];
  if (!entry) return "M";
  return entry.statutory === true ? "statutory" : "estimate";
}

export const isStatutoryLabel = (derivation: string | null | undefined): boolean => spec09Label(derivation) === "statutory";

export type Labelled<V, E extends object = Record<string, never>> = Readonly<{ label: Spec09Label; derivation: string | null; value: V } & E>;

/** A labelled value. A null or undefined value must go through `missing(reason)`: a coarse M needs a stated reason. */
export function labelled<V, E extends object = Record<string, never>>(value: V, derivation: string | null, extra?: E): Labelled<V, E> {
  if (value === null || value === undefined) throw new TypeError("labelled(): a null or undefined value must go through missing(reason); a coarse M needs a stated reason.");
  return Object.freeze({ label: spec09Label(derivation), derivation, value, ...(extra ?? ({} as E)) });
}

/** The explicit M result; the reason is required and non-empty ("never zero-fill... a missing emission factor is M, never 0"). */
export function missing<E extends object = Record<string, never>>(reason: string, extra?: E): Readonly<{ label: "M"; derivation: null; value: null; reason: string } & E> {
  if (!reason || typeof reason !== "string" || !reason.trim()) throw new TypeError("missing(): a reason string is required; an unexplained M is the silent-absence failure this module prevents.");
  return Object.freeze({ label: "M" as const, derivation: null, value: null, reason, ...(extra ?? ({} as E)) });
}
