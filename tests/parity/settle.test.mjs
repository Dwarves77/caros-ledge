// LIST-SETTLE-1 D3: a capture that did not settle is a failure that names itself (INV-LS-5), and settle() says what it was still waiting for.
import assert from 'node:assert/strict';
import test from 'node:test';

import { settle } from './capture.mjs';
import { compareRun } from './compare.mjs';
import { record, VIEWPORTS, world } from './world.mjs';

const ROUTES = [{ name: 'home' }, { name: 'regulations', auth: 'member' }];
const entry = (name, over = {}) => ({ name, path: `/${name}`, status: 'ok', files: VIEWPORTS.map((v) => `${name}.${v}`), error: null, ...over });
const run = (w) => compareRun({ captured: w.captured, baseline: w.baseline, config: w.config, routes: w.routes, diffDir: w.diffDir });

test('INV-LS-5: a route whose capture says settled:false fails with the capture reason, and none of its controls, rows or headings is compared', async () => {
  const reason = '375x812: list state loading after 60 s';
  const w = world({ routes: ROUTES, records: () => record({ controls: [{ role: 'link', name: 'All 1,002 monitor' }] }), capRoutes: [entry('home'), entry('regulations', { settled: false, settle_reason: reason })] });
  w.write(`${w.captured}/regulations.375x812.json`, record({ controls: [], headings: [], rows: { selector: '', items: [], containers: [] } }));
  const r = await run(w);
  const text = r.lines.join('\n');
  assert.equal(r.failed, true);
  assert.match(text, /FAIL +regulations: the capture did not settle, so nothing of it is compared: 375x812: list state loading after 60 s/);
  assert.doesNotMatch(text, /control missing|heading missing|row missing/);
  assert.match(text, /compared 1 of 2 gated routes/);
});

// A page stub: waitForLoadState answers per call (true = idle, false = times out), waitForFunction answers once (listed = the list state settled).
const page = ({ idle = [true, true], listed = true } = {}) => {
  const waits = [...idle];
  return {
    waitForLoadState: async () => (waits.shift() ? undefined : Promise.reject(new Error('timeout'))),
    waitForFunction: async () => (listed ? undefined : Promise.reject(new Error('timeout'))),
  };
};

test('settle waits for network idle, then the list state, then idle again, and names what it was still waiting for', async () => {
  const budgets = { network: 20000, list: 60000 };
  assert.deepEqual(await settle(page(), () => [], budgets), { settled: true, reason: null });
  assert.deepEqual(await settle(page({ listed: false }), () => [], budgets), { settled: false, reason: 'list state loading after 60 s' });
  assert.deepEqual(await settle(page({ idle: [true, false] }), () => ['https://db.example'], budgets), { settled: false, reason: 'network busy after 20 s: https://db.example' });
  assert.deepEqual(await settle(page({ idle: [false, true] }), () => [], budgets), { settled: true, reason: null }, 'a first idle that failed and a list that then settled is settled');
});
