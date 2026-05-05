/**
 * Integration tests — hit the live https://historical.flashalpha.com.
 *
 * Skipped unless `FLASHALPHA_API_KEY` is set. Run with:
 *   FLASHALPHA_API_KEY=fa_... npx jest tests/integration.test.ts
 */
import {
  Backtester,
  FlashAlphaHistorical,
  InvalidAtError,
  NoCoverageError,
  NoDataError,
  iterDays,
  iterMinutes,
  replay,
} from '../src';

const API_KEY = process.env.FLASHALPHA_API_KEY;
const describeIntegration = API_KEY ? describe : describe.skip;

const SPY_AT = '2024-08-05T15:30:00';
const SPY_DATE = '2024-08-05';
const EXPECTED_SPOT = 516.435;
const SPOT_TOL = 1.0;

const REGIMES = new Set(['positive_gamma', 'negative_gamma', 'neutral', 'undetermined']);
// Summary and zero-dte both use lowercase buy/sell directions.
const HEDGING_DIRECTIONS = new Set(['buy', 'sell']);

// ── helpers ────────────────────────────────────────────────────────────────

function mkClient(): FlashAlphaHistorical {
  return new FlashAlphaHistorical(API_KEY!, { timeout: 60_000 });
}

// ──────────────────────────────────────────────────────────────────────────────

describeIntegration('integration: coverage', () => {
  const hx = mkClient();

  test('tickers lists SPY', async () => {
    const out = (await hx.tickers()) as {
      count: number;
      tickers: Array<{ symbol: string }>;
    };
    expect(out.count).toBeGreaterThanOrEqual(1);
    expect(out.tickers.map((t) => t.symbol)).toContain('SPY');
  });

  test('tickers?symbol=SPY returns single object with coverage', async () => {
    const out = (await hx.tickers({ symbol: 'SPY' })) as {
      symbol: string;
      coverage: { first: string; last: string; healthy_days: number };
      gaps: Record<string, number>;
    };
    expect(out.symbol).toBe('SPY');
    expect(out.coverage.first <= '2024-08-05').toBe(true);
    expect(out.coverage.last >= '2024-08-05').toBe(true);
    expect(out.coverage.healthy_days).toBeGreaterThan(0);
    expect(Object.keys(out.gaps)).toEqual(
      expect.arrayContaining(['missing_eod', 'missing_svi', 'uncovered_calendar']),
    );
  });

  test('unknown symbol → NoCoverageError', async () => {
    await expect(hx.tickers({ symbol: 'ZZZZZ' })).rejects.toBeInstanceOf(
      NoCoverageError,
    );
  });
});

describeIntegration('integration: market data', () => {
  const hx = mkClient();

  test('stockQuote at minute resolution', async () => {
    const q = (await hx.stockQuote('SPY', { at: SPY_AT })) as {
      ticker: string;
      bid: number;
      mid: number;
      ask: number;
      lastUpdate: string;
    };
    expect(q.ticker).toBe('SPY');
    expect(q.bid).toBeLessThanOrEqual(q.mid);
    expect(q.mid).toBeLessThanOrEqual(q.ask);
    expect(Math.abs(q.mid - EXPECTED_SPOT)).toBeLessThan(SPOT_TOL);
    expect(q.lastUpdate).toBe(SPY_AT);
  });

  test('stockQuote date-only defaults to 16:00 close', async () => {
    const q = (await hx.stockQuote('SPY', { at: SPY_DATE })) as {
      lastUpdate: string;
    };
    expect(q.lastUpdate).toMatch(/T16:00:00$/);
  });

  test('optionQuote with all 3 filters returns single object + greeks', async () => {
    const q = (await hx.optionQuote('SPY', {
      at: SPY_AT,
      expiry: '2024-08-09',
      strike: 520,
      type: 'C',
    })) as {
      type: string;
      strike: number;
      bid: number;
      mid: number;
      ask: number;
      delta: number;
      gamma: number;
      theta: number;
      vega: number;
      bidSize: number;
      askSize: number;
      volume: number;
      svi_vol: number | null;
      svi_vol_gated: string;
      open_interest: number;
    };
    expect(q.strike).toBe(520);
    expect(q.type).toBe('C');
    for (const g of ['delta', 'gamma', 'theta', 'vega'] as const) {
      expect(typeof q[g]).toBe('number');
    }
    // Documented historical-mode gaps
    expect(q.bidSize).toBe(0);
    expect(q.askSize).toBe(0);
    expect(q.volume).toBe(0);
    expect(q.svi_vol).toBeNull();
    expect(q.svi_vol_gated).toBe('backtest_mode');
    expect(q.open_interest).toBeGreaterThanOrEqual(0);
  });
});

