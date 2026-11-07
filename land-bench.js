// Landing benchmark — how many slots does a transaction take to land through each send route?
//
// Sends N tiny transactions (a 1-lamport transfer to yourself, plus the route's tip and a priority fee) and records, for
// each one, the slot when it was sent and the slot it landed in. Routes are compared by alternating: transaction i goes
// to route i mod R. At the end it prints, per route, the landing-slot distribution, median slots and median ms.
//
// THIS SPENDS REAL SOL from the wallet you give it (fee + priority fee + tip per transaction; the self-transfer comes
// back). Use a separate throwaway wallet holding only what the test needs. A spending cap (MAX_SPEND_SOL) is enforced
// before anything is sent, and --dry-run builds and simulates without sending.
//
// Routes (ROUTES, separated by spaces):
//   name=rpc:<url>[|tip=<address>:<lamports>]            JSON-RPC sendTransaction (any RPC, Jito block engine, Helius Sender…)
//   name=blx:<url>|auth=<header>[|tip=<address>:<lamports>]   bloXroute /api/v2/submit
//
// Usage: WALLET=throwaway.json N=20 ROUTES="…" node land-bench.js [--dry-run] [--out results.jsonl]
'use strict';
const fs = require('fs');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const bs58 = require('bs58').default ?? require('bs58');

const DRY = process.argv.includes('--dry-run');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : null;
const N = Number(process.env.N || 20);
const GAP_MS = Number(process.env.GAP_MS || 2000);
const STATUS_RPC = process.env.STATUS_RPC || 'https://api.mainnet-beta.solana.com';
const STATUS_WS = process.env.STATUS_WS || STATUS_RPC.replace(/^http/, 'ws');
const CU_LIMIT = 1_500;
const PRIORITY_MICROLAMPORTS = Number(process.env.PRIORITY_MICROLAMPORTS || 6_666_667);   // × 1,500 CU ≈ 10,000 lamports
const MAX_SPEND_SOL = Number(process.env.MAX_SPEND_SOL || 0.01);
const JITO_TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';   // one of Jito's 8 official tip accounts
const DEFAULT_ROUTES = `jito-ny=rpc:https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions|tip=${JITO_TIP}:1000 public=rpc:https://api.mainnet-beta.solana.com`;

if (!process.env.WALLET) { console.error('set WALLET=<path to a throwaway keypair JSON file>'); process.exit(1); }
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.WALLET, 'utf8'))));

const mask = (u) => String(u).replace(/(api[-_]?key=|token=)[^&]+/gi, '$1…');
const routes = (process.env.ROUTES || DEFAULT_ROUTES).trim().split(/\s+/).map((spec) => {
  const m = spec.match(/^([\w-]+)=(rpc|blx):(.+)$/);
  if (!m) throw new Error(`bad route "${spec}"`);
  const [url, ...opts] = m[3].split('|');
  const r = { name: m[1], kind: m[2], url, tip: null, auth: null };
  for (const o of opts) {
    if (o.startsWith('tip=')) { const [addr, lam] = o.slice(4).split(':'); r.tip = { to: new PublicKey(addr), lamports: Number(lam) }; }
    else if (o.startsWith('auth=')) r.auth = o.slice(5);
    else throw new Error(`bad route option "${o}"`);
  }
  if (r.kind === 'blx' && !r.auth) throw new Error(`${r.name}: bloXroute routes need auth=<header>`);
  return r;
});

const priorityLamports = Math.ceil((PRIORITY_MICROLAMPORTS * CU_LIMIT) / 1e6);
const costOf = (r) => 5_000 + priorityLamports + (r.tip ? r.tip.lamports : 0);
const worst = Array.from({ length: N }, (_, i) => costOf(routes[i % routes.length])).reduce((a, b) => a + b, 0);

const call = async (url, method, params) => (await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) })).json());

