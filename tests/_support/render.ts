// Render a real component (a .tsx source, loaded through the test hooks) to static markup, inside the contexts the app router would provide: a router that goes nowhere, the pathname and the search params.
// A client effect never runs here, so what renders is the first paint: exactly what the server sends.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

export function renderApp(element: ReactElement, opts: { path?: string; search?: string } = {}): string {
  const tree = createElement(
    AppRouterContext.Provider,
    { value: router as never },
    createElement(PathnameContext.Provider, { value: opts.path ?? "/" }, createElement(SearchParamsContext.Provider, { value: new URLSearchParams(opts.search ?? "") as never }, element)),
  );
  return renderToStaticMarkup(tree);
}
/** The text a reader sees: tags dropped, entities decoded, whitespace folded. */
export const textOf = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
