// Ported from old_repo/src/app/not-found.tsx (lines 11-75)
import { ButtonLink } from "@/ui";

/** The honest 404: the copy the old page used, with a 44 px link. */
export default function NotFound() {
  return (
    <div className="cl-notfound">
      <p className="cl-notfound-kicker">{"404 — Not found"}</p>
      <h1 className="cl-notfound-title">This page doesn&apos;t exist</h1>
      <p className="cl-notfound-text">The link may be outdated, or the item it points to is not published.</p>
      <ButtonLink href="/" prefetch={false}>
        Back to Dashboard
      </ButtonLink>
    </div>
  );
}
