// @ts-check
/**
 * Phase 5 performance scaffolding — DASHBOARD TTI via Lighthouse CI.
 *
 * Target metric (§1.9 roadmap): dashboard Time-To-Interactive ≤ 3500 ms on a
 * simulated mid-tier device so fleet managers on Addis office Wi‑Fi get a
 * usable map+panels quickly. Run against the PRODUCTION build served by
 * `vite preview` (NOT dev server — dev HMR inflates every number).
 *
 * This repo pins no lighthouse dependency (offline sandbox constraint); run
 * it ad-hoc with npx, e.g.:
 *
 *   cd web-dashboard && npm ci && npm run build && \
 *   npx --yes vite preview --port 4173 & \
 *   npx --yes lighthouse http://127.0.0.1:4173 \
 *     --config-path ../backend/scripts/perf/lighthouse.tti.cjs \
 *     --only-audits interactive,first-contentful-paint,total-blocking-time,cumulative-layout-shift \
 *     --output=json --output-path=.lighthouse-tti.json \
 *     --chrome-flags="--headless=new"
 *
 * …then assert with:
 *   node -e "const r=require('./web-dashboard/.lighthouse-tti.json');const v=a=>r.audits[a].numericValue;console.log('TTI',v('interactive'));process.exit(v('interactive')<=3500&&v('cumulative-layout-shift')<=0.1?0:1)"
 *
 * Budgets encoded below (Lighthouse budgets.json semantics):
 *   TTI                     <= 3500 ms
 *   FCP                     <= 1800 ms
 *   TBT                     <=  300 ms
 *   CLS                     <=  0.10
 *   main bundle (script)    <=  350 KB   (leaflet+react+app, gzipped transfer)
 *   total page weight       <=  800 KB
 * Offline-first note: sw.js caches the app shell, so a SECOND load should be
 * dramatically faster; this config measures the FIRST cold load (no SW cache),
 * which is the honest worst case for the register checkbox.
 */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    onlyAudits: [
      'interactive',
      'first-contentful-paint',
      'total-blocking-time',
      'cumulative-layout-shift',
      'largest-contentful-paint',
      'speed-index',
    ],
    formFactor: 'desktop',
    screenEmulation: { disabled: true },
    throttlingMethod: 'provided', // LAN baseline; override with 'simulated' + CPU/multiplier for field proxy
  },
  budgets: [
    {
      path: 'http://127.0.0.1:4173/',
      timings: [
        { metric: 'interactive', budget: 3500 },
        { metric: 'first-contentful-paint', budget: 1800 },
        { metric: 'total-blocking-time', budget: 300 },
        { metric: 'cumulative-layout-shift', budget: 0.1 },
      ],
      resourceSizes: [
        { resourceType: 'script', budget: 350 /* KB transfer */ },
        { resourceType: 'total', budget: 800 },
      ],
    },
  ],
};
