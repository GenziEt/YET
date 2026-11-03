/* eslint-env serviceworker */
/**
 * Phase 5 (D) — YET dashboard service worker: last-known-good fleet-state cache.
 *
 * PDPP posture (§1.7): the SW caches ONLY the aggregated fleet-state snapshot, in
 * IndexedDB (bigger than localStorage's ~5MB cap and structured-clone native), and
 * only while a manager session is active. It never caches raw fixes, driver
 * profiles, or report windows — those are per-request audited reads server-side.
 * On reload with no network, the operator sees the freshest snapshot they already
 * had access to, clearly stamped with its generated_at time (honest staleness, §1.4).
 *
 * Strategy: network-first for GET /reports/fleet-state; every successful response
 * is written to IDB as the "last known good". Offline/reload then serves the
 * cached copy with `sw_served_from: 'indexeddb'` injected so the UI can label it.
 * Everything else passes through untouched (no blanket app-shell caching yet —
 * tiles are large and Phase 6 will decide their offline policy).
 */

const DB_NAME = 'yet-dashboard';
const STORE = 'fleet_state';
const KEY = 'last_known_good';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const rq = tx.objectStore(STORE).get(KEY);
    rq.onsuccess = () => resolve(rq.result ?? null);
    rq.onerror = () => reject(rq.error);
  });
}

self.addEventListener('install', (event) => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/* Wipe the cached snapshot when the app signs out (privacy: stale personal data
   must not survive session end on shared machines). */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'YET_CLEAR_CACHE') {
    event.waitUntil(
      openDb().then((db) =>
        new Promise((resolve) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(KEY);
          tx.oncomplete = resolve;
          tx.onerror = resolve;
        }),
      ),
    );
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only intercept the fleet-state aggregate read; same-origin proxy path /api/...
  // or direct API base both end in /reports/fleet-state.
  if (event.request.method !== 'GET' || !url.pathname.endsWith('/reports/fleet-state')) return;

  event.respondWith(
    fetch(event.request)
      .then(async (res) => {
        if (res.ok) {
          try {
            const json = await res.clone().json();
            await idbPut(json); // write-through last known good
          } catch { /* non-JSON (error page) — leave previous snapshot intact */ }
        }
        return res;
      })
      .catch(async () => {
        const cached = await idbGet();
        if (cached) {
          return new Response(JSON.stringify({ ...cached, sw_served_from: 'indexeddb' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: 'offline_no_snapshot' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }),
  );
});
