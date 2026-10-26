// The turn CLI's stage input as JSON text: `--input` (inline) or `--input-file` (a path), never both. A batch over ~128 KB cannot travel as one argv string (Linux E2BIG), so a ruled run hands it over as a file.
import { readFileSync } from "node:fs";

/** `values` is parseArgs's result. Throws a sentence the CLI prints. */
export function turnInputText(values, read = (p) => readFileSync(p, "utf8")) {
  const file = values["input-file"];
  if (file !== undefined && values.input !== undefined) throw new Error("give --input or --input-file, not both");
  if (file === undefined) return values.input ?? "{}";
  try {
    return read(file);
  } catch (e) {
    throw new Error(`--input-file ${file} is unreadable: ${e.message}`);
  }
}
