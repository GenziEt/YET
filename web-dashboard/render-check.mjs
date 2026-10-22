/**
 * YET Phase 0 gate check — "The web dashboard displays a map without errors."
 *
 * Prereq: python3 infra/scripts/serve-dev-stack.py 8099   (serves dist/ + /tiles/z/x/y.png)
 * Run:    node render-check.mjs
 *
 * jsdom cannot execute Vite's `type="module"` output, so this harness re-bundles the
 * SOURCE entry with esbuild to an IIFE classic script and boots it inside the served
 * HTML shell. Everything else is the real production path: React renders FleetMap,
 * Leaflet requests tiles over HTTP from the self-hosted tile endpoint, OSM attribution
 * renders. Asserts boot + map panes + tile imgs + attribution + zero runtime errors.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8099';
const errors = [];
const tmp = mkdtempSync(join(tmpdir(), 'yet-render-'));

// Bundle source -> single classic script (same deps as production build).
execSync(
  `npx esbuild src/main.tsx --bundle --format=iife --outfile=${tmp}/app.js ` +
  `--loader:.css=empty --define:import.meta.env='{"MODE":"production","DEV":false,"PROD":true,"VITE_TILE_URL":"/tiles/{z}/{x}/{y}.png"}' --define:process.env.NODE_ENV='"production"'`,
  { stdio: 'inherit' }
);

// Fetch the served index.html, strip the module script tag, inline our IIFE instead.
const res = await fetch(BASE + '/');
if (!res.ok) { console.error('dev stack not reachable at ' + BASE); process.exit(1); }
let html = await res.text();
html = html.replace(/<script type="module"[^>]*><\/script>/, '<script>/*injected*/</script>');

const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + String(e.message).slice(0, 200)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 200)));

const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc });
const win = dom.window;
win.addEventListener('error', e => errors.push('window.onerror: ' + e.message));
// Canvas 2d stub: Leaflet renderer calls getContext('2d'); jsdom has no native canvas here.
win.HTMLCanvasElement.prototype.getContext = function () {
  const noop = () => {};
  return new Proxy({ canvas: this }, { get: (t, k) => (k === 'canvas' ? t.canvas : k === 'measureText' ? () => ({ width: 0 }) : noop) });
};
win.eval(readFileSync(`${tmp}/app.js`, 'utf8'));

await new Promise(r => setTimeout(r, 5000)); // React boot -> lazy FleetMap -> Leaflet init -> tile img loads

const doc = win.document;
const tileImgs = [...doc.querySelectorAll('img')].filter(i => (i.getAttribute('src') || '').includes('/tiles/'));
const checks = {
  'react app booted (#root populated)': (doc.getElementById('root')?.children.length ?? 0) > 0,
  'leaflet-container rendered': !!doc.querySelector('.leaflet-container'),
  'leaflet-map-pane present': doc.querySelectorAll('.leaflet-map-pane').length > 0,
  'tile <img> elements requested from /tiles/': tileImgs.length > 0,
  'OSM attribution visible': doc.body.innerHTML.includes('OpenStreetMap'),
  // Popup content is lazily rendered by Leaflet only when opened; assert the marker exists instead.
  'demo marker element rendered': doc.querySelectorAll('.leaflet-marker-icon').length > 0,
  'zero runtime/console errors': errors.length === 0,
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
if (errors.length) console.log(errors.slice(0, 6).join('\n'));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
