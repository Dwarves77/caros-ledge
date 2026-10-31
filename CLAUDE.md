# Caro's Ledge — Claude Code Coordinator & Sub-Agent Mandate

## 0. The Supreme Product Law: Connected Context for Non-Expert Freight Readers
Caro's Ledge (`carosledge.com`) is NOT a database dump, regulatory citation index, or wall of isolated statistics. Its entire reason to exist is **connected operational context for freight forwarders, fleet operators, and shippers who have ZERO background in sustainability**.

Every coordinator session and every sub-agent lane MUST enforce these 5 rules without exception:
1. **No Naked Numbers or Contextless Rows:** Never render a bare fuel price, battery Wh/kg, state tax rate, deadline, or item title and expect the reader to figure out why it matters. Every customer surface (`Dashboard`, `Regulations`, `Market Intel`, `Operations`, `Research`, and all Detail views) must visibly show:
   - **What it is** in plain operational terms (`what_is_it` / verbatim facts);
   - **Why it matters** to a freight operator's cost, compliance, operations, and client relationships (`why_matters` + 4-dimension `0..3` impact breakdown + reasoning);
   - **What it changes and when** (`what_it_changes`, key data thresholds, pending triggers, recalculated figures);
   - **How the Flywheel connects it across all 4 parts** (the 20 ways a signal ripples across Regulations, Market prices/roadmaps/reroutes, Operations corridors/queues/costs, and Research technologies/abatement).
2. **Causal Freight Explanations — Never Database Tag Sentences:**
   - Replacing `"Bound by shared scenario · 0.69"` with `"Both items share the drayage scenario and battery-electric-trucks object"` is still database jargon and is **forbidden** as a customer explanation.
   - Every connection, theme brief, pattern, and developing connection must explain the **real-world causal mechanism** across parts (e.g., how a mandate or carbon price changes freight surcharge math, fleet TCO parity, corridor routing, or grid/supply bottlenecks).
   - "Developing Connections" must frame real-world operational convergences forming across parts (economic/abatement crossover, mandate vs. capacity/grid collision, cross-modal feedstock spillover, and which surface is the next expected link)—never "missing a scenario tag."
3. **Structured Data Tables Are First-Class Flywheel Citizens:**
   - The flywheel is NOT just `intelligence_items`-to-`intelligence_items`.
   - Every live metric in `market_series` / `series_observations`, `corridor_carbon_intensity`, `oem_tech_roadmaps`, `reroute_events`, `grid_connection_queues`, `state_cost_facts`, `regional_operational_facts`, and `statutory_computations` must join through `entity_refs` and `entity_relations` so that viewing a price move or operational metric immediately shows its coupled Regulations, Operations corridors, and Research technologies.
4. **"Done" Means Visible in the Rendered Browser DOM (Verified via Playwright):**
   - Backend rows written to `integrity_flags`, `signposts`, `inference_records`, `derived_values`, or `item_cross_references` that do not render on customer pages count as **0% done**.
   - Never merge a code lane that hides or invalidates existing customer context (e.g., re-clustering themes or raising a theme-brief overlap gate) before the companion content/brief lane (`THEME-1` / `drain`) has authored the replacement briefs. Code and content that depend on each other must ship together so the live customer page never blanks out.
5. **End-to-End Ownership Over Narrow Sub-Agent Silos:**
   - Sub-agents must never optimize for passing a narrow unit test or shrinking LOC at the expense of human-readable context on the page. Before any UI or flywheel PR merges, verify the actual rendered DOM in Playwright across all affected surfaces.

## Coordinator Trigger (`coordinator` / `/coordinator`)
Whenever the operator types `coordinator` or `/coordinator` (or asks for the current status / handoff):
1. Immediately read this file (`CLAUDE.md`) and `docs/COORDINATOR-STATUS.md` in full.
2. Run `git status -s` and `git log -n 10 --oneline` to verify the latest commits on `main`.
3. Report the current state and prioritized next tasks from `docs/COORDINATOR-STATUS.md`, evaluating every task against **Section 0 (The Supreme Product Law)** above.
4. Whenever you land new commits, update `docs/COORDINATOR-STATUS.md` so it stays the single source of truth across sessions.

## Operating Mandate & Hard Invariants
Follow all architectural and engineering rules in `GEMINI.md`:
- **Zero Metered Dependencies:** Everything runs on the free tier. Never introduce paid APIs or metered third-party services.
- **Strict Boundaries:** Do not alter existing interface boundaries, schema contracts, or module layouts. One home per mechanism.
- **Verbatim Provenance:** Facts exist only as verbatim character spans bound to captured source paragraphs from licence-cleared publishers.
- **Stated Absences:** Never mask missing data, unread inputs, or failed reads as `0`, empty lists, or hidden UI slots. Always render an explicit stated absence or failure state with retry.
- **The Turn Contract:** Nothing runs standalone. Every stage has an explicit caller and downstream, logs to the ledger, and halts downstream execution on failure.
- **LOC Ceilings & CI Gates:** Keep `src` and `src/core` within their ceilings and verify changes with `node scripts/ci/gates.mjs --profile fast` (and signed-in Playwright DOM inspection for any customer-facing or flywheel change).
