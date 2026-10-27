// The HTML whitespace entities a capture keeps in its stored text (&nbsp;, &#160;, &#xA0;) and the U+00A0 character: ONE definition, read as a plain space by every formal matcher (date grammar, findFigures,
// stated, locateSpan). Matching reads a folded COPY; the stored capture text and the quote a reader stores are never changed, so hashes and exact spans stay valid. Offsets of a folded copy are not capture offsets.
export const HTML_SPACE_ALT = "&nbsp;|&#160;|&#[xX][aA]0;|\\u00a0";
const HTML_SPACE = new RegExp(HTML_SPACE_ALT, "g");
export const foldHtmlSpace = (text: string): string => text.replace(HTML_SPACE, " ");
