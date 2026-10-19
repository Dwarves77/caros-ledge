// What the parity capture and the parity compare agree on, written once.
//
// CAPTURE_CONTRACT is the version of the record capture.mjs writes. A baseline written under another version cannot be compared with a capture (the fields mean different things), so compare.mjs
// fails the run and names the recapture instead of printing a screenful of differences that are not differences. Bump it whenever a field of the record changes meaning.
//   1  rows were the first 20 of `[data-row], li, tr, article`; a landmark's name was the text inside it; the screenshot was the first viewport
//   2  rows are every `[data-part="list-row"]` and `[data-part="table-row"]`, counted per container; a landmark's name is its aria-label; the screenshot is the whole page; each record carries
//      `truncated` and the offences the layout measure found
export const CAPTURE_CONTRACT = 2;

/** The parts that are one row of a list: the list row (ListRow) and the table row (RowTable). A row part carries its name in `data-part`; nothing else is a row. */
export const ROW_PARTS = ['list-row', 'table-row'];
export const ROW_SELECTOR = ROW_PARTS.map((part) => `[data-part="${part}"]`).join(', ');

/** The two widths every route is captured at. */
export const CAPTURE_VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 375, height: 812 },
];

/** The tallest a screenshot is allowed to be; a page taller than this is recorded `truncated` and fails the compare. */
export const SCREEN_MAX_HEIGHT = 16000;
