// New in VALID-1: R28 (V29): topic_tags are in the seven-value vocabulary and at most the contract's cap.
import { CAPS, TOPIC_TAGS } from "../contract";

import { violation } from "./_text";
import type { Rule } from "./types";

const rule: Rule = (_b, i) => {
  const out = i.topic_tags.filter((t) => !TOPIC_TAGS.includes(t));
  const over = i.topic_tags.length > CAPS.topicTags;
  return out.length || over ? violation("topic-tags-vocabulary-and-cap", [out.length ? `outside the vocabulary: ${out.join(", ")}` : "", over ? `${i.topic_tags.length} tags, cap ${CAPS.topicTags}` : ""].filter(Boolean).join("; "), i.topic_tags.join(", ")) : null;
};
export default rule;
