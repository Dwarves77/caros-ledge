// A throwaway parity world for the compare tests: a routes.json, a config, a baseline directory and a capture directory, written to a temp dir, with records built the way capture.mjs writes them.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CAPTURE_CONTRACT } from './contract.mjs';
import { encodePng } from './png.mjs';

export const VIEWPORTS = ['1280x900', '375x812'];

/** One capture record: everything compare reads, with a healthy default for each field. */
export function record(over = {}) {
  return {
    landmarks: [{ role: 'main', name: '', source: 'implicit' }],
    headings: [{ level: 1, text: 'Regulations' }],
    controls: [{ role: 'link', name: 'Open' }],
    rows: { selector: '[data-part="list-row"]', items: [], containers: [] },
    document_height: 900,
    truncated: false,
    offences: [],
    ...over,
  };
}

/** A solid-colour image of the given size. */
export const solid = (width, height, [r, g, b]) => {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) rgba.set([r, g, b, 255], i * 4);
  return encodePng({ width, height, rgba });
};

export const listRow = (text, height = 56) => ({ tag: 'div', text, width: 600, height });

/**
 * Writes a world and returns its paths. `routes` are {name, auth?}; `config` overrides the default config; `records(name, viewport)` gives the record both sides hold unless `base`/`cap` are given.
 * `captureRoutes` is the capture index's route list (default: every route captured ok); `baselineRoutes` likewise for the baseline index.
 */
export function world({ routes, config = {}, base = {}, cap = {}, baseIndex = {}, capIndex = {}, baseRoutes, capRoutes, records = () => record() }) {
  const dir = mkdtempSync(join(tmpdir(), 'parity-'));
  const baseline = join(dir, 'baseline');
  const captured = join(dir, 'captured');
  mkdirSync(baseline);
  mkdirSync(captured);
  const write = (path, value) => writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`);
  const names = routes.map((r) => r.name);
  const full = config.gates?.full ?? names;
  write(join(dir, 'routes.json'), { routes: routes.map((r) => ({ path: `/${r.name}`, auth: false, ...r })) });
  write(join(dir, 'approved-changes.json'), {
    exempt: [],
    skippable: [],
    listEmpty: [],
    frameControls: [],
    frameLandmarks: {},
    frameHeadings: [],
    dataNames: [],
    approved: [],
    ...config,
    gates: { full, frame: [], pixelExact: [], lists: [], ...config.gates },
  });
  const entries = (list, status) => list.map((name) => ({ name, path: `/${name}`, status, files: status === 'ok' ? VIEWPORTS.map((v) => `${name}.${v}`) : [], error: null }));
  write(join(baseline, 'index.json'), { contract: CAPTURE_CONTRACT, routes: baseRoutes ?? entries(names, 'ok'), ...baseIndex });
  write(join(captured, 'index.json'), { contract: CAPTURE_CONTRACT, routes: capRoutes ?? entries(names, 'ok'), ...capIndex });
  for (const name of names) {
    for (const v of VIEWPORTS) {
      write(join(baseline, `${name}.${v}.json`), { ...records(name, v), ...base });
      write(join(captured, `${name}.${v}.json`), { ...records(name, v), ...cap });
    }
  }
  return { dir, baseline, captured, config: join(dir, 'approved-changes.json'), routes: join(dir, 'routes.json'), diffDir: join(dir, 'diff'), write };
}
