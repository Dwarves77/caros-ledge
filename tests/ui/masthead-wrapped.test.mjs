// A masthead is a card: drawn outside a padded wrapper it runs edge to edge of the scroll box (the Regulatory map's did, 2026-10-18: the card touched both edges while every other page's was inset 40 px).
// Every <Masthead in src/ is opened inside a wrapper that carries the page gutter, or is on this short list with its reason.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import test from 'node:test';

const GUTTER = /className=(?:"cl-list-surface-masthead"|"cl-detail-mast"|\{styles\.(?:head|stack)\})/;
const EXEMPT = new Map([
  ['src/features/dashboard/ui/DashboardMasthead.tsx', 'a component: its callers wrap it in cl-list-surface-masthead'],
  ['src/features/admin/ui/parts/PartsGallery.tsx', 'drawn inside the gallery column'],
]);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (path.endsWith('.tsx')) yield path;
  }
}

test('every Masthead is drawn inside a gutter wrapper', () => {
  const offenders = [];
  for (const file of files('src')) {
    const path = file.split(sep).join('/');
    if (path === 'src/ui/Masthead.tsx' || EXEMPT.has(path)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/<Masthead\b/.test(line)) return;
      if (!GUTTER.test(lines.slice(Math.max(0, i - 2), i).join('\n'))) offenders.push(`${path}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `a Masthead with no gutter wrapper: ${offenders.join(', ')}`);
});
