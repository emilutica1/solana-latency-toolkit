// Fan-out sender — send the SAME signed transaction to several routes at once, and optionally keep re-sending those same
// bytes until it confirms.
//
// One signed transaction has one signature, and the network accepts a signature only once, so sending the same bytes to
// many routes (or many times) cannot make it land twice. Every route races to get it into a block; duplicates are dropped.
// Never re-sign inside a resend loop: a transaction signed again with a new blockhash is a DIFFERENT transaction and
// can land a second time.
//
// Routes are plain JSON-RPC sendTransaction endpoints: any RPC, Jito block engines (/api/v1/transactions), Helius Sender,
// and similar. Jito and Sender only accept a transaction that already pays them a tip; check each provider's docs for
// the tip account and minimum.
//
//   const { sendToAll, startResend, jitoRoutes } = require('./fan-out');
//   const routes = [{ name: 'rpc', url: RPC_URL, opts: { skipPreflight: true, maxRetries: 3 } }, ...jitoRoutes(['ny'])];
//   const base64 = Buffer.from(tx.serialize()).toString('base64');
//   const results = await sendToAll(base64, routes);       // [{ route, ok, ms, error? }]
//   const stop = startResend(base64, routes, { everyMs: 300, maxMs: 4000 });
//   ... wait for confirmation ...
//   const resends = stop();
'use strict';

const JITO_REGIONS = ['ny', 'slc', 'amsterdam', 'frankfurt', 'london', 'dublin', 'tokyo', 'singapore'];

/** Jito block-engine routes. Jito limits each IP to about 1 request per second per region, hence minIntervalMs. */
function jitoRoutes(regions = ['ny'], { global = false, timeoutMs = 4000 } = {}) {
  const list = regions === 'all' ? JITO_REGIONS : regions;
  const routes = list.map((r) => {
    if (!JITO_REGIONS.includes(r)) throw new Error(`unknown Jito region "${r}" (known: ${JITO_REGIONS.join(', ')})`);
    return { name: `jito-${r}`, url: `https://${r}.mainnet.block-engine.jito.wtf/api/v1/transactions`, timeoutMs, minIntervalMs: 1000 };
  });
  if (global) routes.unshift({ name: 'jito', url: 'https://mainnet.block-engine.jito.wtf/api/v1/transactions', timeoutMs, minIntervalMs: 1000 });
  return routes;
}

/** POST one sendTransaction. Resolves { route, ok, ms, signature?, error? }; never rejects. */
async function postRoute(route, base64) {
  const t0 = Date.now();
  try {
    const res = await fetch(route.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(route.headers || {}) },
      signal: AbortSignal.timeout(route.timeoutMs || 4000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [base64, { encoding: 'base64', ...(route.opts || {}) }] }),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    const ms = Date.now() - t0;
    if (!res.ok || !body) return { route: route.name, ok: false, ms, error: `HTTP ${res.status}: ${text.slice(0, 120)}` };
    if (body.error) return { route: route.name, ok: false, ms, error: JSON.stringify(body.error).slice(0, 160) };
    return { route: route.name, ok: true, ms, signature: body.result };
  } catch (e) {
    return { route: route.name, ok: false, ms: Date.now() - t0, error: e.name === 'TimeoutError' ? 'timeout' : String(e.message || e).slice(0, 120) };
  }
}

/** Send the same signed transaction (base64) to every route in parallel. Results are in route order. */
function sendToAll(base64, routes) {
  if (!routes.length) throw new Error('no routes');
  return Promise.all(routes.map((r) => postRoute(r, base64)));
}

/**
 * Re-send the same bytes to every route every `everyMs` (each route no more often than its own minIntervalMs) until
 * stop() is called or `maxMs` has passed. Errors are ignored. Returns stop(), which returns how many resends were made.
 * The first send is not included: call sendToAll() first.
 */
function startResend(base64, routes, { everyMs = 300, maxMs = 4000 } = {}) {
  const t0 = Date.now(), last = new Map(routes.map((r) => [r.name, t0]));
  let n = 0, stopped = false;
  // a fine tick: a coarse one rounds every interval up to the next tick (250 ms ticks turned 300 ms into 500 ms)
  const timer = setInterval(() => {
    if (stopped || Date.now() - t0 >= maxMs) { clearInterval(timer); return; }
    for (const r of routes) {
      if (Date.now() - last.get(r.name) < Math.max(everyMs, r.minIntervalMs || 0)) continue;
      last.set(r.name, Date.now()); n++;
      postRoute(r, base64);
    }
  }, 25);
  return () => { stopped = true; clearInterval(timer); return n; };
}

/** One-line summary, e.g. "rpc ok 41 ms, jito-ny ok 38 ms, sender err timeout". */
function formatResults(results) {
  return results.map((r) => `${r.route} ${r.ok ? 'ok' : `err ${r.error}`} ${r.ms} ms`).join(', ');
}

module.exports = { sendToAll, startResend, jitoRoutes, postRoute, formatResults, JITO_REGIONS };
