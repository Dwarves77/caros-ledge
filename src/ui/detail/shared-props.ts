// Ported from old_repo/src/components/detail/shared-props.ts (lines 1-17)
// The props every detail surface passes its body. The three watch props the old type carried were never supplied by any caller and are not carried over.
import type { ConnectionRow } from "@/core/flywheel/view-model";
import type { ItemRelevance } from "@/core/workspace";

import type { CrossPageData } from "./CrossPageSection";

export interface DetailSurfaceSharedProps {
  /** The masthead connection rows (connections and supersessions), built by the loader. */
  connectionRows?: ConnectionRow[];
  relevance?: ItemRelevance | null;
  crossPage?: CrossPageData | null;
}
