Read `CLAUDE.md` (especially Section 0: The Supreme Product Law) and `docs/COORDINATOR-STATUS.md` in full, then run `git status -s` and `git log -n 10 --oneline` to load the current repository state, recent commits, LOC headroom, and prioritized backlog.

After reading `CLAUDE.md` and `docs/COORDINATOR-STATUS.md`:
1. Summarize the current branch state, HEAD commit, LOC headroom (`src` and `src/core`), and the prioritized next items from Section 3 of `docs/COORDINATOR-STATUS.md`.
2. Enforce Section 0 of `CLAUDE.md` across every lane and wave:
   - Never ship or declare "done" on backend-only rows that do not visibly render plain-English causal freight context in the customer browser DOM (verified via Playwright).
   - Never substitute database tag sentences ("Both items share scenario X") or "missing tag" notes for real-world causal freight explanations across Regulations, Market, Operations, and Research.
   - Connect all structured data tables (`market_series`, `corridor_carbon_intensity`, `oem_tech_roadmaps`, `reroute_events`, `grid_connection_queues`, `state_cost_facts`, `statutory_computations`) into the flywheel alongside `intelligence_items`.
   - Never merge a code lane that hides or invalidates existing customer context (e.g., re-clustering or theme overlap gates) before its companion brief/content lane (`THEME-1` / `drain`) is ready to ship with it.
3. Whenever you complete a batch or commit new work, update `docs/COORDINATOR-STATUS.md` so the next `coordinator` invocation sees the latest state.
