# flashalpha-historical

Official JavaScript / TypeScript SDK for the **FlashAlpha Historical API** —
point-in-time replay of every live analytics endpoint. Ask what GEX, gamma
flip, VRP, narrative, max pain, or the full stock summary looked like at any
**minute back to 2018-04-16**, in the same response shape as the live API.

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
  const r = response as { regime: string; gamma_flip: number; underlying_price: number };
  console.log(at, r.regime, r.underlying_price, '↔', r.gamma_flip);
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