describeIntegration('integration: exposure', () => {
  const hx = mkClient();

  test('exposure summary — every field declared in ExposureSummaryResponse must be referenced', async () => {
    const s = (await hx.exposureSummary('SPY', { at: SPY_AT })) as {
      symbol: string;
      underlying_price: number;
      as_of: string;
      regime: string;
      gamma_flip: number;
      exposures: { net_gex: number; net_dex: number; net_vex: number; net_chex: number };
      hedging_estimate: {
        spot_up_1pct: { dealer_shares_to_trade: number; direction: string; notional_usd: number };
        spot_down_1pct: { dealer_shares_to_trade: number; direction: string; notional_usd: number };
      };
      interpretation: { gamma: string; vanna: string; charm: string };
      zero_dte: { net_gex: number | null; pct_of_total_gex: number | null; expiration: string | null };
    };
    // ── top-level scalars ──
    expect(s.symbol).toBe('SPY');
    expect(typeof s.underlying_price).toBe('number');
    expect(Math.abs(s.underlying_price - EXPECTED_SPOT)).toBeLessThan(SPOT_TOL);
    expect(typeof s.as_of).toBe('string');
    expect(s.as_of.length).toBeGreaterThan(0);
    expect(s.as_of).toBe(SPY_AT);  // historical snaps to the requested minute
    expect(REGIMES.has(s.regime)).toBe(true);
    expect(typeof s.gamma_flip).toBe('number');
    // ── exposures block (4 fields) ──
    for (const k of ['net_gex', 'net_dex', 'net_vex', 'net_chex'] as const) {
      expect(typeof s.exposures[k]).toBe('number');
    }
    // ── interpretation block (3 fields) ──
    for (const k of ['gamma', 'vanna', 'charm'] as const) {
      expect(typeof s.interpretation[k]).toBe('string');
      expect(s.interpretation[k].length).toBeGreaterThan(0);
    }
    // ── hedging_estimate (every leaf field on both sides) ──
    const up = s.hedging_estimate.spot_up_1pct;
    const down = s.hedging_estimate.spot_down_1pct;
    for (const side of [up, down]) {
      expect(HEDGING_DIRECTIONS.has(side.direction)).toBe(true);
      expect(typeof side.dealer_shares_to_trade).toBe('number');
      expect(typeof side.notional_usd).toBe('number');
      expect(side.notional_usd).not.toBe(0);
    }
    expect(up.dealer_shares_to_trade).toBe(-down.dealer_shares_to_trade);
    expect(Math.abs(up.notional_usd)).toBe(Math.abs(down.notional_usd));
    // ── zero_dte block (3 fields) ──
    expect(s.zero_dte).toBeDefined();
    expect('net_gex' in s.zero_dte).toBe(true);
    expect(s.zero_dte.net_gex === null || typeof s.zero_dte.net_gex === 'number').toBe(true);
    expect('pct_of_total_gex' in s.zero_dte).toBe(true);
    expect(s.zero_dte.pct_of_total_gex === null || typeof s.zero_dte.pct_of_total_gex === 'number').toBe(true);
    expect('expiration' in s.zero_dte).toBe(true);
    expect(s.zero_dte.expiration === null || typeof s.zero_dte.expiration === 'string').toBe(true);
  });

  test('levels keys present', async () => {
    const out = (await hx.exposureLevels('SPY', { at: SPY_AT })) as {
      levels: Record<string, number | null>;
    };
    for (const k of [
      'gamma_flip', 'max_positive_gamma', 'max_negative_gamma',
      'call_wall', 'put_wall', 'highest_oi_strike',
    ]) {
      expect(out.levels).toHaveProperty(k);
    }
  });

  test('gex strikes shape + documented zeros', async () => {
    const gex = (await hx.gex('SPY', { at: SPY_AT, minOi: 100 })) as {
      net_gex: number;
      strikes: Array<{
        strike: number;
        call_volume: number;
        put_volume: number;
        call_oi_change: number | null;
        put_oi_change: number | null;
      }>;
    };
    expect(gex.strikes.length).toBeGreaterThan(5);
    const sample = gex.strikes[0];
    expect(sample.call_volume).toBe(0);
    expect(sample.put_volume).toBe(0);
    expect(sample.call_oi_change).toBeNull();
    expect(sample.put_oi_change).toBeNull();
  });

  test('dex payload', async () => {
    const out = (await hx.dex('SPY', { at: SPY_AT })) as {
      payload: { net_dex: number; strikes: unknown[] };
    };
    expect(typeof out.payload.net_dex).toBe('number');
    expect(Array.isArray(out.payload.strikes)).toBe(true);
  });

  test('vex payload + interpretation', async () => {
    const out = (await hx.vex('SPY', { at: SPY_AT })) as {
      payload: { net_vex: number; vex_interpretation: string };
    };
    expect(typeof out.payload.net_vex).toBe('number');
    expect(typeof out.payload.vex_interpretation).toBe('string');
  });

  test('chex payload + interpretation', async () => {
    const out = (await hx.chex('SPY', { at: SPY_AT })) as {
      payload: { net_chex: number; chex_interpretation: string };
    };
    expect(typeof out.payload.net_chex).toBe('number');
    expect(typeof out.payload.chex_interpretation).toBe('string');
  });

  test('narrative returns all blocks; top_oi_changes empty', async () => {
    const out = (await hx.narrative('SPY', { at: SPY_AT })) as {
      narrative: {
        regime: string;
        gex_change: string;
        key_levels: string;
        flow: string;
        vanna: string;
        charm: string;
        zero_dte: string;
        data: { vix: number | null; top_oi_changes: unknown[] };
      };
    };
    for (const block of [
      'regime', 'gex_change', 'key_levels', 'flow', 'vanna', 'charm', 'zero_dte',
    ] as const) {
      expect(typeof out.narrative[block]).toBe('string');
    }
    expect(out.narrative.data.top_oi_changes).toEqual([]);
    expect(out.narrative.data.vix).not.toBeNull();
  });

  test('zero_dte basic shape', async () => {
    const out = (await hx.zeroDte('SPY', { at: SPY_AT })) as {
      expiration: string | null;
      regime: unknown;
      exposures: unknown;
    };
    expect(out).toHaveProperty('expiration');
    expect(out).toHaveProperty('regime');
    expect(out).toHaveProperty('exposures');
  });
});

