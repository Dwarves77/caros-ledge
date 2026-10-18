// The two fonts, vendored (IMP-063): the same woff2 files the old tree's @fontsource packages carried, served from public/fonts through next/font/local, so a build depends on no font CDN and on no font npm package.
// Each family is declared twice, latin and latin-ext, as two font faces named in the font stack in this order: the browser takes a character from the first face that has the glyph, which is what the packages' unicode-range
// split did, so a place name with its accents still sets in the real font. Licences (SIL OFL 1.1) sit beside the files. next/font needs each loader call written out at module scope with literal arguments, hence four calls. adjustFontFallback is off so a variable names only its own face: a character the latin face lacks falls to the latin-ext face, not to a metric-adjusted Arial.
import localFont from "next/font/local";

const jakarta = localFont({
  src: [
    { path: "../../public/fonts/plus-jakarta-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/plus-jakarta-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../../public/fonts/plus-jakarta-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../../public/fonts/plus-jakarta-sans-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "../../public/fonts/plus-jakarta-sans-latin-800-normal.woff2", weight: "800", style: "normal" },
  ],
  display: "swap",
  adjustFontFallback: false,
  variable: "--font-jakarta",
});
const jakartaExt = localFont({
  src: [
    { path: "../../public/fonts/plus-jakarta-sans-latin-ext-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/plus-jakarta-sans-latin-ext-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../../public/fonts/plus-jakarta-sans-latin-ext-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../../public/fonts/plus-jakarta-sans-latin-ext-700-normal.woff2", weight: "700", style: "normal" },
    { path: "../../public/fonts/plus-jakarta-sans-latin-ext-800-normal.woff2", weight: "800", style: "normal" },
  ],
  display: "swap",
  adjustFontFallback: false,
  variable: "--font-jakarta-ext",
});
const anton = localFont({ src: [{ path: "../../public/fonts/anton-latin-400-normal.woff2", weight: "400", style: "normal" }], display: "swap",
  adjustFontFallback: false, variable: "--font-anton" });
const antonExt = localFont({ src: [{ path: "../../public/fonts/anton-latin-ext-400-normal.woff2", weight: "400", style: "normal" }], display: "swap",
  adjustFontFallback: false, variable: "--font-anton-ext" });

/** The class names that define --font-jakarta, --font-jakarta-ext, --font-anton and --font-anton-ext on the root element (src/ui/theme.css builds --font-sans and --font-display from them). */
export const fontClassNames = [jakarta, jakartaExt, anton, antonExt].map((f) => f.variable).join(" ");
