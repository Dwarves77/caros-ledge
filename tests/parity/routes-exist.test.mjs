// Every route the parity capture and the production screenshots visit must exist in the app: the dashboard was listed at /dashboard (a 404 the frame-only gate compared as if it were the page) while it lives at /.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const routes = JSON.parse(readFileSync('tests/parity/routes.json', 'utf8')).routes;

test('every fixed path in routes.json is served by a page file under src/app', () => {
  for (const route of routes.filter((r) => r.path)) {
    const segments = route.path.split(/[?#]/)[0].split('/').filter(Boolean);
    assert.ok(existsSync(join('src/app', ...segments, 'page.tsx')), `${route.name}: ${route.path} has no src/app page (it would capture a 404)`);
  }
});

test('every discovered route names a list route that exists', () => {
  for (const route of routes.filter((r) => r.discover)) {
    const segments = route.discover.list.split(/[?#]/)[0].split('/').filter(Boolean);
    assert.ok(existsSync(join('src/app', ...segments, 'page.tsx')), `${route.name}: list ${route.discover.list} has no src/app page`);
  }
});
