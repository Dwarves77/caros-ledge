# Caro's Ledge — Claude Code Coordinator Instructions

## Coordinator Trigger (`coordinator` / `/coordinator`)
Whenever the operator types `coordinator` or `/coordinator` (or asks for the current status / handoff):
1. Immediately read `docs/COORDINATOR-STATUS.md` in full.
2. Run `git status -s` and `git log -n 10 --oneline` to verify the latest commits on `main`.
3. Report the current state and prioritized next tasks from `docs/COORDINATOR-STATUS.md` (or begin executing the top priority item if requested).
4. Whenever you land new commits, update `docs/COORDINATOR-STATUS.md` so it stays the single source of truth across sessions.

## Operating Mandate & Hard Invariants
Follow all architectural and engineering rules in `GEMINI.md`:
- **Zero Metered Dependencies:** Everything runs on the free tier. Never introduce paid APIs or metered third-party services.
- **Strict Boundaries:** Do not alter existing interface boundaries, schema contracts, or module layouts. One home per mechanism.
- **Verbatim Provenance:** Facts exist only as verbatim character spans bound to captured source paragraphs from licence-cleared publishers.
- **Stated Absences:** Never mask missing data, unread inputs, or failed reads as `0`, empty lists, or hidden UI slots. Always render an explicit stated absence or failure state with retry.
- **The Turn Contract:** Nothing runs standalone. Every stage has an explicit caller and downstream, logs to the ledger, and halts downstream execution on failure.
- **LOC Ceilings & CI Gates:** Keep `src` (`<= 66,291` LOC) and `src/core` (`<= 20,428` LOC) within their ceilings and verify changes with `node scripts/ci/gates.mjs --profile fast`.
