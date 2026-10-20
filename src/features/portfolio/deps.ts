// Ported from old_repo/src/lib/portfolio/read.ts (lines 20-60)
// The cross-slice members the portfolio reads need (deps.portfolio of P2-02's workspace handlers), built from the merged exports: the held rows, a corridor's "A to B" label, the weakest origin class.
// `portfolioDeps(db)` takes the client of the reader asking: the pages pass the caller's own, the startup wiring passes the service client for the API route.
import type { Db } from "@/core/db";
import { weakestOriginClass } from "@/core/contracts";
import { formatCorridorLabel, parseCorridorName } from "@/core/entities";
import type { PortfolioDeps } from "@/features/workspace/portfolio/types";

import { readHeld } from "./read/held";

const corridorLabel = (canonicalName: string): string | null => {
  const p = parseCorridorName(canonicalName);
  return p ? formatCorridorLabel({ origin: p.origin, dest: p.dest, mode: p.mode }) : null;
};

export const portfolioDeps = (db: Db): PortfolioDeps => ({ heldItems: (orgId, uuids, now) => readHeld(db, orgId, uuids, now), corridorLabel, weakestOriginClass: (classes) => weakestOriginClass(classes) });
