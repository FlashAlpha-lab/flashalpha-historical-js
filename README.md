# flashalpha-historical

Official JavaScript / TypeScript SDK for the **FlashAlpha Historical API** —
point-in-time replay of every live analytics endpoint. Ask what GEX, gamma
flip, VRP, narrative, max pain, or the full stock summary looked like at any
**minute back to 2017-01-03**, in the same response shape as the live API.

> **Point-in-time replay since 2017.** Backtest dealer positioning (GEX, VRP,
> vanna/charm, max pain) at any minute since 2017-01-03, then trade the same
> endpoints live. No look-ahead, no training-serving skew. The Historical API
> is an **Alpha tier** capability.

```bash
npm install flashalpha-historical
```

Node.js 18+. Uses native `fetch` and `AbortController`. Same `X-Api-Key` you
use for `api.flashalpha.com` — Alpha plan or higher on every endpoint.

## Quickstart

```ts
import { FlashAlphaHistorical } from 'flashalpha-historical';

const hx = new FlashAlphaHistorical(process.env.FLASHALPHA_API_KEY!);

// One snapshot — what dealer positioning looked like at the COVID-crash close
const snap = await hx.exposureSummary('SPY', { at: '2020-03-16T15:30:00' });
console.log(snap);
```

`at` accepts:
- `'2026-03-05T15:30:00'` — minute-level
- `'2026-03-05'` — defaults to 16:00 ET
- `Date` — formatted using the local clock (the SDK assumes ET wall-clock)

## sell-window replay: what did it say on any session since 2018?

