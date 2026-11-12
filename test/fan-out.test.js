'use strict';
// Offline: a local HTTP server stands in for the routes. Nothing is sent to Solana.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { sendToAll, startResend, jitoRoutes } = require('../fan-out');

function server(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const s = http.createServer((req, res) => {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => { hits.push({ path: req.url, body: JSON.parse(body), t: Date.now() }); handler(req, res); });
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, hits, base: `http://127.0.0.1:${s.address().port}` }));
  });
}
const json = (res, obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };

test('sends the same bytes to every route and labels each result', async () => {
  const { s, hits, base } = await server((req, res) => {
    if (req.url === '/ok') return json(res, { jsonrpc: '2.0', id: 1, result: 'SIG' });
    if (req.url === '/rejects') return json(res, { jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'blockhash not found' } });
    res.statusCode = 429; res.end('Too Many Requests');
  });
  const routes = [{ name: 'a', url: `${base}/ok`, opts: { skipPreflight: true } }, { name: 'b', url: `${base}/rejects` }, { name: 'c', url: `${base}/limited` }];
  const r = await sendToAll('AQID', routes);
  s.close();
  assert.deepEqual(r.map((x) => [x.route, x.ok]), [['a', true], ['b', false], ['c', false]]);
  assert.equal(r[0].signature, 'SIG');
  assert.match(r[1].error, /blockhash not found/);
  assert.match(r[2].error, /HTTP 429/);
  assert.equal(hits.length, 3);
  for (const h of hits) { assert.equal(h.body.method, 'sendTransaction'); assert.equal(h.body.params[0], 'AQID'); assert.equal(h.body.params[1].encoding, 'base64'); }
  assert.equal(hits.find((h) => h.path === '/ok').body.params[1].skipPreflight, true);
});

test('a slow route times out without holding up the others', async () => {
  const { s, base } = await server((req, res) => { if (req.url === '/slow') setTimeout(() => json(res, { result: 'late' }), 1500); else json(res, { result: 'SIG' }); });
  const t0 = Date.now();
  const r = await sendToAll('AQID', [{ name: 'fast', url: `${base}/fast` }, { name: 'slow', url: `${base}/slow`, timeoutMs: 200 }]);
  s.close();
  assert.equal(r[0].ok, true);
  assert.deepEqual([r[1].ok, r[1].error], [false, 'timeout']);
  assert.ok(Date.now() - t0 < 1000);
});

test('an unreachable route is an error result, not a crash', async () => {
  const r = await sendToAll('AQID', [{ name: 'dead', url: 'http://127.0.0.1:1/', timeoutMs: 500 }]);
  assert.equal(r[0].ok, false);
});

test('resend: same bytes, every route at its own pace, stops on time', async () => {
  const { s, hits, base } = await server((req, res) => json(res, { result: 'SIG' }));
  const stop = startResend('AQID', [{ name: 'rpc', url: `${base}/rpc` }, { name: 'jito', url: `${base}/jito`, minIntervalMs: 1000 }], { everyMs: 200, maxMs: 1100 });
  await new Promise((r) => setTimeout(r, 1400));
  const n = stop();
  await new Promise((r) => setTimeout(r, 100));
  s.close();
  const rpc = hits.filter((h) => h.path === '/rpc').length, jito = hits.filter((h) => h.path === '/jito').length;
  assert.ok(rpc >= 4 && rpc <= 5, `rpc resends ${rpc}`);
  assert.equal(jito, 1, 'the 1 s route is resent once in 1.1 s');
  assert.equal(n, rpc + jito);
  assert.ok(hits.every((h) => h.body.params[0] === 'AQID'));
});

test('stop() ends resending at once', async () => {
  const { s, hits, base } = await server((req, res) => json(res, { result: 'SIG' }));
  const stop = startResend('AQID', [{ name: 'rpc', url: `${base}/rpc` }], { everyMs: 100, maxMs: 5000 });
  await new Promise((r) => setTimeout(r, 350));
  stop();
  const after = hits.length;
  await new Promise((r) => setTimeout(r, 400));
  s.close();
  assert.equal(hits.length, after);
});

test('jitoRoutes', () => {
  assert.deepEqual(jitoRoutes(['ny', 'tokyo']).map((r) => r.name), ['jito-ny', 'jito-tokyo']);
  assert.equal(jitoRoutes('all').length, 8);
  assert.equal(jitoRoutes(['ny'], { global: true })[0].url, 'https://mainnet.block-engine.jito.wtf/api/v1/transactions');
  assert.throws(() => jitoRoutes(['mars']), /unknown Jito region/);
});
