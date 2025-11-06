/*! sw-cache-kit-advanced v3.0.0 | MIT | Author: Rafal Masiarek <rafal@masiarek.pl> */
const API = '/__sw-api/';
async function api(path, method = 'GET', body = null, secret = null, qs = '') { const headers = {}; if (secret) headers['x-sw-secret'] = secret; const init = { method, headers }; if (body) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body) } const url = API + path + (qs ? ('?' + qs) : ''); const res = await fetch(url, init); if (!res.ok) throw new Error('api error ' + res.status); const ct = res.headers.get('Content-Type') || ''; if (ct.includes('application/json')) return res.json(); return res.text() }
export async function swStatus() { return api('status') }
export async function swList() { return api('list') }
export async function swSeed(payload, secret = null, dry = false) { return api('seed', 'POST', payload, secret, dry ? 'dry=1' : '') }
export async function swPurge(payload, secret = null, dry = false) { return api('purge', 'POST', payload, secret, dry ? 'dry=1' : '') }
export async function swMetrics(format = 'prom') { return api('metrics', 'GET', null, null, 'format=' + encodeURIComponent(format)) }
export async function swOpenAPI() { return api('openapi.json') }
