/*! sw-cache-kit-advanced v3.0.0 | MIT | Author: Rafal Masiarek <rafal@masiarek.pl> */

/* ===============================
   CONFIG (runtime & URL-configurable)
   =============================== */

const SW_VERSION = 'v3.0.0';

// Runtime-tunable knobs (can be overridden via URL params or _sw-config.json)
let CACHE_SEED = 'seed-0001';
let DOMAIN_WHITELIST = [];         // [] => allow all; otherwise exact host match
let APPLY_SEED_TO_NETWORK = false; // if true, append seed to outbound fetch for stable cache keys at proxies
let FALLBACK_URL = null;           // optional HTML fallback URL when network fails
let ACCEPT_KEY = false;            // include hashed Accept header into cache key (per content-negotiation)
let IMG_CACHE_NAME = 'sw-img-cache';
let FONT_CACHE_NAME = 'sw-fonts-cache';
let LRU_MAX = 3000;                // per-cache entry cap (simple FIFO trim)
let DEFAULT_MANIFEST = null;       // URL to JSON array of assets for seeding when body.manifest missing
let PRELOAD = [];                  // array of URLs to pre-fetch on install
let PRECONNECT = [];               // array of origins to preconnect (no-op hint; kept for parity)
let BLACKLIST = [];                // array of regex strings – if path matches, skip caching

// Single API entrypoint prefix (scoped by SW scope)
const SW_API_PREFIX = '/__sw-api/';

// Optional API guard
const SW_SECRET = null; // e.g., random string; if set, POST /seed|/purge requires header x-sw-secret

// Debug logging
const DEBUG = false;

/* ===============================
   CONSTANTS / UTILS
   =============================== */

// What we consider "static"
const STATIC_EXT_RE = /(\.(png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|eot)(\?.*)?)$/i;
const IMG_EXT_RE = /(\.(png|jpe?g|webp|avif|gif|svg|ico)(\?.*)?)$/i;
const FONT_EXT_RE = /(\.(woff2?|ttf|otf|eot)(\?.*)?)$/i;

const log = (...a) => DEBUG && console.log('[SW]', ...a);

// Prometheus-like counters
const METRICS = {
  hit: 0,
  miss: 0,
  revalidate_ok: 0,
  revalidate_fail: 0,
  seed_ok: 0,
  seed_fail: 0,
  purge_ok: 0,
  purge_fail: 0
};

// Small in-memory ring log for debugging
const LOG_RING = [];
const LOG_RING_MAX = 200;
function ring(msg) {
  LOG_RING.push(`[${new Date().toISOString()}] ${msg}`);
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
}

// Lightweight broadcast to client pages (optional)
const BC = 'sw-cache-events';
function bcSend(type, payload) {
  try {
    const c = new BroadcastChannel(BC);
    c.postMessage({ type, payload });
    c.close();
  } catch (_) { }
}

// Param parsers
function parseBool(v) { return v === '1' || v === 'true' || v === 'yes'; }
function parseCSV(v) { return v.split(',').map(s => s.trim()).filter(Boolean); }
function parseList(v, sep = ';') { return v.split(sep).map(s => s.trim()).filter(Boolean); }

/* ===============================
   DYNAMIC CONFIG LOADERS
   =============================== */

