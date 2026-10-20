// New in the clean-room tree (UI-1 U8): the masthead's next-obligation clause. The title is the link to the item, cut at 48 characters with an ellipsis so the subtitle never spills a whole title; the full title is the link's tooltip.
import Link from "next/link";

export const NEXT_TITLE_MAX = 48;

export const cutTitle = (title: string): string => (title.length > NEXT_TITLE_MAX ? `${title.slice(0, NEXT_TITLE_MAX).trimEnd()}…` : title);

export function NextObligationLine({ label, title, href }: { label: string; title: string; href: string }) {
  return (
    <>
      {" · next obligation "}
      {label.replace(/, \d{4}$/, "")}
      {" · "}
      <Link href={href} title={title} className="cl-dek-link">
        {cutTitle(title)}
      </Link>
    </>
  );
}
