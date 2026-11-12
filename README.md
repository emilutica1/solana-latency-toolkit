# Solana Latency Toolkit

Three small command-line tools that answer the questions every Solana trader, bot builder and infrastructure buyer
asks, with your own numbers, from your own machine:

| Tool | Question | Needs |
|---|---|---|
| [`feed-race.js`](#feed-race) | Which data source delivers an account update first: public WebSocket, paid RPC, or Yellowstone gRPC? | endpoints only, read-only |
| [`land-bench.js`](#landing-benchmark) | How many slots does my transaction take to land through each send route? | a throwaway wallet with a little SOL |
| [`ping.js`](#endpoint-ping) | Which region / endpoint is closest to my server? | nothing, read-only |

Built while running a latency-sensitive Solana liquidation bot, where the difference between landing in the same
slot and one slot later decides everything.

## Read this before you build a liquidation bot

We built these tools while trying, for more than two years, to run a profitable Solana liquidation bot on free and
low-cost infrastructure: public RPC, free API tiers, a home connection and later a small VPS. **We never found
evidence that it can be done.** This is not a mathematical proof that it is impossible, but it is what our own
measurements showed, and we are publishing it so that others don't spend years finding out the same way.

What the data showed:

- **We lost every race.** On Kamino, 64 real liquidation attempts between 2026-10-22 and 2026-11-05 all landed on
  chain and all failed: each landed 1 to 12 slots after the winning bot, when the position was already liquidated.
  Every attempt still paid fees and tips.
- **The winners land in the same slot as the price change.** About two thirds of winning Kamino liquidations refresh
  the oracle price inside their own transaction, so by the time a public feed shows the position as liquidatable,
  the liquidation is often already done.
- **Public data feeds are too slow.** The public WebSocket delivered price updates a median of 170 to 190 ms after a
  dedicated feed (Yellowstone gRPC or a paid RPC), about half a slot.
- **The market is concentrated.** In one month of Kamino data (1,763 liquidations), 69 wallets did all of it and the
  top two did 39%.
- **Most opportunities are too small to pay for themselves.** In a two-week study of 4,217 liquidations on another
  Solana lending protocol, our real cost per attempt was about $0.15, so a liquidation had to seize about $3 just to
  break even. Only 41 of the 4,217 did.

What the winners appear to have that public infrastructure does not: dedicated low-latency data feeds (gRPC or
shredstream), servers next to the validators and block engines, staked or priority transaction routes, their own
capital instead of flash loans, and enough volume to absorb the losing attempts.

If you are starting out, measure before you invest: run `feed-race.js` and `land-bench.js` from the machine you plan
to use and compare the slot numbers with the winners' landing slots. If you are one or more slots behind, faster
code will not close the gap; only infrastructure will.

## Install

Requires Node.js 18 or newer.

```bash
git clone https://github.com/emilutica1/solana-latency-toolkit
cd solana-latency-toolkit
npm install
```

## Feed race

Subscribes to the same account on several sources at once and records, for every slot in which the account changed,
when each source delivered it. All arrival times come from one clock (this machine), so the comparison is fair.

```bash
SOURCES="public=ws:https://api.mainnet-beta.solana.com|wss://api.mainnet-beta.solana.com \
         myrpc=ws:https://my-rpc.example/KEY|wss://my-rpc.example/KEY \
         mygrpc=grpc:https://my-grpc.example:443|X_TOKEN" \
DURATION_S=180 node feed-race.js --out races.jsonl
```

- `name=ws:<http url>|<wss url>`: WebSocket `accountSubscribe` on any Solana RPC.
- `name=grpc:<url>|<x-token>`: Yellowstone gRPC account subscription.
- `ACCOUNT` sets the account to watch. The default is Kamino's Scope oracle price account, which changes almost every slot.

Output:

```
account 3NJYftD5…, 180 s: 68 slots with an update, 68 seen by every source
source            first   ms behind first: median   p90   max
grpc                  4                         4  …
paid-ws              65                         0  …
public                0                       187  …
```

## Landing benchmark

Sends N tiny transactions (1 lamport to yourself, plus the route's tip and a priority fee) and measures the
landing slot relative to the slot when it was sent. Routes are compared by alternating: transaction *i* goes to
route *i mod R*.

> **This spends real SOL** (per transaction: 5,000 lamports base fee + priority fee + tip; about 0.000016 SOL with the
> defaults). Use a separate throwaway wallet holding only what the test needs. The tool refuses to start if the
> worst-case cost exceeds `MAX_SPEND_SOL` (default 0.01) or the balance is too low, and `--dry-run` builds and
> simulates every transaction without sending anything.

```bash
solana-keygen new -o throwaway.json        # fund it with ~0.005 SOL
WALLET=throwaway.json N=20 node land-bench.js --dry-run     # check first
WALLET=throwaway.json N=20 \
ROUTES="jito-ny=rpc:https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions|tip=96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5:1000 \
        public=rpc:https://api.mainnet-beta.solana.com" \
node land-bench.js --out landing.jsonl
```

- `name=rpc:<url>[|tip=<address>:<lamports>]`: any endpoint that accepts JSON-RPC `sendTransaction` (an RPC, a Jito
  block engine, Helius Sender, …). Check each provider's documentation for its tip accounts and minimum tip.
- `name=blx:<url>|auth=<header>[|tip=<address>:<lamports>]`: bloXroute `/api/v2/submit`.
- `PRIORITY_MICROLAMPORTS` (default ≈ 10,000 lamports in total), `GAP_MS` between sends (default 2,000), `STATUS_RPC` for
  slot tracking and confirmation (default public mainnet).

## Endpoint ping

```bash
node ping.js                                       # Jito block-engine regions + public RPCs
ENDPOINTS="a=https://rpc-a.example b=https://rpc-b.example" node ping.js
```

One warm-up request per endpoint, then 7 timed requests on the open connection; prints min and median, fastest first.

## Fan-out sender

`fan-out.js` is a small module, not a command: it sends the **same signed transaction** to several routes at once
(any RPC, Jito block engines, Helius Sender…) and can keep re-sending those same bytes until it confirms. It is the
send path from our liquidation bot.

```js
const { sendToAll, startResend, jitoRoutes, formatResults } = require('./fan-out');

const routes = [
  { name: 'rpc', url: process.env.RPC_URL, opts: { skipPreflight: true, maxRetries: 3 } },
  ...jitoRoutes(['ny', 'frankfurt']),          // 1 request/s per region, enforced in the resend loop
];
const base64 = Buffer.from(signedTx.serialize()).toString('base64');
console.log(formatResults(await sendToAll(base64, routes)));   // "rpc ok 41 ms, jito-ny ok 38 ms, jito-frankfurt ok 115 ms"
const stop = startResend(base64, routes, { everyMs: 300, maxMs: 4000 });
// ... wait for confirmation, then:
stop();
```

Why this is safe: one signed transaction has one signature, and the network accepts a signature only once, so the same
bytes sent to ten routes, or ten times, land at most once. **Never re-sign inside a resend loop**: signing again with a
new blockhash makes a different transaction that can land a second time. Jito and Sender accept only a transaction
that already pays them a tip.

Each result says whether that route *accepted* the transaction, not which route got it into a block; use
`land-bench.js` for that. `npm test` runs offline tests against a local mock server.

What it did for us: more routes made our transactions land sooner, but not soon enough. The winning liquidators
landed in the same block as the price update, often refreshing the oracle inside their own transaction, so sending
faster after seeing the update could not catch up.

## Our measurements

These are real runs from our own setup, in November 2026. The samples are small, so treat them as examples of what
the tools show, not as provider rankings.

**Endpoint ping**, median round trip:

| Endpoint | Home connection, upstate New York | VPS in New York |
|---|---|---|
| Jito block engine, NY | 20.4 ms | **4.6 ms** |
| Solana public RPC | 29.4 ms | 31.0 ms |
| Jito block engine, Salt Lake City | 59.1 ms | 48.4 ms |
| Jito block engine, Frankfurt | 92.8 ms | 87.1 ms |

**Landing**, the same transaction sent to Helius Sender + Jito NY + an RPC at once, 30 transactions each:

| Location | Landed in the next slot | Median slots | Median ms to land |
|---|---|---|---|
| Home connection, upstate New York | 50% | 2 | 719 |
| VPS in New York | **77%** | **1** | 704 |

bloXroute's free tier, alternating with our own routes from the home connection (10 transactions each): median 2 slots
for both, so no gain in that test.

**Feed race** on Kamino's Scope oracle account:

| Location | Sources | Result |
|---|---|---|
| Home connection | Yellowstone gRPC (free tier), paid WebSocket RPC, public WebSocket | paid WebSocket first in 65/68 slots, gRPC a median 4 ms behind, public WebSocket a median 187 ms behind |
| VPS in New York | Yellowstone gRPC (free tier), public WebSocket | gRPC first in 66/66 slots, public WebSocket a median 170 ms behind |

The public WebSocket is consistently 170–190 ms behind a dedicated feed. That is roughly half a slot, which is decisive
for anything competitive.

## Related

- [kamino-liquidation-tracker](https://github.com/emilutica1/kamino-liquidation-tracker): records every Kamino
  liquidation as it happens, and who did it.
- [kamino-health-scanner](https://github.com/emilutica1/kamino-health-scanner): health of every Kamino borrowing
  position, distance to liquidation, and price-shock scenarios.
- [kamino-liquidation-alerts](https://github.com/emilutica1/kamino-liquidation-alerts): Telegram bot that warns
  borrowers before their position can be liquidated.
- [solana-spend-guard](https://github.com/emilutica1/solana-spend-guard): fail-closed spending limits for bots that
  send real transactions.

## Credits

Built by [emilutica1](https://github.com/emilutica1) and Claude, Anthropic's AI model, working together through
[Claude Code](https://claude.com/claude-code). Issues and pull requests are welcome.

## License

MIT. See [LICENSE](LICENSE).