async function loadUrlParams() {
  try {
    const sp = new URL(self.location.href).searchParams;
    const seed = sp.get('seed');
    const allow = sp.get('allow');
    const apply = sp.get('apply');
    const fallback = sp.get('fallback');
    const acceptKey = sp.get('acceptKey');
    const imgCacheName = sp.get('imgCache');
    const fontCacheName = sp.get('fontCache');
    const lruMax = sp.get('lruMax');
    const manifest = sp.get('manifest');
    const preload = sp.get('preload');
    const preconnect = sp.get('preconnect');
    const blacklist = sp.get('blacklist');

    if (seed) CACHE_SEED = seed;
    if (allow) DOMAIN_WHITELIST = parseCSV(allow);
    if (apply !== null) APPLY_SEED_TO_NETWORK = parseBool(apply);
    if (fallback) FALLBACK_URL = decodeURIComponent(fallback);
    if (acceptKey !== null) ACCEPT_KEY = parseBool(acceptKey);
    if (imgCacheName) IMG_CACHE_NAME = imgCacheName;
    if (fontCacheName) FONT_CACHE_NAME = fontCacheName;
    if (lruMax) LRU_MAX = Math.max(100, parseInt(lruMax, 10) || LRU_MAX);
    if (manifest) DEFAULT_MANIFEST = manifest;
    if (preload) PRELOAD = parseCSV(preload);
    if (preconnect) PRECONNECT = parseCSV(preconnect);
    if (blacklist) BLACKLIST = parseList(blacklist);
  } catch (e) { log('url params parse err', e); }
}

