Read `docs/COORDINATOR-STATUS.md` in full, then run `git status -s` and `git log -n 10 --oneline` to load the current repository state, recent commits, LOC headroom, and prioritized backlog.

After reading `docs/COORDINATOR-STATUS.md`:
1. Summarize the current branch state, HEAD commit, LOC headroom (`src` and `src/core`), and the prioritized next items from Section 3 of `docs/COORDINATOR-STATUS.md`.
2. If the operator gave a specific instruction alongside `coordinator`, execute it immediately while respecting all invariants in `GEMINI.md` and `docs/COORDINATOR-STATUS.md`.
3. Whenever you complete a batch or commit new work, update `docs/COORDINATOR-STATUS.md` so the next `coordinator` invocation sees the latest state.
