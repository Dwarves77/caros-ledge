// New in VALID-1: R23 (V15): an HTML entity in the prose view.
import { textRule } from "./_text";

export default textRule("no-html-entity-outside-spans", "entity");