async function loadExternalConfig() {
  try {
    const res = await fetch('/_sw-config.json?ts=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const j = await res.json();
    if (j.cacheSeed) CACHE_SEED = j.cacheSeed;
    if (Array.isArray(j.domainWhitelist)) DOMAIN_WHITELIST = j.domainWhitelist;
    if ('applySeedToNetwork' in j) APPLY_SEED_TO_NETWORK = !!j.applySeedToNetwork;
    if (j.fallback) FALLBACK_URL = j.fallback;
    if ('acceptKey' in j) ACCEPT_KEY = !!j.acceptKey;
    if (j.imgCacheName) IMG_CACHE_NAME = j.imgCacheName;
    if (j.fontCacheName) FONT_CACHE_NAME = j.fontCacheName;
    if (j.lruMax) LRU_MAX = Math.max(100, parseInt(j.lruMax, 10) || LRU_MAX);
    if (j.manifest) DEFAULT_MANIFEST = j.manifest;
    if (Array.isArray(j.preload)) PRELOAD = j.preload;
    if (Array.isArray(j.preconnect)) PRECONNECT = j.preconnect;
    if (Array.isArray(j.blacklist)) BLACKLIST = j.blacklist;
  } catch (e) { log('ext cfg err', e); }
}

/* ===============================
   HELPERS
   =============================== */

function isHtmlNavigation(req) {
  const a = req.headers.get('Accept') || '';
  return a.includes('text/html');
}

function isAllowedDomain(u) {
  if (!DOMAIN_WHITELIST.length) return true;
  const h = u.host.toLowerCase();
  return DOMAIN_WHITELIST.some(d => d.toLowerCase() === h);
}

function inBlacklist(u) {
  try {
    const p = u.pathname;
    return BLACKLIST.some(rx => new RegExp(rx).test(p));
  } catch (_) { return false; }
}

function isStaticAsset(req) {
  const u = new URL(req.url);
  return STATIC_EXT_RE.test(u.pathname);
}
function isImagePath(u) { return IMG_EXT_RE.test(u.pathname); }
function isFontPath(u) { return FONT_EXT_RE.test(u.pathname); }

function acceptHash(req) {
  if (!ACCEPT_KEY) return '';
  const a = req.headers.get('Accept') || '';
  // Super light, stable hash
  let h = 0;
  for (let i = 0; i < a.length; i++) { h = (h * 31 + a.charCodeAt(i)) | 0; }
  return String(h >>> 0);
}

function cacheKeyWithSeed(reqOrUrl) {
  const u = new URL(typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url);
  u.searchParams.set('__sw_seed', CACHE_SEED);
  const ah = acceptHash(typeof reqOrUrl === 'string' ? new Request(reqOrUrl) : reqOrUrl);
  if (ah) u.searchParams.set('__sw_accept', ah);
  return new Request(u.toString(), { method: 'GET' });
}

const cacheNameFor = (u) => isFontPath(u) ? `${FONT_CACHE_NAME}-${SW_VERSION}` : `${IMG_CACHE_NAME}-${SW_VERSION}`;
const netTargetFor = (req) => APPLY_SEED_TO_NETWORK ? cacheKeyWithSeed(req) : req;

async function putAllowOpaque(cache, keyReq, res) {
  if (!res) return;
  // Allow cache of opaque for <img> etc., but note: headers cannot be read on opaque
  if (res.ok || res.type === 'opaque') {
    try { await cache.put(keyReq, res); } catch (e) { }
  }
}

async function trimLRU(cacheName, maxEntries) {
  try {
    const c = await caches.open(cacheName);
    const keys = await c.keys();
    if (keys.length <= maxEntries) return;
    const remove = keys.length - maxEntries;
    for (let i = 0; i < remove; i++) await c.delete(keys[i]); // FIFO-ish
    ring(`trim ${cacheName} -${remove}`);
  } catch (e) { }
}

// Add X-* headers only if response is not opaque.
function withHeaders(baseResponse, extras = {}) {
  try {
    if (!baseResponse || baseResponse.type === 'opaque') return baseResponse;
    const h = new Headers(baseResponse.headers || undefined);
    for (const [k, v] of Object.entries(extras)) h.set(k, String(v));
    return new Response(baseResponse.body, {
      status: baseResponse.status,
      statusText: baseResponse.statusText,
      headers: h
    });
  } catch {
    return baseResponse;
  }
}

// For cross-origin we may fallback to no-cors (only for seeding / background revalidate).
async function fetchWithETag(keyReq, originalReq, cross) {
  // We intentionally do not try to forward opaque to CORS contexts.
  return fetch(keyReq, cross ? { mode: 'no-cors' } : undefined);
}

/* ===============================
   LIFECYCLE
   =============================== */

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await loadUrlParams();
    await loadExternalConfig();

    // Optional prewarm
    if (Array.isArray(PRELOAD) && PRELOAD.length) {
      try {
        const toFetch = PRELOAD.map(u => {
          try { return new URL(u, self.location).toString(); } catch { return null; }
        }).filter(Boolean);
        await Promise.allSettled(toFetch.map(u => fetch(u, { mode: 'no-cors' })));
      } catch { }
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Keep only our current caches (scoped by SW_VERSION)
    const keep = new Set([`${IMG_CACHE_NAME}-${SW_VERSION}`, `${FONT_CACHE_NAME}-${SW_VERSION}`]);
    const names = await caches.keys();
    await Promise.all(names.filter(n => !keep.has(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* ===============================
   FETCH
   =============================== */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Service API endpoints (GET only; POST for seed/purge)
  if (url.origin === self.location.origin && url.pathname.startsWith(SW_API_PREFIX)) {
    event.respondWith(handleApi(event));
    return;
  }

  // Let HTML navigations through — SW is for static assets here.
  if (isHtmlNavigation(req)) return;

  // Not a static asset or blacklisted / domain not allowed
  if (!isStaticAsset(req) || !isAllowedDomain(url) || inBlacklist(url)) return;

  const cname = cacheNameFor(url);
  const key = cacheKeyWithSeed(req);

  event.respondWith((async () => {
    const cache = await caches.open(cname);
    const cached = await cache.match(key, { ignoreVary: true });

    if (cached) {
      METRICS.hit++; ring(`HIT ${url.pathname}`);

      // Background revalidate
      event.waitUntil((async () => {
        try {
          const cross = url.origin !== self.location.origin;
          const target = netTargetFor(req);
          const net = await fetchWithETag(target, req, cross);
          await putAllowOpaque(cache, key, net && net.clone());
          METRICS.revalidate_ok++;
          bcSend('revalidated', { key: key.url });
          await trimLRU(cname, LRU_MAX);
        } catch (e) {
          METRICS.revalidate_fail++; ring(`revalidate fail: ${e}`);
        }
      })());

      return withHeaders(cached, {
        'X-SW-Cache': 'HIT',
        'X-SW-Source': 'cache',
        'X-SW-Seed': CACHE_SEED,
        'X-SW-Version': SW_VERSION
      });
    }

    // MISS → go to network
    try {
      const cross = url.origin !== self.location.origin;
      const target = netTargetFor(req);
      const net = await fetchWithETag(target, req, cross); // may be opaque for cross-origin
      await putAllowOpaque(cache, key, net.clone());
      METRICS.miss++; ring(`MISS ${url.pathname}`);
      await trimLRU(cname, LRU_MAX);
      return withHeaders(net, {
        'X-SW-Cache': 'MISS',
        'X-SW-Source': 'network',
        'X-SW-Seed': CACHE_SEED,
        'X-SW-Version': SW_VERSION
      });
    } catch (e) {
      if (FALLBACK_URL) {
        try { return await fetch(FALLBACK_URL); }
        catch (_) { return Response.error(); }
      }
      return Response.error();
    }
  })());
});

/* ===============================
   API HANDLERS
   =============================== */

function requireSecret(req) {
  if (!SW_SECRET) return true;
  const hdr = req.headers.get('x-sw-secret');
  return hdr === SW_SECRET;
}

async function handleApi(event) {
  const req = event.request;
  const url = new URL(req.url);
  const dry = (url.searchParams.get('dry') || '') === '1';

  // OpenAPI (single path)
  if (url.pathname === `${SW_API_PREFIX}openapi.json`) {
    return new Response(JSON.stringify(openapiDoc()), { headers: { 'Content-Type': 'application/json' } });
  }

  // Metrics
  if (url.pathname === `${SW_API_PREFIX}metrics` && req.method === 'GET') {
    const fmt = (url.searchParams.get('format') || 'prom').toLowerCase();
    if (fmt === 'json') {
      return new Response(JSON.stringify(METRICS), { headers: { 'Content-Type': 'application/json' } });
    }
    if (fmt === 'pretty') {
      const rows = Object.entries(METRICS).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
      const html = `<!doctype html><meta charset="utf-8"><title>SW Metrics</title>
      <table border="1" cellpadding="6">${rows}</table>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const prom = Object.entries(METRICS).map(([k, v]) => `sw_${k} ${v}`).join('\n') + '\n';
    return new Response(prom, { headers: { 'Content-Type': 'text/plain; version=0.0.4' } });
  }

  // Status (full config echo)
  if (url.pathname === `${SW_API_PREFIX}status` && req.method === 'GET') {
    return json({
      ok: true,
      version: SW_VERSION,
      seed: CACHE_SEED,
      allowlist: DOMAIN_WHITELIST,
      applySeedToNetwork: APPLY_SEED_TO_NETWORK,
      fallback: FALLBACK_URL,
      acceptKey: ACCEPT_KEY,
      imgCacheName: IMG_CACHE_NAME,
      fontCacheName: FONT_CACHE_NAME,
      lruMax: LRU_MAX,
      manifest: DEFAULT_MANIFEST,
      preload: PRELOAD,
      preconnect: PRECONNECT,
      blacklist: BLACKLIST
    });
  }

  // List cached keys
  if (url.pathname === `${SW_API_PREFIX}list` && req.method === 'GET') {
    const cachesToList = [`${IMG_CACHE_NAME}-${SW_VERSION}`, `${FONT_CACHE_NAME}-${SW_VERSION}`];
    const out = [];
    for (const name of cachesToList) {
      const c = await caches.open(name);
      const keys = await c.keys();
      out.push({ cache: name, count: keys.length, keys: keys.map(k => k.url) });
    }
    return json({ ok: true, caches: out });
  }

  // Seed
  if (url.pathname === `${SW_API_PREFIX}seed` && req.method === 'POST') {
    if (!requireSecret(req)) return new Response('forbidden', { status: 403 });
    const body = await safeJson(req);
    const result = await seedUnified(body, dry);
    return json(result);
  }

  // Purge
  if (url.pathname === `${SW_API_PREFIX}purge` && req.method === 'POST') {
    if (!requireSecret(req)) return new Response('forbidden', { status: 403 });
    const body = await safeJson(req);
    const result = await purgeUnified(body, dry);
    return json(result);
  }

  // Tiny debug page (optional)
  if (url.pathname === '/_sw/debug') {
    const html = `<!doctype html><meta charset="utf-8"><title>Service Worker Debug</title>
      <style>body{font-family:system-ui,Arial,sans-serif;padding:20px}pre{white-space:pre-wrap}</style>
      <h1>Service Worker Debug</h1>
      <h2>Metrics</h2><pre>${JSON.stringify(METRICS, null, 2)}</pre>
      <h2>Recent log</h2><pre>${LOG_RING.map(x => x).join('\n')}</pre>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  return new Response('not found', { status: 404 });
}

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
}
async function safeJson(req) {
  try { return await req.json(); } catch { return {}; }
}

/* ===============================
   SEED / PURGE / MANIFEST HELPERS
   =============================== */

async function expandKeysFromManifest(manifestUrl, prefix, glob, max = Infinity) {
  try {
    const res = await fetch(manifestUrl, { cache: 'no-store' });
    if (!res.ok) return [];
    const arr = await res.json();
    let keys = Array.isArray(arr) ? arr.map(x => (typeof x === 'string' ? x : (x.path || ''))).filter(Boolean) : [];
    if (prefix) keys = keys.filter(k => k.startsWith(prefix));
    if (glob) { const rx = globToRegex(glob); keys = keys.filter(k => rx.test(k)); }
    if (Number.isFinite(max)) keys = keys.slice(0, max);
    return keys;
  } catch { return []; }
}

function globToRegex(glob) {
  let s = String(glob).replace(/[.+^${}()|[\]\\]/g, r => '\\' + r);
  s = s.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
  return new RegExp('^' + s + '$');
}

async function seedUnified(body, dry) {
  const keys = Array.isArray(body.keys) ? body.keys : null;
  const prefix = body.prefix || null;
  const glob = body.glob || null;
  const manifest = body.manifest || DEFAULT_MANIFEST || null;
  const max = body.max || null;

  let targetKeys = [];
  if (keys && keys.length) targetKeys = keys;
  else if (prefix || glob) targetKeys = manifest ? await expandKeysFromManifest(manifest, prefix, glob, max || Infinity) : [];
  else if (manifest) targetKeys = await expandKeysFromManifest(manifest, null, null, max || Infinity);

  const out = [];
  let count = 0;

  for (const k of targetKeys) {
    try {
      const abs = new URL(k, self.location).toString();
      const u = new URL(abs);
      if (!STATIC_EXT_RE.test(u.pathname) || inBlacklist(u) || !isAllowedDomain(u)) {
        out.push({ key: abs, ok: false, reason: 'not-static-or-not-allowed' });
        continue;
      }
      if (dry) { out.push({ key: abs, ok: true, dry: true }); count++; continue; }

      const cname = cacheNameFor(u);
      const cache = await caches.open(cname);
      const keyReq = cacheKeyWithSeed(abs);
      const cross = u.origin !== self.location.origin;
      const netTarget = APPLY_SEED_TO_NETWORK ? keyReq : new Request(abs, { method: 'GET' });
      const res = await fetch(netTarget, cross ? { mode: 'no-cors' } : undefined);

      await putAllowOpaque(cache, keyReq, res && res.clone());
      out.push({ key: abs, ok: true });
      count++; METRICS.seed_ok++;
    } catch (e) {
      out.push({ key: String(k), ok: false, error: String(e) });
      METRICS.seed_fail++;
    }
  }
  bcSend('seeded', { count });
  return { ok: true, seeded: out, count, dry: !!dry };
}

async function purgeUnified(body, dry) {
  const keys = Array.isArray(body.keys) ? body.keys : null;
  const prefix = body.prefix || null;
  const glob = body.glob || null;

  const cachesToList = [`${IMG_CACHE_NAME}-${SW_VERSION}`, `${FONT_CACHE_NAME}-${SW_VERSION}`];
  const all = [];
  for (const name of cachesToList) {
    const c = await caches.open(name);
    const ks = await c.keys();
    all.push(...ks.map(k => ({ cache: name, req: k })));
  }

  let targets = [];
  if (keys && keys.length) {
    const set = new Set(keys.map(k => new URL(k, self.location).toString()));
    targets = all.filter(x => set.has(new URL(x.req.url).toString().replace(/&__sw_accept=\d+/, '')));
  } else if (prefix || glob) {
    const rx = glob ? globToRegex(glob) : null;
    targets = all.filter(x => {
      const p = new URL(x.req.url).pathname;
      return prefix ? p.startsWith(prefix) : rx.test(p);
    });
  }

  let removed = 0;
  const out = [];
  for (const t of targets) {
    try {
      if (dry) { out.push({ key: t.req.url, removed: 0, dry: true }); continue; }
      const c = await caches.open(t.cache);
      const ok = await c.delete(t.req);
      if (ok) removed++;
      out.push({ key: t.req.url, removed: ok ? 1 : 0 });
      METRICS.purge_ok += ok ? 1 : 0;
    } catch (e) {
      out.push({ key: t.req.url, error: String(e) });
      METRICS.purge_fail++;
    }
  }
  bcSend('purged', { removed });
  return { ok: true, purged: out, count: removed, dry: !!dry };
}

/* ===============================
   OPENAPI
   =============================== */

function openapiDoc() {
  return {
    openapi: '3.0.3',
    info: { title: 'SW Cache API', version: '3.0.0' },
    paths: {
      '/__sw-api/status': { get: { summary: 'Status', responses: { '200': { description: 'OK' } } } },
      '/__sw-api/list': { get: { summary: 'List cache keys', responses: { '200': { description: 'OK' } } } },
      '/__sw-api/seed': {
        post: {
          summary: 'Seed cache',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } }, dry: { type: 'boolean' } }, required: ['keys'] },
                    { type: 'object', properties: { prefix: { type: 'string' }, max: { type: 'integer' }, dry: { type: 'boolean' } }, required: ['prefix'] },
                    { type: 'object', properties: { glob: { type: 'string' }, max: { type: 'integer' }, dry: { type: 'boolean' } }, required: ['glob'] },
                    { type: 'object', properties: { manifest: { type: 'string' }, max: { type: 'integer' }, dry: { type: 'boolean' } }, required: ['manifest'] }
                  ]
                }
              }
            }
          },
          responses: { '200': { description: 'OK' } }
        }
      },
      '/__sw-api/purge': {
        post: {
          summary: 'Purge cache',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } }, dry: { type: 'boolean' } }, required: ['keys'] },
                    { type: 'object', properties: { prefix: { type: 'string' }, dry: { type: 'boolean' } }, required: ['prefix'] },
                    { type: 'object', properties: { glob: { type: 'string' }, dry: { type: 'boolean' } }, required: ['glob'] }
                  ]
                }
              }
            }
          },
          responses: { '200': { description: 'OK' } }
        }
      },
      '/__sw-api/metrics': {
        get: {
          summary: 'Metrics',
          parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['prom', 'json', 'pretty'] } }],
          responses: { '200': { description: 'OK' } }
        }
      },
      '/__sw-api/openapi.json': { get: { summary: 'OpenAPI document', responses: { '200': { description: 'OK' } } } }
    }
  };
}

/* ===============================
   MISC
   =============================== */

self.addEventListener('message', () => { });