async function send(r, b64) {
  try {
    if (r.kind === 'blx') {
      const res = await fetch(r.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: r.auth }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ transaction: { content: b64 }, frontRunningProtection: false, useStakedRPCs: true }) });
      const j = await res.json().catch(() => ({}));
      return j.signature ? 'ok' : `HTTP ${res.status} ${JSON.stringify(j).slice(0, 80)}`;
    }
    const j = await call(r.url, 'sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]);
    return j.result ? 'ok' : `error ${JSON.stringify(j.error).slice(0, 80)}`;
  } catch (e) { return `failed ${e.message}`; }
}

(async () => {
  const conn = new Connection(STATUS_RPC, { commitment: 'processed', wsEndpoint: STATUS_WS });
  const balance = await conn.getBalance(kp.publicKey, 'confirmed');
  console.error(`wallet ${kp.publicKey.toBase58()}  balance ${balance / 1e9} SOL`);
  for (const r of routes) console.error(`route ${r.name}: ${r.kind} ${mask(r.url)}${r.tip ? `  tip ${r.tip.lamports} L` : ''}  → ${costOf(r)} L per tx`);
  console.error(`${N} transactions, at most ${worst / 1e9} SOL in fees and tips (cap MAX_SPEND_SOL=${MAX_SPEND_SOL})${DRY ? ' — DRY RUN, nothing is sent' : ''}`);
  if (worst / 1e9 > MAX_SPEND_SOL) { console.error('refusing: the test would exceed MAX_SPEND_SOL'); process.exit(1); }
  if (!DRY && balance < worst + 1_000_000) { console.error('refusing: balance too low for the test plus a 0.001 SOL margin'); process.exit(1); }

  let slot = 0;
  conn.onSlotChange((s) => { slot = s.slot; });
  for (let w = 0; !slot && w < 100; w++) await new Promise((r) => setTimeout(r, 100));
  if (!slot) slot = await conn.getSlot('processed');

  const results = [];
  for (let i = 0; i < N; i++) {
    const r = routes[i % routes.length];
    const bh = (await call(STATUS_RPC, 'getLatestBlockhash', [{ commitment: 'processed' }])).result.value.blockhash;
    const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: bh }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }),
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 }));
    if (r.tip) tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: r.tip.to, lamports: r.tip.lamports }));
    tx.sign(kp);
    if (DRY) {
      const sim = await conn.simulateTransaction(tx);
      console.log(JSON.stringify({ i, route: r.name, bytes: tx.serialize().length, simulation: sim.value.err ? JSON.stringify(sim.value.err) : 'ok', cu: sim.value.unitsConsumed }));
      continue;
    }
    const b64 = tx.serialize().toString('base64'), sig = bs58.encode(tx.signature);
    const sendSlot = slot, t0 = Date.now();
    const accepted = await send(r, b64);
    let landSlot = null, ms = null;
    for (let k = 0; k < 75 && landSlot === null; k++) {
      await new Promise((z) => setTimeout(z, 200));
      const st = (await call(STATUS_RPC, 'getSignatureStatuses', [[sig]]).catch(() => ({}))).result?.value?.[0];
      if (st) { landSlot = st.slot; ms = Date.now() - t0; }
    }
    const row = { i, route: r.name, t: t0, sendSlot, landSlot, slots: landSlot === null ? null : landSlot - sendSlot, ms, accepted, signature: sig };
    results.push(row);
    console.log(JSON.stringify(row));
    if (OUT) fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
    await new Promise((z) => setTimeout(z, GAP_MS));
  }
  if (DRY) process.exit(0);

  const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : '-');
  console.log('\nroute            sent  landed  median slots  median ms   slots after send → count');
  for (const r of routes) {
    const rows = results.filter((x) => x.route === r.name), landed = rows.filter((x) => x.slots !== null);
    const dist = {}; for (const x of landed) dist[x.slots] = (dist[x.slots] || 0) + 1;
    console.log(`${r.name.padEnd(16)} ${String(rows.length).padStart(4)}  ${String(landed.length).padStart(6)}  ${String(med(landed.map((x) => x.slots))).padStart(12)}  ${String(med(landed.map((x) => x.ms))).padStart(9)}   `
      + Object.entries(dist).map(([s, c]) => `${s}→${c}`).join('  '));
  }
  console.log('"slots" = landing slot minus the latest slot this machine had seen when sending (slot notifications lag by a few hundred ms).');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
