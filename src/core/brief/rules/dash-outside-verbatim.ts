// New in VALID-1: R1 (V01): an em or en dash in the prose view (outside «...» runs and FACT claim text).
import { textRule } from "./_text";

export default textRule("dash-outside-verbatim", "dash");
