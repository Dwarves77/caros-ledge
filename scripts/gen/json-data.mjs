// The one way a generator writes a JSON data file (IMP-051): the text is parsed back and must equal the value, and no string in it may carry a control character (the two regex data files that shipped with invalid escapes
// would have failed here, not in a test). Usage: writeJsonData("path.json", value, 1)
import { writeFileSync } from "node:fs";

const CONTROL = /[\u0000-\u001f]/;
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]) : []);

/** The JSON text for a value, proven to parse back to the same value with no control character in any string or key. */
export function renderJsonData(value, indent = 1) {
  const text = `${JSON.stringify(value, null, indent)}\n`;
  if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(value)) throw new Error("json-data: the text does not parse back to the value it was made from");
  const bad = strings(value).find((s) => CONTROL.test(s));
  if (bad !== undefined) throw new Error(`json-data: a string carries a control character: ${JSON.stringify(bad).slice(0, 80)}`);
  return text;
}

export function writeJsonData(path, value, indent = 1) {
  writeFileSync(path, renderJsonData(value, indent));
}
