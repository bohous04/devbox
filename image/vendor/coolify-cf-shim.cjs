// Host/container transport compatibility for @masonator/coolify-mcp.
// Keep CF credentials out of argv. v2.12 deploy uses GET, while Coolify v4.2
// requires POST. Rewrite only the configured origin and exact deploy path,
// before a request is sent; never retry a mutation or change its target.
'use strict';

const ID = process.env.COOLIFY_CF_ACCESS_CLIENT_ID;
const SECRET = process.env.COOLIFY_CF_ACCESS_CLIENT_SECRET;
let base;
try { base = new URL(process.env.COOLIFY_BASE_URL); } catch { /* Not a Coolify process. */ }

if (base && typeof globalThis.fetch === 'function') {
  const original = globalThis.fetch;
  const apiBase = base.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  globalThis.fetch = function (input, init) {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); }
    catch { return original(input, init); }
    if (url.origin !== base.origin) return original(input, init);
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const deployment = url.pathname === `${apiBase}/api/v1/deploy` && (method === 'GET' || method === 'POST');
    const deploy = deployment && method === 'GET';
    if (!deployment && !(ID && SECRET)) return original(input, init);
    const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
    if (ID && SECRET) {
      headers.set('CF-Access-Client-Id', ID);
      headers.set('CF-Access-Client-Secret', SECRET);
    }
    // fetch forwards custom CF headers through redirects. Fail closed so a redirect
    // cannot send credentials to another origin or replay a deployment elsewhere.
    return original(input, Object.assign({}, init, { headers, redirect: 'error' }, deploy ? { method: 'POST' } : {}));
  };
}
