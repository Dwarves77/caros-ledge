// Ported from old_repo/src/lib/sources/verify-item.mjs (lines 1-151)
// Ported from old_repo/src/lib/sources/cheap-verify.mjs (lines 1-64)
// Ported from old_repo/src/lib/sources/holdings-gate.mjs (lines 1-34)
const SNAPSHOT_STUB_MAX = 1000;
/** One thin pool row is absence; two or more content-bearing pool rows is presence. */
const MIN_USABLE_POOL_ROWS = 2;
/** Are usable holdings present? A real (non-stub) snapshot, or two or more content-bearing pool rows. Absence is the ONLY state that admits a fetch. */
export const holdingsPresent = ({ snapshotBytes = 0, usablePoolRows = 0 }: { snapshotBytes?: number; usablePoolRows?: number } = {}): boolean => Number(snapshotBytes) > SNAPSHOT_STUB_MAX || Number(usablePoolRows) >= MIN_USABLE_POOL_ROWS;