describeIntegration('integration: composite & vol', () => {
  const hx = mkClient();

  test('stock summary block keys', async () => {
    const s = (await hx.stockSummary('SPY', { at: SPY_AT })) as {
      symbol: string;
      price: { mid: number };
      volatility: { atm_iv: number; vrp: number };
      options_flow: {
        total_call_volume: number;
        total_put_volume: number;
        pc_ratio_volume: number | null;
      };
      exposure: { regime: string };
      macro: {
        vix: { value: number };
        vix_futures: unknown;
        fear_and_greed: unknown;
      };
    };
    expect(s.symbol).toBe('SPY');
    for (const k of ['price', 'volatility', 'options_flow', 'exposure', 'macro'] as const) {
      expect(s).toHaveProperty(k);
    }
    expect(s.options_flow.total_call_volume).toBe(0);
    expect(s.options_flow.total_put_volume).toBe(0);
    expect(s.options_flow.pc_ratio_volume).toBeNull();
    expect(s.macro.vix_futures).toBeNull();
    expect(s.macro.fear_and_greed).toBeNull();
    expect(s.macro.vix.value).not.toBeNull();
  });

  test('volatility realized ladder', async () => {
    const v = (await hx.volatility('SPY', { at: SPY_AT })) as {
      realized_vol: Record<string, number>;
      atm_iv: number;
      skew_profiles: unknown[];
    };
    for (const w of ['rv_5d', 'rv_10d', 'rv_20d', 'rv_30d', 'rv_60d']) {
      expect(v.realized_vol).toHaveProperty(w);
    }
    expect(typeof v.atm_iv).toBe('number');
    expect(Array.isArray(v.skew_profiles)).toBe(true);
  });

  test('adv_volatility svi_parameters and variance surface', async () => {
    const adv = (await hx.advVolatility('SPY', { at: SPY_AT })) as {
      svi_parameters: Array<{
        expiry: string; a: number; b: number; rho: number;
        m: number; sigma: number; forward: number;
      }>;
      total_variance_surface: { total_variance: number[][] };
    };
    expect(adv.svi_parameters.length).toBeGreaterThan(0);
    const first = adv.svi_parameters[0];
    for (const k of ['expiry', 'a', 'b', 'rho', 'm', 'sigma', 'forward'] as const) {
      expect(first).toHaveProperty(k);
    }
    expect(Array.isArray(adv.total_variance_surface.total_variance[0])).toBe(true);
  });
});

describeIntegration('integration: surface', () => {
  const hx = mkClient();

  test('surface 50x50 grid', async () => {
    const out = (await hx.surface('SPY', { at: SPY_AT })) as {
      grid_size: number; tenors: number[]; moneyness: number[];
      iv: number[][]; spot: number;
    };
    expect(out.grid_size).toBe(50);
    expect(out.tenors).toHaveLength(50);
    expect(out.moneyness).toHaveLength(50);
    expect(out.iv).toHaveLength(50);
    expect(out.iv[0]).toHaveLength(50);
    expect(Math.abs(out.spot - EXPECTED_SPOT)).toBeLessThan(SPOT_TOL);
  });
});

