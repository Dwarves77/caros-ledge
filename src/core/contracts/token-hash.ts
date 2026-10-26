// New in VALID-1: the one hash of a token. The tree never holds a name it must forbid: tree-checks keeps the operator's name as this hash, and the brief validator keeps the workspace and client names as this hash.
import { createHash } from "node:crypto";

/** SHA-256 (hex) of the lowercase text. */
export const tokenHash = (text: string): string => createHash("sha256").update(text.toLowerCase()).digest("hex");
