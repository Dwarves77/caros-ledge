"use client";

// New in P2-10: the client frame of a regulation page. It makes the ONE relevance request of the page and hands the answer to both of its readers (the relevance card and the binding banner);
// the obligation register and the corridors strip arrive as server-rendered children.
import type { ComponentProps, ReactNode } from "react";

import { NoticesRail } from "@/ui/figures";

import { BindingBanner } from "./BindingBanner";
import { RegulationDetail } from "./RegulationDetail";
import { useItemRelevance } from "./useItemRelevance";

type Body = Omit<ComponentProps<typeof RegulationDetail>, "relevance">;

export function DetailView({ children, ...body }: Body & { children?: ReactNode }) {
  const relevance = useItemRelevance(body.resource.id);
  return (
    <>
      <RegulationDetail {...body} relevance={relevance} />
      <BindingBanner relevance={relevance} retry={relevance.retry} />
      {children}
      <NoticesRail />
    </>
  );
}