describeIntegration('integration: vrp', () => {
  const hx = mkClient();

  test('vrp dashboard keys; hy_spread documented hard-code', async () => {
    const v = (await hx.vrp('SPY', { at: SPY_AT })) as {
      vrp: Record<string, number | null>;
      convexity_premium: number;
      fair_vol: number;
      macro: { hy_spread: number };
    };
    for (const k of [
      'atm_iv', 'rv_5d', 'rv_10d', 'rv_20d', 'rv_30d',
      'vrp_5d', 'vrp_10d', 'vrp_20d', 'vrp_30d',
    ]) {
      expect(v.vrp).toHaveProperty(k);
    }
    expect(typeof v.convexity_premium).toBe('number');
    expect(typeof v.fair_vol).toBe('number');
    expect(v.macro.hy_spread).toBe(3.5);
  });
});

describeIntegration('integration: max pain', () => {
  const hx = mkClient();

  test('pain curve minimum is at max_pain_strike', async () => {
    const mp = (await hx.maxPain('SPY', { at: SPY_AT, expiration: '2024-08-09' })) as {
      max_pain_strike: number;
      pain_curve: Array<{ strike: number; total_pain: number }>;
      expiration: string;
    };
    expect(mp.expiration).toBe('2024-08-09');
    expect(typeof mp.max_pain_strike).toBe('number');
    expect(mp.pain_curve.length).toBeGreaterThan(0);
    const minStrike = mp.pain_curve.reduce((acc, r) =>
      r.total_pain < acc.total_pain ? r : acc,
    ).strike;
    expect(Math.abs(minStrike - mp.max_pain_strike)).toBeLessThanOrEqual(5);
  });
});

describeIntegration('integration: errors', () => {
  const hx = mkClient();

  test('invalid_at → InvalidAtError', async () => {
    await expect(
      hx.exposureSummary('SPY', { at: 'garbage' }),
    ).rejects.toBeInstanceOf(InvalidAtError);
  });

  test('out-of-coverage → NoDataError', async () => {
    await expect(
      hx.exposureSummary('SPY', { at: '2017-01-01' }),
    ).rejects.toBeInstanceOf(NoDataError);
  });

  test('holiday → NoDataError', async () => {
    await expect(
      hx.exposureSummary('SPY', { at: '2024-01-01' }),
    ).rejects.toBeInstanceOf(NoDataError);
  });

  test('optionQuote with non-existent strike → NoDataError', async () => {
    await expect(
      hx.optionQuote('SPY', {
        at: SPY_AT,
        expiry: '2024-08-09',
        strike: 99999,
        type: 'C',
      }),
    ).rejects.toBeInstanceOf(NoDataError);
  });
});

describeIntegration('integration: replay & backtester', () => {
  const hx = mkClient();

  test('replay one trading week of summaries', async () => {
    const out = [];
    for await (const step of replay(
      hx, 'exposureSummary', 'SPY',
      iterDays('2024-08-05', '2024-08-09'),
    )) {
      out.push(step);
    }
    expect(out).toHaveLength(5);
    for (const { response } of out) {
      const r = response as { symbol: string; regime: string };
      expect(r.symbol).toBe('SPY');
      expect(REGIMES.has(r.regime)).toBe(true);
    }
  }, 60_000);

  test('replay one day at 30-minute step', async () => {
    const out = [];
    for await (const step of replay(
      hx, 'exposureSummary', 'SPY',
      iterMinutes('2024-08-05', '2024-08-05', { stepMinutes: 30 }),
    )) {
      out.push(step);
    }
    expect(out).toHaveLength(14);
    const spots = new Set(
      out.map((s) => (s.response as { underlying_price: number }).underlying_price),
    );
    expect(spots.size).toBeGreaterThan(1);
  }, 60_000);

  test('replay skips holiday silently when skipMissing=true', async () => {
    const errs: unknown[] = [];
    const out = [];
    for await (const step of replay(
      hx, 'exposureSummary', 'SPY',
      ['2024-08-05T15:30:00', '2024-01-01'],
      { onError: (_at, e) => errs.push(e) },
    )) {
      out.push(step);
    }
    expect(out).toHaveLength(1);
    expect(errs).toHaveLength(1);
  });

  test('Backtester runs and exposes records', async () => {
    type Snap = { volatility: { vrp: number }; exposure: { regime: string } };
    const bt = new Backtester(hx, { method: 'stockSummary', symbol: 'SPY' });
    const results = await bt.run<Snap, { vrp: number; regime: string }>(
      iterDays('2024-08-05', '2024-08-09'),
      (_at, snap) => ({ vrp: snap.volatility.vrp, regime: snap.exposure.regime }),
    );
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(REGIMES.has(r.output.regime)).toBe(true);
    }
    const records = bt.toRecords(results);
    for (const k of ['at', 'underlying_price', 'regime', 'vrp']) {
      expect(records[0]).toHaveProperty(k);
    }
  }, 60_000);
});
