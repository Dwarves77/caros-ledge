// New in VALID-1: R2 (V02): the workspace or a named client is written in the brief. The names are held as hashes (data/workspace-names.json), never in clear.
import { nameAt, violation } from "./_text";
import type { Rule } from "./types";

const rule: Rule = (b) => {
  const at = nameAt(b.body);
  return at < 0 ? null : violation("workspace-or-client-named", "a workspace or client name is written in the brief", b.body.slice(Math.max(0, at - 20)));
};
export default rule;