[sell-window](https://flashalpha.com/docs/lab-api-strategies-sell-window?utm_source=github&utm_medium=readme&utm_campaign=repo-flashalpha-historical-js&utm_content=sell-window) answers "should you sell options today?" every session for SPY, QQQ and IWM. Option sellers get wiped out on a few bad days. sell-window tells you which days to stay out, and on the days it says sell, it hands you the trades: which expiry, which strikes and how to exit. Every session, for SPY, QQQ and IWM. More than 5 million backtests led to this one endpoint.

This package replays the answer for any past session, strikes included, so you can check the backtest yourself or test your own rules on the same calls.

```typescript
import { FlashAlphaHistorical } from 'flashalpha-historical';

const hx = new FlashAlphaHistorical('YOUR_API_KEY');
const answer = await hx.sellWindow('SPY', { at: '2026-10-16T09:35:00' });

for (const window of answer.windows ?? []) {
  console.log(window.expiry, window.action); // sell, skip or unavailable
  for (const trade of window.candidates ?? []) {
    console.log(' ', trade.structure, trade.mid_credit, trade.exit);
  }
}
```

The backtests entered at 09:35 ET, so `at=<session>T09:35:00` returns the backtest's entry strikes. The session switches at the close, so an `at` after the close, including a date-only `at` (read as 16:00 ET), returns the answer for the next session. An `at` before the archive starts returns every window as `unavailable`. An `at` before the open can return candidates without legs, because no chain is available yet. A malformed or future `at` returns `400 invalid_at`.

From the live launch on, the action and trades match what the live endpoint answered at that time. Before it they are rebuilt from the archive with the same rules.

| Backtest, 2018 to 2026 | Following sell-window | Selling the same trades every day |
|---|---|---|
| Max drawdown at the same trade size | $255k | $959k |
| Worst month at the same trade size | -$171k | -$307k |
| Sharpe ratio | 0.76 | 0.61 |
| Total P&L at the same max drawdown | $3.55M | $2.32M |
| Worst day at the same max drawdown | -$258k | -$385k |

Cut the risk or earn more. Keep your trade size and the deepest drawdown falls 73%. Or size up about 3.8 times, until the deepest drawdown matches, and you earn 53% more. These are two separate choices, not one result.

**Plans:** Live answers need Basic or higher through November 2026, and Growth or higher from December 1, 2026. Backtesting any past session needs Alpha or higher. For live answers, use [flashalpha-js](https://github.com/FlashAlpha-lab/flashalpha-js).

**Read more:** [API docs](https://flashalpha.com/docs/historical-sell-window?utm_source=github&utm_medium=readme&utm_campaign=repo-flashalpha-historical-js&utm_content=sell-window) | [trading guide](https://flashalpha.com/articles/complete-guide-trading-sell-window-spy-qqq-iwm?utm_source=github&utm_medium=readme&utm_campaign=repo-flashalpha-historical-js&utm_content=sell-window) | [every backtested trade](https://flashalpha.com/articles/sell-window-backtest-every-trade-2018-2026?utm_source=github&utm_medium=readme&utm_campaign=repo-flashalpha-historical-js&utm_content=sell-window) | [sell-window in depth](https://github.com/FlashAlpha-lab/flashalpha-historical-js/blob/main/docs/sell-window.md) | [plans](https://flashalpha.com/pricing?utm_source=github&utm_medium=readme&utm_campaign=repo-flashalpha-historical-js&utm_content=sell-window) | [live forward test on Discord](https://discord.gg/UtH22J8df2)

*Backtest on SPY, QQQ and IWM, January 2018 to October 2026, at halfway fills and $1 per contract. At one contract set per signal, following it made $945,541 on 20,883 trades; selling every day made $2,321,150 on 56,975. At 3.76 times the contracts, both fell $958,924 at their deepest, and the worst month was -$642,135 against -$307,241. Past results do not guarantee future returns, and short options can lose more than the premium collected. The skip call applies to new trades, so it cannot protect open positions from a sudden shock. This is data, not investment advice.*

## Data provenance: `data_as_of`

Every successful response carries `data_as_of`, reporting when each upstream feed last
delivered to the node that answered, plus `endpoint_version` identifying the deployment
that produced it. Every endpoint on this replay service returns a JSON object, so unlike
the live SDK there is no bare-array case where the envelope is unavailable.

```ts
const gex = await fa.gex('SPY', { at: '2024-03-15T14:30:00Z' });

gex.archive_as_of.equity_options_feed; // '2024-03-15T14:29:58.100Z'  the rows replayed
gex.archive_as_of.oi_feed;             // '2024-03-14T20:00:00.000Z'  prior session's close
gex.data_as_of.equity_options_feed;    // null - a replay node consumes no live feed
gex.endpoint_version;                  // the deployment that answered
```

`DataAsOf` and `ArchiveAsOf` are exported from the package root:

```ts
import type { DataAsOf, ArchiveAsOf } from 'flashalpha-historical';
```

| Field | Feed | Expected cadence |
|---|---|---|
| `node` | Which node answered | Nodes hydrate independently |
| `equity_feed` | Equity and ETF spot quotes | seconds, during market hours |
| `equity_options_feed` | Equity and ETF option quotes | seconds, during market hours |
| `index_feed` | Index spot (SPX, RUT, VIX and the other index roots) | seconds, during market hours |
| `index_options_feed` | Index option quotes | seconds, during market hours |
| `futures_feed` | Futures prices | seconds, during the futures session |
| `futures_options_feed` | Futures option quotes | seconds, during the futures session |
| `flow_feed` | Classified options and stock trade tape | seconds, during market hours |
| `oi_feed` | Settled open interest | daily, dated to the prior 16:00 ET close |
| `macro_feed` | VIX, VVIX, SKEW, MOVE, SPX, Fear & Greed | minutes; reports its OLDEST component |

Historical responses carry a second object, `archive_as_of`, in the same shape: the
vintage of the archive rows actually replayed for the timestamp you requested. Its
every feed in `data_as_of` is `null`, because a replay node reads the archive and consumes no
live feed.

`archive_as_of` is what makes an archive gap detectable. Request a moment with no row
and the query returns the most recent earlier row; nothing else in the response
distinguishes the two. Point-in-time work should read it and drop or flag observations
whose inputs precede the requested instant by more than the study tolerates.

### How to read it

- **Check the feeds your call depends on.** A GEX call on an equity is answered from
  `equity_feed`, `equity_options_feed` and `oi_feed`. `futures_feed` being `null` in that
  response says nothing about the answer.
- **Compare against the cadence, not the clock.** `oi_feed` at the previous session's
  close is correct: settled open interest is published once per session, so on a Monday
  the newest figure that exists is Friday's. An options feed an hour behind during the
  regular session is not correct.
- **`null` means "not seen on this node", not "broken".** A node that has never been
  asked for a futures symbol has never opened that feed.
- **Spot and options are separate on purpose.** They arrive over different pipes and can
  fail independently.
- **It evidences feed activity, not per-contract freshness.** An illiquid strike may not
  have quoted for hours while its feed is healthy.
- **`data_as_of` is not `as_of`.** `as_of` is response-generation time or the newest
  contract in the payload, depending on the endpoint. `data_as_of` describes the feeds
  behind it.

Full reference: <https://flashalpha.com/docs/lab-api-overview#response-envelope> and the
methodology whitepaper at <https://flashalpha.com/methodology#freshness-reporting>.
## Backtesting

The SDK ships with replay utilities — turn any endpoint into an async
iterator over a date / minute range, with a built-in NYSE holiday calendar
(2018-2026) and silent skipping of gap days.

### Daily backtest

```ts
import {
  Backtester,
  FlashAlphaHistorical,
  iterDays,
} from 'flashalpha-historical';

const hx = new FlashAlphaHistorical(process.env.FLASHALPHA_API_KEY!);

const bt = new Backtester(hx, { method: 'stockSummary', symbol: 'SPY' });

type Snap = {
  volatility: { vrp: number; atm_iv: number };
  exposure: { regime: string };
};

const results = await bt.run<Snap, { fire: boolean; vrp: number }>(
  iterDays('2024-01-02', '2024-03-29'),
  (_at, snap) => ({
    fire: snap.volatility.vrp > 5 && snap.exposure.regime === 'positive_gamma',
    vrp: snap.volatility.vrp,
  }),
);

const fires = results.filter((r) => r.output.fire);
console.log(`fires: ${fires.length} / ${results.length}`);
```

### Minute-level replay

```ts
import { iterMinutes, replay } from 'flashalpha-historical';

for await (const { at, response } of replay(
  hx,
  'exposureSummary',
  'SPY',
  iterMinutes('2025-01-15', '2025-01-15', { stepMinutes: 15 }),
)) {
  const r = response as {
    regime: string;
    gamma_flip: number | null;
    gamma_flip_status?: string | null;
    underlying_price: number;
  };
  // `gamma_flip` is often `null` — the server withholds the level when it cannot
  // stand behind it, and `gamma_flip_status` says why (`'available'`, `'no_boundary'`,
  // `'insufficient_quote_quality'`, ...). Treat anything other than `'available'`
  // as unavailable; new reason codes can be added at any time.
  const flip = r.gamma_flip !== null && r.gamma_flip !== undefined
    ? r.gamma_flip.toFixed(2)
    : `n/a (${r.gamma_flip_status ?? 'unknown'})`;
  console.log(at, r.regime, r.underlying_price, '↔', flip);
}
```

> **Quota:** every call counts against your daily plan quota (shared with
> live). A 1-minute replay = 390 calls per analytic per day. Use `stepMinutes`
> for development loops.

## API

Every analytics method takes `{ at: string | Date }` (plus optional filters).

| Method | Endpoint |
|---|---|
| `tickers({symbol?})` | `GET /v1/tickers` |
| `stockQuote(t, {at})` | `/v1/stockquote/{t}` |
| `optionQuote(t, {at, expiry?, strike?, type?})` | `/v1/optionquote/{t}` |
| `surface(s, {at})` | `/v1/surface/{s}` |
| `gex(s, {at, expiration?, minOi?})` | `/v1/exposure/gex/{s}` |
| `dex(s, {at, expiration?})` | `/v1/exposure/dex/{s}` |
| `vex(s, {at, expiration?})` | `/v1/exposure/vex/{s}` |
| `chex(s, {at, expiration?})` | `/v1/exposure/chex/{s}` |
| `exposureSummary(s, {at})` | `/v1/exposure/summary/{s}` |
| `exposureLevels(s, {at})` | `/v1/exposure/levels/{s}` |
| `narrative(s, {at})` | `/v1/exposure/narrative/{s}` |
| `zeroDte(s, {at, strikeRange?})` | `/v1/exposure/zero-dte/{s}` |
| `maxPain(s, {at, expiration?})` | `/v1/maxpain/{s}` |
| `stockSummary(s, {at})` | `/v1/stock/{s}/summary` |
| `volatility(s, {at})` | `/v1/volatility/{s}` |
| `advVolatility(s, {at})` | `/v1/adv_volatility/{s}` |
| `vrp(s, {at})` | `/v1/vrp/{s}` |
| `sellWindow(s, {at})` | `/v1/strategies/sell-window/{s}` |

## Errors

```ts
import {
  FlashAlphaHistoricalError,  // base
  AuthenticationError,        // 401
  TierRestrictedError,        // 403 — needs Alpha plan
  InvalidAtError,             // 400 — bad `at` format
  NoDataError,                // 404 — outside coverage / inside gap
  SymbolNotFoundError,        // 404 — symbol not at this `at`
  NoCoverageError,            // 404 — symbol not in historical dataset
  InsufficientDataError,      // 404 — surface grid too sparse
  RateLimitError,             // 429
  ServerError,                // 5xx
} from 'flashalpha-historical';
```

## Known gaps from live (intentional, documented)

- `optionQuote.bidSize` / `askSize` / `volume` always `0`
- `optionQuote.svi_vol` always `null` (`svi_vol_gated: "backtest_mode"`)
- `gex.call_volume` / `put_volume` always `0`; `call_oi_change` /
  `put_oi_change` always `null`
- `narrative.data.top_oi_changes` empty array
- `stockSummary.macro.vix_futures` / `fear_and_greed` always `null`
- `vrp.macro.hy_spread` hard-coded `3.5`
- 0DTE intraday greeks may arrive as `0` / `null` — chain still listed for OI
  analysis

## License

MIT

## Get access

The Historical API requires the **Alpha tier ($1,499/mo)**: the only public source
of aggregate vanna/charm exposure and point-in-time replay since 2017.

Quant teams, prop desks, and vol funds:
**[flashalpha.com/for-quant-teams](https://flashalpha.com/for-quant-teams?utm_source=github&utm_medium=readme&utm_campaign=repo-flashalpha-historical-js)**
