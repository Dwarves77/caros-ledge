// Ported from old_repo/src/components/ui/ActionRow.tsx (lines 169-223)
// Share and export, each returning the result the caller shows ("Link copied", "Copy failed"); the old helpers failed silently (B-0205, B-1527).
import type { Resource } from "@/core/types";

export type ShareResult = "shared" | "copied" | "failed";

type ShareNav = Navigator & { share?: (data: ShareData) => Promise<void>; clipboard?: { writeText: (s: string) => Promise<void> } };

async function copy(text: string, nav: ShareNav): Promise<ShareResult> {
  if (!text || typeof nav.clipboard?.writeText !== "function") return "failed";
  try {
    await nav.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

/** Native share, falling back to the clipboard; a dismissed native sheet is not a failure, a failed copy is reported. */
export async function shareResource(r: Pick<Resource, "title" | "note" | "whatIsIt">): Promise<ShareResult> {
  if (typeof window === "undefined") return "failed";
  const nav = window.navigator as ShareNav;
  const url = window.location.href;
  if (typeof nav.share === "function") {
    try {
      await nav.share({ title: r.title, text: r.note || r.whatIsIt || r.title, url });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "shared";
    }
  }
  return copy(url, nav);
}

/** The brief as a Markdown Blob download (never the clipboard API); the file name is returned so the caller can say what was saved. */
export function downloadMarkdownBrief(r: Pick<Resource, "id" | "title" | "fullBrief" | "whatIsIt" | "whyMatters" | "note">, opts: { metaRows: Array<string | null>; filenamePrefix: string }): string | null {
  if (typeof window === "undefined") return null;
  const meta = opts.metaRows.filter(Boolean).join("\n");
  const body = r.fullBrief || [r.whatIsIt, r.whyMatters].filter(Boolean).join("\n\n") || r.note || "(No briefing body recorded.)";
  const slug = (r.id || opts.filenamePrefix).toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const name = `${opts.filenamePrefix}-${slug || "brief"}.md`;
  const url = URL.createObjectURL(new Blob([`# ${r.title}\n\n${meta ? `${meta}\n\n` : ""}${body}\n`], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return name;
}
