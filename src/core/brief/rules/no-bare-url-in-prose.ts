// New in VALID-1: R22 (V14): no URL in the prose outside the Sources section and the citation lines the renderer consumes (*Source: ... lines).
import { patternsOf, violation } from "./_text";
import type { Rule } from "./types";

const [url, sources, cite] = [patternsOf("url")[0] as RegExp, patternsOf("sources-section")[0] as RegExp, patternsOf("source-line")[0] as RegExp];
const rule: Rule = (b) => {
  const text = b.body.replace(sources, "").split("\n").filter((l) => !cite.test(l)).join("\n");
  const m = url.exec(text);
  return m ? violation("no-bare-url-in-prose", `URL in prose: ${m[0].slice(0, 60)}`, text.slice(Math.max(0, m.index - 20))) : null;
};
export default rule;
