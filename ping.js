// Endpoint ping — round-trip time from this machine to Solana send/read endpoints. Read-only, no keys.
// Each endpoint gets one warm-up request (connection + TLS setup), then SAMPLES requests on the open connection;
// the minimum and median are printed, fastest first. Use it to pick a server location or the nearest region.
//
// Usage: node ping.js                       (default: Jito block-engine regions + public mainnet RPC)
//        ENDPOINTS="name=url name=url" SAMPLES=7 node ping.js
'use strict';
const SAMPLES = Number(process.env.SAMPLES || 7);
const JITO = ['ny', 'slc', 'amsterdam', 'frankfurt', 'london', 'dublin', 'tokyo', 'singapore']
  .map((r) => `jito-${r}=https://${r}.mainnet.block-engine.jito.wtf/api/v1/getTipAccounts`);
const DEFAULT = [...JITO, 'solana-mainnet=https://api.mainnet-beta.solana.com', 'publicnode=https://solana-rpc.publicnode.com'];
const endpoints = (process.env.ENDPOINTS ? process.env.ENDPOINTS.trim().split(/\s+/) : DEFAULT).map((s) => {
  const i = s.indexOf('='); return { name: s.slice(0, i), url: s.slice(i + 1) };
});
const mask = (u) => String(u).replace(/(api[-_]?key=|token=)[^&]+/gi, '$1…');

async function once(url) {
  const t = performance.now();
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: url.includes('block-engine') ? 'getTipAccounts' : 'getHealth', params: [] }) });
  await r.arrayBuffer();
  return performance.now() - t;
}

(async () => {
  const rows = [];
  for (const e of endpoints) {
    try {
      await once(e.url);
      const ms = [];
      for (let i = 0; i < SAMPLES; i++) ms.push(await once(e.url));
      ms.sort((a, b) => a - b);
      rows.push({ ...e, min: ms[0], med: ms[Math.floor(ms.length / 2)] });
    } catch (err) { rows.push({ ...e, error: err.message }); }
  }
  rows.sort((a, b) => (a.med ?? Infinity) - (b.med ?? Infinity));
  console.log('endpoint            min ms  median ms   url');
  for (const r of rows) {
    console.log(`${r.name.padEnd(18)} ${r.error ? 'error: ' + r.error : `${r.min.toFixed(1).padStart(7)} ${r.med.toFixed(1).padStart(9)}`}   ${mask(r.url)}`);
  }
})();
