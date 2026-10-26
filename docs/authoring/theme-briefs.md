# theme-briefs: the editorial brief of a connection theme

A theme is a cluster of connected items. A session writes its brief from the theme's live members; the kit checks it against the same members and the seam writes it.

## Export, author, apply

1. Export: `--input '{"briefs":{"export":{"kind":"theme-briefs","outDir":"<dir outside the repo>","limit":15,"charBudget":120000}}}'`. Per theme: `theme_id`, `member_hash` (echo it), `needs` (`no_brief`, `stale`, `superseded`), the gaps, the intra-theme edges and the members (summary, grounded FACT claims with `claim_id`, forward events with `event_id`). What the budget cuts is counted in `truncation`. Each bundle also carries `packets`, the pattern packet of the theme (the part's `summary` states what the packets door could not serve; a theme no live pattern touches has an empty packet); every statement of a cross-surface brief cites a member row, and a brief whose rows come from one table or one surface is residue.
2. Author `theme-briefs-NNN` and apply it as `batch.content`:

```json
{ "theme_id": "<id>", "member_hash": "<echo>", "title": "<160 characters at most, no id>",
  "sections": { "connection": "...", "meaning": "...", "ramifications": "### Regulations\n...", "watch": "...", "gaps": "..." },
  "claims": [ { "section": "connection", "text": "<text that appears in that section>", "member_id": "<a live member>", "claim_ids": ["<grounded claim ids of that member; forward event ids in watch>"] } ] }
```

A single brief is also accepted as `batch.content`: `{ theme_id, title, brief_md, member_hash }` as JSON, or as markdown with a `---` frontmatter block (`theme_id`, `title`, `member_hash`) followed by the body (`format: "md"`).

## Rules (INV-191)

- `member_hash` must equal the hash of the theme's LIVE membership; a brief authored against stale membership is refused.
- Sections `connection`, `meaning`, `ramifications` and `watch` are required; ceilings 2000, 2500, 5000, 3000 and 1500 (`gaps`) characters; no ids in any section.
- `ramifications` has one `### <Surface>` subsection per surface the theme spans (Regulations, Market Intel, Research, Operations), none for a surface it does not span, none empty.
- Every number or acronym of three or more capitals is inside a listed claim's text, a labelled analysis paragraph (`*Analytical inference:*`, `*Operational implication:*`, `*Legal Confirmation Required:*`), a heading, a member title, a gap description or a token the intra-theme edges name. A fact written without digits or an acronym is not detected: that limit is stated, not hidden.
- Each claim's text appears in its section; its `member_id` is a live member; its claim ids are that member's grounded claims.
- If the bundle lists gaps, the `gaps` section is not empty.

- The second reader: the entry carries `review` (`{ reviewed_by, judges }`) answering every judge that applies to a theme brief, pass or fail with evidence; a failed judge, a missing verdict or a brief whose cited rows sit in one table or on one surface is residue naming the reason (INV-DIG-7). The bundle carries `candidate_entities`, the menu of entities the members are filed under.

## What the apply does

The seam checks the hash again and writes the `theme_briefs` row (one row per theme) with `sections`, `claims` and the sorted member ids; the stored hash and batch name are read back. A re-apply writes nothing new. A replaced brief is superseded by the member hash; no prior-row copy is kept.
