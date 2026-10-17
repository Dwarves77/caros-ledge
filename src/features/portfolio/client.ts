"use client";

// Ported from old_repo/src/lib/portfolio/client.ts (lines 16-56)
import { authedFetch } from "@/core/http/authed-fetch";

export interface PortfolioCallResult<T = unknown> {
  ok: boolean;
  status: number;
  error?: string;
  body?: T;
}

/** One call to the portfolio routes: it never throws, a refusal carries the server's own message, and a reply that cannot be read is a stated failure (the old call turned a malformed 200 into a silent success). */
async function call<T>(path: string, method: string, payload?: Record<string, unknown>): Promise<PortfolioCallResult<T>> {
  try {
    const res = await authedFetch(path, { method, ...(payload ? { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) } : {}) });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) return { ok: false, status: res.status, error: res.status === 401 ? "Sign in again to continue." : body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "That did not go through. Try again." };
    if (body === undefined) return { ok: false, status: res.status, error: "The reply could not be read. Reload the page to see the current state." };
    return { ok: true, status: res.status, body: body as T };
  } catch {
    return { ok: false, status: 0, error: "The network request failed. Check your connection and try again." };
  }
}

const BASE = "/api/workspace/portfolios";
const at = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
export type MemberInput = { itemId?: string; entityId?: string };

export const createPortfolioRequest = (name: string) => call<{ portfolio: { id: string; name: string }; existed: boolean }>(BASE, "POST", { name });
export const renamePortfolioRequest = (id: string, name: string) => call(at(id), "PATCH", { name });
export const deletePortfolioRequest = (id: string) => call(at(id), "DELETE");
export const addMemberRequest = (id: string, member: MemberInput) => call<{ existed: boolean }>(`${at(id)}/members`, "POST", member);
export const removeMemberRequest = (id: string, member: MemberInput) => call(`${at(id)}/members`, "DELETE", member);
