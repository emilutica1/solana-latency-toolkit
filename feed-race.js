// Feed race — which data source delivers a Solana account update first? Read-only, no keys or wallet.
//
// Subscribes to the same account on several sources at once (WebSocket and/or Yellowstone gRPC) and records, for every
// slot in which the account changed, when each source delivered it. At the end it prints how often each source was
// first and how far behind the first one it was (median and p90, in ms).
//
// Sources come from the SOURCES environment variable, separated by spaces:
//   name=ws:<http url>|<wss url>      a WebSocket accountSubscribe (any Solana RPC)
//   name=grpc:<url>|<x-token>         a Yellowstone gRPC subscription (token may be empty)
// Default: the public mainnet WebSocket only.
//
// Usage: SOURCES="public=ws:https://api.mainnet-beta.solana.com|wss://api.mainnet-beta.solana.com mygrpc=grpc:https://host:443|TOKEN" \
//        DURATION_S=180 node feed-race.js [--out races.jsonl]
'use strict';
const fs = require('fs');
const { Connection, PublicKey } = require('@solana/web3.js');

// Default account: Kamino's Scope oracle price account, which is updated in almost every slot.
const ACCOUNT = process.env.ACCOUNT || '3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C';
const DURATION_S = Number(process.env.DURATION_S || 180);
const SOURCES = (process.env.SOURCES || 'public=ws:https://api.mainnet-beta.solana.com|wss://api.mainnet-beta.solana.com').trim().split(/\s+/);
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : null;

const arrivals = new Map();   // slot -> { source: ms }
const names = [];
function arrive(src, slot) {
  const t = Date.now();
  let s = arrivals.get(slot);
  if (!s) { s = {}; arrivals.set(slot, s); }
  if (s[src] !== undefined) return;
  s[src] = t;
  if (OUT) fs.appendFileSync(OUT, JSON.stringify({ src, slot, t }) + '\n');
}
const mask = (u) => String(u).replace(/(api[-_]?key=|token=)[^&]+/gi, '$1…').replace(/\/\/([^/]+)\/[^/?]{16,}/, '//$1/…');

async function start(spec) {
  const m = spec.match(/^([\w-]+)=(ws|grpc):(.+)$/);
  if (!m) throw new Error(`bad source "${spec}" — expected name=ws:<http>|<wss> or name=grpc:<url>|<token>`);
  const [, name, kind, rest] = m;
  const [a, b = ''] = rest.split('|');
  names.push(name);
  if (kind === 'ws') {
    const conn = new Connection(a, { wsEndpoint: b || a.replace(/^http/, 'ws'), commitment: 'processed' });
    conn.onAccountChange(new PublicKey(ACCOUNT), (_, ctx) => arrive(name, ctx.slot), 'processed');
    console.error(`${name}: WebSocket ${mask(b || a)}`);
  } else {
    const Client = require('@triton-one/yellowstone-grpc').default;
    const client = new Client(a, b || undefined, { 'grpc.max_receive_message_length': 64 * 1024 * 1024 });
    const stream = await client.subscribe();
    stream.on('data', (d) => { if (d.account) arrive(name, Number(d.account.slot)); });
    stream.on('error', (e) => console.error(`${name}: gRPC error ${e.details || e.message}`));
    stream.write({ accounts: { race: { account: [ACCOUNT], owner: [], filters: [] } }, slots: {}, transactions: {}, transactionsStatus: {},
      blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [], commitment: 0 });
    console.error(`${name}: gRPC ${mask(a)}`);
  }
}

function report() {
  const full = [...arrivals.values()].filter((s) => names.every((n) => s[n] !== undefined));
  const firsts = Object.fromEntries(names.map((n) => [n, 0]));
  const behind = Object.fromEntries(names.map((n) => [n, []]));
  for (const s of full) {
    const first = Math.min(...names.map((n) => s[n]));
    for (const n of names) { if (s[n] === first) firsts[n]++; behind[n].push(s[n] - first); }
  }
  const q = (a, p) => { if (!a.length) return '-'; const x = a.slice().sort((u, v) => u - v); return x[Math.min(x.length - 1, Math.floor(x.length * p))]; };
  console.log(`\naccount ${ACCOUNT}, ${DURATION_S} s: ${arrivals.size} slots with an update, ${full.length} seen by every source`);
  console.log('source            first   ms behind first: median   p90   max');
  for (const n of names) {
    const counts = names.map((x) => [x, [...arrivals.values()].filter((s) => s[x] !== undefined).length]);
    console.log(`${n.padEnd(16)} ${String(firsts[n]).padStart(6)}   ${String(q(behind[n], 0.5)).padStart(22)} ${String(q(behind[n], 0.9)).padStart(5)} ${String(q(behind[n], 1)).padStart(5)}`
      + `   (saw ${counts.find((c) => c[0] === n)[1]} slots)`);
  }
  console.log('Ties count as first for every tied source. Arrival times are taken on this machine, so all sources share one clock.');
}

(async () => {
  for (const s of SOURCES) await start(s);
  console.error(`racing for ${DURATION_S} s…`);
  setTimeout(() => { report(); process.exit(0); }, DURATION_S * 1000);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
