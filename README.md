
# js-sw-cache-kit

Universal Service Worker for **static asset caching** (images + fonts) with a consolidated **seed/purge API**, **metrics** (Prometheus/JSON/HTML), **OpenAPI**, and a **hybrid configuration** model (URL query + external JSON).

- Cache-first + SWR revalidation (with **ETag/If-None-Match** when available)
- **Domain allowlist** (empty → allow all), **blacklist** (regex/globs), **fallback** (optional)
- **LRU-like trimming**, separate caches for **images** and **fonts**
- **Background Sync** for seed queue and optional **Periodic Background Sync** for config refresh
- **BroadcastChannel** notifications (revalidated/seeded/purged)
- **Autopreload/Preconnect** via BroadcastChannel (client injects `<link>` tags)
- **Metrics**: `/__sw-api/metrics?format=prom|json|pretty`
- **OpenAPI**: `/__sw_api/openapi.json`
- **Consolidated endpoints**: `POST /__sw-api/seed` and `POST /__sw-api/purge`
- Response headers on cached/static responses: `X-SW-Cache`, `X-SW-Source`, `X-SW-Seed`, `X-SW-Version`

## Quick start

1) Copy `dist/sw-worker.min.js` and `dist/sw-cache-api.min.js` to your web root.

2) Register the SW (with **URL parameters**):
```html
<script type="module">
  if ('serviceWorker' in navigator) {
    const v = 'v3.0.0';
    // Query config (takes precedence over external JSON):
    const seed = 'seed-0001';
    const allow = encodeURIComponent('cdn.example.com,static.example.com');
    const apply = '0';                  // 1 => apply seed to NETWORK URLs too
    const fallback = encodeURIComponent('/offline.html'); // optional

    navigator.serviceWorker.register(`/sw-worker.min.js?v=${v}&seed=${seed}&allow=${allow}&apply=${apply}&fallback=${fallback}`, { scope: '/' });
  }
</script>
<script type="module" src="/sw-cache-api.min.js"></script>
```

3) (Optional) Provide an external config at `/_sw-config.json`:
```json
{
  "cacheSeed": "seed-0001",
  "domainWhitelist": ["cdn.example.com","static.example.com"],
  "applySeedToNetwork": false,
  "fallback": "/offline.html",
  "acceptKey": false,
  "imgCacheName": "sw-img-cache",
  "fontCacheName": "sw-fonts-cache",
  "lruMax": 3000,
  "manifest": "/_assets-manifest.json",
  "preload": ["/img/hero.webp"],
  "preconnect": ["https://cdn.example.com"],
  "blacklist": ["^/upload/", "^/tmp/"]
}
```

> **Precedence:** URL query params → external JSON → worker defaults.

## Consolidated API
- `POST /__sw-api/seed` and `POST /__sw-api/purge` support **one of**:
  - `{ "keys": ["/img/a.webp","/fonts/Inter.woff2"] }`
  - `{ "prefix": "/assets/img/" }`
  - `{ "glob": "**/*.webp" }`       *(requires a manifest)*
  - For `seed` you can also provide: `{ "manifest": "/_assets-manifest.json", "max": 500 }`
- Append `?dry=1` for dry-run (simulation only).
- For protected environments set a shared secret in the worker and send `x-sw-secret` header.

### Examples
```bash
# Seed explicit keys
curl -X POST -H "Content-Type: application/json" -d '{"keys":["/img/a.webp","/fonts/Inter.woff2"]}' https://example.com/__sw-api/seed

# Seed by prefix (using the site's manifest)
curl -X POST -H "Content-Type: application/json" -d '{"prefix":"/assets/img/"}' https://example.com/__sw-api/seed

# Seed by glob (requires a manifest configured)
curl -X POST -H "Content-Type: application/json" -d '{"glob":"**/*.webp","max":200}' https://example.com/__sw-api/seed

# Purge by keys
curl -X POST -H "Content-Type: application/json" -d '{"keys":["/img/a.webp"]}' https://example.com/__sw-api/purge

# Purge by prefix
curl -X POST -H "Content-Type: application/json" -d '{"prefix":"/assets/img/"}' https://example.com/__sw-api/purge
```

## Metrics
```
GET /__sw-api/metrics?format=prom   # default
GET /__sw-api/metrics?format=json
GET /__sw-api/metrics?format=pretty
```

## OpenAPI
```
GET /__sw_api/openapi.json
```

## Client usage (JS)
```js
import { swSeed, swPurge, swStatus, swList, swMetrics, swOpenAPI } from '/sw-cache-api.min.js';

await swSeed({ keys: ['/img/hero.webp'] });
await swSeed({ prefix: '/assets/img/' });
await swPurge({ glob: '**/*.woff2' });
const status = await swStatus();
const list = await swList();
const prom = await swMetrics('prom');
const openapi = await swOpenAPI();
```

---

## Server configuration

### Apache (.htaccess)

> Requires: `mod_rewrite`, `mod_headers`, (optional) `mod_auth_basic`, `mod_authn_file`.

```apache
# ===== Service Worker delivery =====
<FilesMatch "^sw-worker(\.min)?\.js$">
  Header set Service-Worker-Allowed "/"
  Header set Cache-Control "public, max-age=300"
  Header set Content-Type "application/javascript; charset=utf-8"
</FilesMatch>

# ===== Optional: placeholder for /__sw-api/* before SW is active =====
RewriteEngine On
RewriteCond %{REQUEST_URI} ^/__sw-api/(status|metrics|list|seed|purge)$ [NC]
RewriteRule ^ - [R=204,L]

# ===== Optional: Basic-Auth for /__sw-api/* =====
<Location "/__sw-api/">
  AuthType Basic
  AuthName "SW Admin"
  AuthUserFile "/var/www/.htpasswd"
  Require valid-user
</Location>
```

---

### Nginx

> Works with standard modules; Basic-Auth uses `htpasswd` file.

```nginx
# ===== Service Worker delivery =====
location = /sw-worker.min.js {
  add_header Service-Worker-Allowed "/" always;
  add_header Cache-Control "public, max-age=300" always;
  types { application/javascript js; }
  default_type application/javascript;
  try_files $uri =404;
}

# ===== Optional: placeholder for /__sw-api/* before SW is active =====
location ~* ^/__sw-api/(status|metrics|list|seed|purge)$ {
  return 204;
}

# ===== Optional: Basic-Auth for /__sw-api/* =====
location ^~ /__sw-api/ {
  auth_basic           "SW Admin";
  auth_basic_user_file /etc/nginx/.htpasswd;
  try_files $uri =404;
}
```

**Create user for Nginx:**
```bash
sudo htpasswd -c /etc/nginx/.htpasswd admin
sudo nginx -t && sudo systemctl reload nginx
```
