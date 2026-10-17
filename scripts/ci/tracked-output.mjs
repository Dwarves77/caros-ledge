// Machine output is never tracked (rule: machine evidence is not source). Given the tracked paths, returns the problems:
// a file under a generated-output directory or a generated file, and a tracked binary outside the allowlisted homes.
export const GENERATED_DIRS = ["parity-capture/", "parity-diff/", "parity-baseline/", "parity-artifact/", "results-artifact/"];
export const GENERATED_FILES = ["parity-report.txt", "next-start.log", "test-output.txt"];
export const BINARY_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "pdf", "zip"];
// The legitimate homes of tracked binaries: the committed parity baseline (signed-out routes only) and the public assets.
export const BINARY_HOMES = ["tests/parity/baseline/", "public/"];

export function trackedOutputProblems(paths) {
  const problems = [];
  for (const f of paths) {
    if (GENERATED_DIRS.some((d) => f.startsWith(d)) || GENERATED_FILES.includes(f)) problems.push(`${f}:1: generated output is tracked (it belongs in .gitignore)`);
    else if (BINARY_EXTENSIONS.includes(f.split(".").pop().toLowerCase()) && !BINARY_HOMES.some((h) => f.startsWith(h))) problems.push(`${f}:1: tracked binary outside ${BINARY_HOMES.join(" and ")}`);
  }
  return problems;
}
