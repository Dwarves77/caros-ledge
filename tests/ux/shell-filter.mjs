// The ONE shell filter for every smoke that compares a fixture render with tests/parity/baseline. The shell's controls are declared once, in tests/parity/approved-changes.json
// (`frameControls`, the same list the parity gate's frame routes use); shell parts come from src/ui/shell (AppShell: the platform nav, account menu, back-to-top, the signed-in notifications bell).
// A fixture draws the page without the shell, so the baseline is cut to the page: its shell controls are dropped. The search box of the page frame (the combobox and its Ask button) is shell chrome too.
const SEARCH_CHROME = ['^combobox:Search or ask', '^button:Ask$'];

/** Returns `isShell(control)`: true when a baseline control (`{role, name}`) is shell chrome. A trailing count in the name ("Watchlist3") is ignored, as the gate ignores it. */
export function shellControl(config) {
  const res = [...config.frameControls, ...SEARCH_CHROME].map((re) => new RegExp(re));
  return (c) => res.some((re) => re.test(`${c.role}:${c.name.replace(/(?<=[A-Za-z])[\d,]+$/, '')}`));
}
