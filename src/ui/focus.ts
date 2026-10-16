// Ported from old_repo/src/components/ui/tagPopoverKeyboard.ts (lines 1-87)
// Ported from old_repo/src/components/ui/commandBarKeyboard.ts (lines 1-87)
// Pure index moves the overlay parts share: Tab trapping, arrow roving and clamped listbox moves. The DOM reads live in the parts.

/** The index Tab lands on inside a trap of `count` focusables; `current` is -1 when focus is outside the trap. */
export function trapIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

/** Roving arrow move that wraps (menus, tab rows). */
export function wrapIndex(count: number, current: number, delta: number): number {
  return count <= 0 ? -1 : (((current + delta) % count) + count) % count;
}

/** Listbox arrow move that clamps at both ends (the command bar). */
export function clampIndex(count: number, current: number, delta: number): number {
  return count <= 0 ? -1 : Math.max(0, Math.min(count - 1, current + delta));
}

export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
