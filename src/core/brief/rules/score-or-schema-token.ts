// New in VALID-1: R5 (V10): a score, rating or schema name in customer text.
import { textRule } from "./_text";

export default textRule("score-or-schema-token", "score-schema");
