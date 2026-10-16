// Ported from old_repo/src/components/shared/GfmSection.tsx (lines 1-198)
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type HastNode = { type?: string; tagName?: string; value?: string; children?: HastNode[] };
type WithChildren = ReactElement<{ children?: ReactNode }>;

const hastText = (node: HastNode | undefined): string => (!node ? "" : node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(hastText).join(""));

function tableHeaderLabels(table: HastNode | undefined): string[] {
  const thead = (table?.children ?? []).find((c) => c.tagName === "thead");
  const row = (thead?.children ?? []).find((c) => c.tagName === "tr");
  return (row?.children ?? []).filter((c) => c.tagName === "th" || c.tagName === "td").map((c) => hastText(c).replace(/\s+/g, " ").trim());
}

// Each cell learns its column header so the phone reflow (a stacked card per row, base.css) can print "label: value".
function labelCells(sections: ReactNode, headers: string[]): ReactNode {
  return Children.map(sections, (section) => {
    if (!isValidElement(section)) return section;
    const rows = Children.map((section as WithChildren).props.children, (row) => {
      if (!isValidElement(row)) return row;
      let col = 0;
      const cells = Children.map((row as WithChildren).props.children, (cell) => {
        if (!isValidElement(cell)) return cell;
        const label = headers[col] ?? "";
        col += 1;
        return cloneElement(cell as ReactElement<{ dataLabel?: string }>, { dataLabel: label });
      });
      return cloneElement(row as WithChildren, undefined, cells);
    });
    return cloneElement(section as WithChildren, undefined, rows);
  });
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="cl-gfm-p">{children}</p>,
  table: ({ children, node }) => (
    <div className="cl-gfm-tablewrap">
      <table className="cl-table-cards cl-gfm-table">{labelCells(children, tableHeaderLabels(node as HastNode | undefined))}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th className="cl-gfm-th" style={style}>
      {children}
    </th>
  ),
  td: (props) => {
    const { children, style, dataLabel } = props as typeof props & { dataLabel?: string };
    return (
      <td data-label={dataLabel ?? ""} className="cl-gfm-td" style={style}>
        {children}
      </td>
    );
  },
  ul: ({ children }) => <ul className="cl-gfm-p cl-gfm-ul">{children}</ul>,
  ol: ({ children }) => <ol className="cl-gfm-p cl-gfm-ol">{children}</ol>,
  li: ({ children }) => <li className="cl-gfm-li">{children}</li>,
  h1: ({ children }) => <h4 className="cl-gfm-sub">{children}</h4>,
  h2: ({ children }) => <h4 className="cl-gfm-sub">{children}</h4>,
  h3: ({ children }) => <h5 className="cl-gfm-sub">{children}</h5>,
  h4: ({ children }) => <h5 className="cl-gfm-sub">{children}</h5>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="cl-gfm-a">
      {children}
    </a>
  ),
  code: ({ children }) => <code className="cl-gfm-code">{children}</code>,
  blockquote: ({ children }) => <blockquote className="cl-gfm-p cl-gfm-quote">{children}</blockquote>,
  hr: () => <hr className="cl-gfm-hr" />,
};

/**
 * The one markdown renderer: GFM with tables that reflow to stacked cards on the phone. The markdown arrives already stripped of claim-ledger blocks by
 * its reader (the kit imports no intake code); an empty string renders nothing.
 */
export function GfmSection({ markdown, source }: { markdown: string; source?: string | null }) {
  if (!markdown || !markdown.trim()) return null;
  return (
    <div>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {markdown}
      </ReactMarkdown>
      {source && <p className="cl-gfm-source">Source: {source}</p>}
    </div>
  );
}
