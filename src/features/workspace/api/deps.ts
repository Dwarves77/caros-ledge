import type { PortfolioDeps } from "../portfolio/types";

export interface NotifyInput {
  userId: string;
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * What the workspace handlers call into slices that are not merged here. P2-08 (turn) wires them once at startup; a member that is
 * not wired is never faked: the handler reports it (a notification counted as failed, a bootstrap field listed as degraded).
 */
export interface WorkspaceDeps {
  /** P1-07 dispatchNotification: resolves to an error message, or null when it delivered. */
  notify: (input: NotifyInput) => Promise<string | null>;
  /** The canonical detail-page href of an item (the item-links owner). */
  itemHref: (item: { id: string; type: string | null; domain: number | null }) => string;
  /** Invalidate the workspace data cache tag after an override or personal-state write (P1-07 cache tags). */
  revalidateWorkspaceData: () => void;
  /** P1-18 getNavCounts for the signed-in request. */
  navCounts: () => Promise<unknown>;
  /** P1-26 attention counts, asked only for a platform admin. */
  adminAttention: (userId: string) => Promise<unknown>;
  /** P1-07 timePhase: names one phase of the Server-Timing header. */
  timePhase: <T>(phase: string, run: () => Promise<T>) => Promise<T>;
  /** P1-07 withServerTiming: attaches the Server-Timing header to the response. */
  withServerTiming: (response: Response) => Response;
  /** The portfolio detail read's cross-slice pieces. */
  portfolio: PortfolioDeps;
}

let wired: Partial<WorkspaceDeps> = {};

export function wireWorkspaceDeps(deps: Partial<WorkspaceDeps>): void {
  wired = { ...wired, ...deps };
}

export function workspaceDeps(): Partial<WorkspaceDeps> {
  return wired;
}
