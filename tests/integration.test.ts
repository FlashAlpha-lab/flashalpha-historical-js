/**
 * Integration tests — hit the live https://historical.flashalpha.com.
 *
 * Skipped unless `FLASHALPHA_API_KEY` is set. Run with:
 *   FLASHALPHA_API_KEY=fa_... npx jest tests/integration.test.ts
 */
import {
  Backtester,
  FlashAlphaHistorical,
  FlashAlphaHistoricalError,
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

const REGIMES = new Set(['positive_gamma', 'negative_gamma', 'unknown']);
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
    const out = (await hx.tickers()) as unknown as {
      count: number;
      tickers: Array<{ symbol: string }>;
    };
    expect(out.count).toBeGreaterThanOrEqual(1);
    expect(out.tickers.map((t) => t.symbol)).toContain('SPY');
  });

  test('tickers?symbol=SPY returns single object with coverage', async () => {
    const out = (await hx.tickers({ symbol: 'SPY' })) as unknown as {
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

  test('vrp — every field declared in VrpResponse must be referenced', async () => {
    type Macro = {
      vix: number; vix_3m: number; vix_term_slope: number;
      dgs10: number; hy_spread: number;
    };
    type Term = { dte: number; iv: number; rv: number; vrp: number };
    type GexC = { regime: string; harvest_score: number; interpretation: string };
    type VannaC = { outlook: string; interpretation: string };
    type Reg = {
      gamma: string; vrp_regime: string | null;
      net_gex: number; gamma_flip: number;
    };
    type SS = {
      short_put_spread: number | null; short_strangle: number | null;
      iron_condor: number | null; calendar_spread: number | null;
    };
    type Core = Record<string, number | null>;

    const v = (await hx.vrp('SPY', { at: SPY_AT })) as {
      symbol: string;
      underlying_price: number;
      as_of: string;
      market_open: boolean;
      vrp: Core;
      variance_risk_premium: number;
      convexity_premium: number;
      fair_vol: number;
      directional: Record<string, number>;
      term_vrp: Term[];
      gex_conditioned: GexC;
      vanna_conditioned: VannaC;
      regime: Reg;
      strategy_scores: SS | null;
      net_harvest_score: number | null;
      dealer_flow_risk: number | null;
      warnings: string[];
      macro: Macro;
    };

    // ── top-level scalars ──
    expect(v.symbol).toBe('SPY');
    expect(typeof v.underlying_price).toBe('number');
    expect(typeof v.as_of).toBe('string');
    expect(typeof v.market_open).toBe('boolean');
    expect(typeof v.variance_risk_premium).toBe('number');
    expect(typeof v.convexity_premium).toBe('number');
    expect(typeof v.fair_vol).toBe('number');
    expect(Array.isArray(v.warnings)).toBe(true);
    // dealer_flow_risk: present (may be null on thin warmup)
    expect('dealer_flow_risk' in v).toBe(true);
    // net_harvest_score / strategy_scores nullable on historical
    expect(v.net_harvest_score === null || typeof v.net_harvest_score === 'number').toBe(true);
    if (v.strategy_scores !== null) {
      for (const k of ['short_put_spread', 'short_strangle', 'iron_condor', 'calendar_spread'] as const) {
        expect(v.strategy_scores[k] === null || typeof v.strategy_scores[k] === 'number').toBe(true);
      }
    }
    // Customer trap: net_gex must NOT exist top-level
    expect('net_gex' in v).toBe(false);

    // ── vrp.* core block ──
    for (const k of [
      'atm_iv', 'rv_5d', 'rv_10d', 'rv_20d', 'rv_30d',
      'vrp_5d', 'vrp_10d', 'vrp_20d', 'vrp_30d',
    ]) {
      expect(typeof v.vrp[k]).toBe('number');
    }
    // z_score / percentile nullable on historical
    expect(v.vrp.z_score === null || typeof v.vrp.z_score === 'number').toBe(true);
    expect(v.vrp.percentile === null || typeof v.vrp.percentile === 'number').toBe(true);
    expect(typeof v.vrp.history_days).toBe('number');

    // ── directional ──
    for (const k of ['put_wing_iv_25d', 'call_wing_iv_25d',
                     'downside_rv_20d', 'upside_rv_20d',
                     'downside_vrp', 'upside_vrp']) {
      expect(typeof v.directional[k]).toBe('number');
    }
    // Customer-trap fields must NOT exist
    expect('put_vrp' in v.directional).toBe(false);
    expect('call_vrp' in v.directional).toBe(false);

    // ── term_vrp[] ──
    expect(Array.isArray(v.term_vrp)).toBe(true);
    expect(v.term_vrp.length).toBeGreaterThan(0);
    const first = v.term_vrp[0];
    for (const k of ['dte', 'iv', 'rv', 'vrp'] as const) {
      expect(typeof first[k]).toBe('number');
    }

    // ── gex_conditioned ──
    expect(typeof v.gex_conditioned.regime).toBe('string');
    expect(typeof v.gex_conditioned.harvest_score).toBe('number');
    expect(typeof v.gex_conditioned.interpretation).toBe('string');

    // ── vanna_conditioned ──
    expect(typeof v.vanna_conditioned.outlook).toBe('string');
    expect(typeof v.vanna_conditioned.interpretation).toBe('string');

    // ── regime (net_gex lives HERE) ──
    expect(typeof v.regime.gamma).toBe('string');
    expect(v.regime.vrp_regime === null || typeof v.regime.vrp_regime === 'string').toBe(true);
    expect(typeof v.regime.net_gex).toBe('number');
    expect(typeof v.regime.gamma_flip).toBe('number');

    // ── macro (historical-specific shape) ──
    for (const k of ['vix', 'vix_3m', 'vix_term_slope', 'dgs10', 'hy_spread'] as const) {
      expect(typeof v.macro[k]).toBe('number');
    }
    // fed_funds is live-only — must NOT be present on historical
    expect('fed_funds' in v.macro).toBe(false);
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

  test('every field declared in MaxPainResponse interface is exercised', async () => {
    // 100% field-coverage discipline. Historical-specific:
    // oi_by_strike[].call_volume / put_volume are always 0.
    const r = (await hx.maxPain('SPY', { at: SPY_AT })) as {
      symbol: string;
      underlying_price: number;
      as_of: string;
      max_pain_strike: number;
      distance: { absolute: number; percent: number; direction: string };
      signal: string;
      expiration: string;
      put_call_oi_ratio: number;
      pain_curve: Array<{ strike: number; call_pain: number; put_pain: number; total_pain: number }>;
      oi_by_strike: Array<{
        strike: number; call_oi: number; put_oi: number;
        total_oi: number; call_volume: number; put_volume: number;
      }>;
      max_pain_by_expiration: Array<{
        expiration: string; max_pain_strike: number; dte: number; total_oi: number;
      }> | null;
      dealer_alignment: {
        alignment: string; description: string;
        gamma_flip: number; call_wall: number; put_wall: number;
      };
      regime: string;
      expected_move: { straddle_price: number; atm_iv: number; max_pain_within_expected_range: boolean };
      pin_probability: number;
    };

    // top-level scalars
    expect(r.symbol).toBe('SPY');
    expect(typeof r.underlying_price).toBe('number');
    expect(r.underlying_price).toBeGreaterThan(0);
    expect(typeof r.as_of).toBe('string');
    expect(typeof r.max_pain_strike).toBe('number');
    expect(['bullish', 'bearish', 'neutral']).toContain(r.signal);
    expect(typeof r.expiration).toBe('string');
    expect(typeof r.put_call_oi_ratio).toBe('number');
    expect(['positive_gamma', 'negative_gamma', 'unknown']).toContain(r.regime);
    expect(typeof r.pin_probability).toBe('number');
    expect(r.pin_probability).toBeGreaterThanOrEqual(0);
    expect(r.pin_probability).toBeLessThanOrEqual(100);

    // distance
    expect(typeof r.distance.absolute).toBe('number');
    expect(typeof r.distance.percent).toBe('number');
    expect(['above', 'below', 'at']).toContain(r.distance.direction);

    // pain_curve[]
    expect(Array.isArray(r.pain_curve)).toBe(true);
    expect(r.pain_curve.length).toBeGreaterThan(0);
    const pc = r.pain_curve[0];
    expect(typeof pc.strike).toBe('number');
    expect(typeof pc.call_pain).toBe('number');
    expect(typeof pc.put_pain).toBe('number');
    expect(typeof pc.total_pain).toBe('number');

    // oi_by_strike[] — historical: volume fields always 0
    expect(Array.isArray(r.oi_by_strike)).toBe(true);
    expect(r.oi_by_strike.length).toBeGreaterThan(0);
    const oi = r.oi_by_strike[0];
    expect(typeof oi.strike).toBe('number');
    expect(typeof oi.call_oi).toBe('number');
    expect(typeof oi.put_oi).toBe('number');
    expect(typeof oi.total_oi).toBe('number');
    expect(oi.call_volume).toBe(0);
    expect(oi.put_volume).toBe(0);

    // max_pain_by_expiration[] (no filter on this call)
    expect(r.max_pain_by_expiration).not.toBeNull();
    expect(Array.isArray(r.max_pain_by_expiration)).toBe(true);
    expect(r.max_pain_by_expiration!.length).toBeGreaterThan(0);
    const mr = r.max_pain_by_expiration![0];
    expect(typeof mr.expiration).toBe('string');
    expect(typeof mr.max_pain_strike).toBe('number');
    expect(typeof mr.dte).toBe('number');
    expect(typeof mr.total_oi).toBe('number');

    // dealer_alignment
    expect(['converging', 'moderate', 'diverging', 'unknown']).toContain(r.dealer_alignment.alignment);
    expect(typeof r.dealer_alignment.description).toBe('string');
    expect(typeof r.dealer_alignment.gamma_flip).toBe('number');
    expect(typeof r.dealer_alignment.call_wall).toBe('number');
    expect(typeof r.dealer_alignment.put_wall).toBe('number');

    // expected_move
    expect(typeof r.expected_move.straddle_price).toBe('number');
    expect(typeof r.expected_move.atm_iv).toBe('number');
    expect(typeof r.expected_move.max_pain_within_expected_range).toBe('boolean');
  });

  test('expiration filter suppresses max_pain_by_expiration', async () => {
    const mp = (await hx.maxPain('SPY', { at: SPY_AT, expiration: '2024-08-09' })) as {
      max_pain_by_expiration: unknown | null;
    };
    expect(mp.max_pain_by_expiration).toBeNull();
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

// ── rc.4 POCO field-walk coverage ───────────────────────────────────────────
// For each interface added in rc.4, walk every documented top-level (and
// selected nested) field and assert it is present on the response.
// TypeScript interfaces are erased at runtime, so the field list is
// hand-mirrored from src/types.ts — keep these in sync if the interface
// shape changes. Historical doesn't expose `greeks()` so that test lives
// only in the live SDK.

describeIntegration('integration: rc.4 POCO field-walks', () => {
  const hx = mkClient();

  test('stockSummary — every field declared in StockSummaryResponse must be referenced', async () => {
    const r = (await hx.stockSummary('SPY', { at: SPY_AT })) as Record<string, unknown> & {
      symbol: string;
      as_of: string;
      market_open: boolean;
      price: Record<string, unknown>;
      volatility: Record<string, unknown> & {
        skew_25d: Record<string, unknown> | null;
        iv_term_structure: unknown[];
      };
      options_flow: Record<string, unknown>;
      exposure: (Record<string, unknown> & {
        interpretation: Record<string, unknown>;
        hedging_estimate: {
          spot_up_1pct: Record<string, unknown>;
          spot_down_1pct: Record<string, unknown>;
        };
        zero_dte: Record<string, unknown> | null;
        top_strikes: unknown[];
      }) | null;
      macro: Record<string, unknown> & {
        vix: Record<string, unknown> | null;
        vvix: Record<string, unknown> | null;
        skew: Record<string, unknown> | null;
        spx: Record<string, unknown> | null;
        move: Record<string, unknown> | null;
        vix_term_structure: (Record<string, unknown> & { levels: Record<string, unknown> }) | null;
        vix_futures: Record<string, unknown> | null;
        fear_and_greed: Record<string, unknown> | null;
      };
    };

    // ── top-level scalars ──
    for (const k of ['symbol', 'as_of', 'market_open', 'price', 'volatility',
                     'options_flow', 'exposure', 'macro']) {
      expect(r).toHaveProperty(k);
    }
    expect(r.symbol).toBe('SPY');
    expect(typeof r.as_of).toBe('string');

    // ── price (5 fields) ──
    for (const k of ['bid', 'ask', 'mid', 'last', 'last_update']) {
      expect(r.price).toHaveProperty(k);
    }

    // ── volatility (6 top fields + skew_25d sub + iv_term_structure[]) ──
    for (const k of ['atm_iv', 'hv_20', 'hv_60', 'vrp', 'skew_25d', 'iv_term_structure']) {
      expect(r.volatility).toHaveProperty(k);
    }
    if (r.volatility.skew_25d) {
      for (const k of ['expiry', 'days_to_expiry', 'put_25d_iv', 'atm_iv',
                       'call_25d_iv', 'skew_25d', 'smile_ratio']) {
        expect(r.volatility.skew_25d).toHaveProperty(k);
      }
    }
    expect(Array.isArray(r.volatility.iv_term_structure)).toBe(true);
    if (r.volatility.iv_term_structure.length > 0) {
      const node = r.volatility.iv_term_structure[0] as Record<string, unknown>;
      for (const k of ['expiry', 'iv', 'days_to_expiry']) {
        expect(node).toHaveProperty(k);
      }
    }

    // ── options_flow (7 fields) ──
    for (const k of ['total_call_oi', 'total_put_oi', 'total_call_volume',
                     'total_put_volume', 'pc_ratio_oi', 'pc_ratio_volume',
                     'active_expirations']) {
      expect(r.options_flow).toHaveProperty(k);
    }

    // ── exposure (skip walk if exposure is null) ──
    if (r.exposure) {
      for (const k of ['net_gex', 'net_dex', 'net_vex', 'net_chex',
                       'gamma_flip', 'call_wall', 'put_wall', 'max_pain',
                       'highest_oi_strike', 'regime', 'interpretation',
                       'hedging_estimate', 'zero_dte', 'top_strikes',
                       'oi_weighted_dte']) {
        expect(r.exposure).toHaveProperty(k);
      }
      for (const k of ['gamma', 'vanna', 'charm']) {
        expect(r.exposure.interpretation).toHaveProperty(k);
      }
      for (const side of [r.exposure.hedging_estimate.spot_up_1pct,
                          r.exposure.hedging_estimate.spot_down_1pct]) {
        for (const k of ['dealer_shares', 'direction', 'notional_usd']) {
          expect(side).toHaveProperty(k);
        }
      }
      if (r.exposure.zero_dte) {
        for (const k of ['net_gex', 'pct_of_total', 'expiration']) {
          expect(r.exposure.zero_dte).toHaveProperty(k);
        }
      }
      expect(Array.isArray(r.exposure.top_strikes)).toBe(true);
      if (r.exposure.top_strikes.length > 0) {
        const ts = r.exposure.top_strikes[0] as Record<string, unknown>;
        for (const k of ['strike', 'net_gex', 'call_oi', 'put_oi', 'total_oi']) {
          expect(ts).toHaveProperty(k);
        }
      }
    }

    // ── macro (8 sub-blocks) ──
    for (const k of ['vix', 'vvix', 'skew', 'spx', 'move',
                     'vix_term_structure', 'vix_futures', 'fear_and_greed']) {
      expect(r.macro).toHaveProperty(k);
    }
    for (const idx of [r.macro.vix, r.macro.vvix, r.macro.skew, r.macro.spx, r.macro.move]) {
      if (idx) {
        for (const k of ['value', 'change', 'change_pct']) {
          expect(idx).toHaveProperty(k);
        }
      }
    }
    if (r.macro.vix_term_structure) {
      for (const k of ['levels', 'near_slope_pct', 'structure']) {
        expect(r.macro.vix_term_structure).toHaveProperty(k);
      }
      for (const k of ['vix9d', 'vix', 'vix3m', 'vix6m']) {
        expect(r.macro.vix_term_structure.levels).toHaveProperty(k);
      }
    }
    if (r.macro.vix_futures) {
      for (const k of ['front_month', 'spot', 'spread', 'basis_pct', 'basis']) {
        expect(r.macro.vix_futures).toHaveProperty(k);
      }
    }
    if (r.macro.fear_and_greed) {
      for (const k of ['score', 'rating']) {
        expect(r.macro.fear_and_greed).toHaveProperty(k);
      }
    }
  });

  test('narrative — every field declared in NarrativeResponse must be referenced', async () => {
    const r = (await hx.narrative('SPY', { at: SPY_AT })) as Record<string, unknown> & {
      symbol: string;
      underlying_price: number;
      as_of: string;
      narrative: Record<string, unknown> & {
        data: Record<string, unknown> & { top_oi_changes: unknown[] };
      };
    };

    // ── top-level scalars ──
    for (const k of ['symbol', 'underlying_price', 'as_of', 'narrative']) {
      expect(r).toHaveProperty(k);
    }
    expect(r.symbol).toBe('SPY');
    expect(typeof r.as_of).toBe('string');
    expect(r.underlying_price === null || typeof r.underlying_price === 'number').toBe(true);

    // ── narrative.* (8 string blocks + data) ──
    for (const k of ['regime', 'gex_change', 'key_levels', 'flow', 'vanna',
                     'charm', 'zero_dte', 'outlook', 'data']) {
      expect(r.narrative).toHaveProperty(k);
    }

    // ── narrative.data (10 fields including top_oi_changes[]) ──
    for (const k of ['net_gex', 'net_gex_prior', 'net_gex_change_pct', 'vix',
                     'gamma_flip', 'call_wall', 'put_wall', 'regime',
                     'zero_dte_pct', 'top_oi_changes']) {
      expect(r.narrative.data).toHaveProperty(k);
    }
    expect(Array.isArray(r.narrative.data.top_oi_changes)).toBe(true);
    if (r.narrative.data.top_oi_changes.length > 0) {
      const row = r.narrative.data.top_oi_changes[0] as Record<string, unknown>;
      for (const k of ['strike', 'type', 'oi_change', 'volume']) {
        expect(row).toHaveProperty(k);
      }
    }
  });

  test('exposureLevels — every field declared in ExposureLevelsResponse must be referenced', async () => {
    const r = (await hx.exposureLevels('SPY', { at: SPY_AT })) as Record<string, unknown> & {
      symbol: string;
      underlying_price: number;
      as_of: string;
      levels: Record<string, unknown>;
    };

    // ── top-level (4 fields) ──
    for (const k of ['symbol', 'underlying_price', 'as_of', 'levels']) {
      expect(r).toHaveProperty(k);
    }
    expect(r.symbol).toBe('SPY');
    expect(typeof r.as_of).toBe('string');
    expect(r.underlying_price === null || typeof r.underlying_price === 'number').toBe(true);

    // ── levels (all 7 fields including zero_dte_magnet) ──
    for (const k of ['gamma_flip', 'max_positive_gamma', 'max_negative_gamma',
                     'call_wall', 'put_wall', 'highest_oi_strike',
                     'zero_dte_magnet']) {
      expect(r.levels).toHaveProperty(k);
    }
  });
});

// ── rc.9 POCO field-walk coverage ───────────────────────────────────────────
// For each interface added in rc.9, walk every documented top-level (and
// selected nested) field and assert it is present on the response.
// TypeScript interfaces are erased at runtime, so the field list is
// hand-mirrored from src/types.ts — keep these in sync if the interface
// shape changes. Live-only shapes (OptionQuote, StockQuote) are not
// covered here — they live in the live SDK's integration tests.

describeIntegration('integration: rc.9 POCO field-walks', () => {
  const hx = mkClient();

  test('volatility — every field declared in VolatilityResponse must be referenced', async () => {
    const r = (await hx.volatility('SPY', { at: SPY_AT })) as Record<string, unknown> & {
      symbol: string;
      underlying_price: number | null;
      as_of: string;
      market_open: boolean | null;
      realized_vol: Record<string, unknown>;
      atm_iv: number | null;
      iv_rv_spreads: Record<string, unknown>;
      skew_profiles: unknown[];
      term_structure: Record<string, unknown>;
      iv_dispersion: Record<string, unknown>;
      gex_by_dte: unknown[];
      theta_by_dte: unknown[];
      put_call_profile: Record<string, unknown> & {
        by_expiry: unknown[];
        by_moneyness: Record<string, unknown>;
      };
      oi_concentration: Record<string, unknown>;
      hedging_scenarios: unknown[];
      liquidity: Record<string, unknown>;
    };

    // ── top-level (16 keys) ──
    for (const k of ['symbol', 'underlying_price', 'as_of', 'market_open',
                     'realized_vol', 'atm_iv', 'iv_rv_spreads',
                     'skew_profiles', 'term_structure', 'iv_dispersion',
                     'gex_by_dte', 'theta_by_dte', 'put_call_profile',
                     'oi_concentration', 'hedging_scenarios', 'liquidity']) {
      expect(r).toHaveProperty(k);
    }
    expect(r.symbol).toBe('SPY');
    expect(typeof r.as_of).toBe('string');

    // ── realized_vol (5 horizons) ──
    for (const k of ['rv_5d', 'rv_10d', 'rv_20d', 'rv_30d', 'rv_60d']) {
      expect(r.realized_vol).toHaveProperty(k);
    }

    // ── iv_rv_spreads (4 horizons + assessment) ──
    for (const k of ['vrp_5d', 'vrp_10d', 'vrp_20d', 'vrp_30d', 'assessment']) {
      expect(r.iv_rv_spreads).toHaveProperty(k);
    }

    // ── skew_profiles[] (per-expiry) ──
    expect(Array.isArray(r.skew_profiles)).toBe(true);
    if (r.skew_profiles.length > 0) {
      const sp = r.skew_profiles[0] as Record<string, unknown>;
      for (const k of ['expiry', 'days_to_expiry', 'put_10d_iv', 'put_25d_iv',
                       'atm_iv', 'call_25d_iv', 'call_10d_iv', 'skew_25d',
                       'smile_ratio', 'tail_convexity']) {
        expect(sp).toHaveProperty(k);
      }
    }

    // ── term_structure (3 fields) ──
    for (const k of ['near_slope_pct', 'far_slope_pct', 'state']) {
      expect(r.term_structure).toHaveProperty(k);
    }

    // ── iv_dispersion (2 fields) ──
    for (const k of ['cross_expiry', 'cross_strike']) {
      expect(r.iv_dispersion).toHaveProperty(k);
    }

    // ── gex_by_dte[] (4 fields per bucket) ──
    expect(Array.isArray(r.gex_by_dte)).toBe(true);
    if (r.gex_by_dte.length > 0) {
      const b = r.gex_by_dte[0] as Record<string, unknown>;
      for (const k of ['bucket', 'net_gex', 'pct_of_total', 'contract_count']) {
        expect(b).toHaveProperty(k);
      }
    }

    // ── theta_by_dte[] (3 fields per bucket) ──
    expect(Array.isArray(r.theta_by_dte)).toBe(true);
    if (r.theta_by_dte.length > 0) {
      const b = r.theta_by_dte[0] as Record<string, unknown>;
      for (const k of ['bucket', 'net_theta', 'contract_count']) {
        expect(b).toHaveProperty(k);
      }
    }

    // ── put_call_profile (by_expiry[] + by_moneyness) ──
    expect(Array.isArray(r.put_call_profile.by_expiry)).toBe(true);
    if (r.put_call_profile.by_expiry.length > 0) {
      const e = r.put_call_profile.by_expiry[0] as Record<string, unknown>;
      for (const k of ['expiry', 'call_oi', 'put_oi', 'pc_ratio_oi',
                       'call_volume', 'put_volume', 'pc_ratio_volume']) {
        expect(e).toHaveProperty(k);
      }
    }
    for (const k of ['otm_call_oi', 'atm_call_oi', 'itm_call_oi',
                     'otm_put_oi', 'atm_put_oi', 'itm_put_oi']) {
      expect(r.put_call_profile.by_moneyness).toHaveProperty(k);
    }

    // ── oi_concentration (4 fields) ──
    for (const k of ['top_3_pct', 'top_5_pct', 'top_10_pct', 'herfindahl']) {
      expect(r.oi_concentration).toHaveProperty(k);
    }

    // ── hedging_scenarios[] (4 fields per row) ──
    expect(Array.isArray(r.hedging_scenarios)).toBe(true);
    if (r.hedging_scenarios.length > 0) {
      const h = r.hedging_scenarios[0] as Record<string, unknown>;
      for (const k of ['move_pct', 'dealer_shares', 'direction', 'notional_usd']) {
        expect(h).toHaveProperty(k);
      }
    }

    // ── liquidity (4 fields) ──
    for (const k of ['atm_avg_spread_pct', 'wing_avg_spread_pct',
                     'atm_contracts', 'wing_contracts']) {
      expect(r.liquidity).toHaveProperty(k);
    }
  });

  test('advVolatility — every field declared in AdvVolatilityResponse must be referenced (Alpha-tier)', async () => {
    let r: Record<string, unknown> & {
      symbol: string;
      underlying_price: number | null;
      as_of: string;
      market_open: boolean | null;
      svi_parameters: unknown[];
      forward_prices: unknown[];
      total_variance_surface: Record<string, unknown>;
      arbitrage_flags: unknown[];
      variance_swap_fair_values: unknown[];
      greeks_surfaces: Record<string, unknown> & {
        vanna: Record<string, unknown>;
        charm: Record<string, unknown>;
        volga: Record<string, unknown>;
        speed: Record<string, unknown>;
      };
    };
    try {
      r = (await hx.advVolatility('SPY', { at: SPY_AT })) as typeof r;
    } catch (err) {
      // Skip if tier-restricted — adv_volatility requires Alpha+
      if (
        err instanceof FlashAlphaHistoricalError &&
        err.statusCode === 403
      ) {
        return;
      }
      throw err;
    }

    // ── top-level (10 keys) ──
    for (const k of ['symbol', 'underlying_price', 'as_of', 'market_open',
                     'svi_parameters', 'forward_prices',
                     'total_variance_surface', 'arbitrage_flags',
                     'variance_swap_fair_values', 'greeks_surfaces']) {
      expect(r).toHaveProperty(k);
    }
    expect(r.symbol).toBe('SPY');
    expect(typeof r.as_of).toBe('string');

    // ── svi_parameters[] (10 fields per row) ──
    expect(Array.isArray(r.svi_parameters)).toBe(true);
    if (r.svi_parameters.length > 0) {
      const s = r.svi_parameters[0] as Record<string, unknown>;
      for (const k of ['expiry', 'days_to_expiry', 'forward', 'a', 'b',
                       'rho', 'm', 'sigma', 'atm_total_variance', 'atm_iv']) {
        expect(s).toHaveProperty(k);
      }
    }

    // ── forward_prices[] (5 fields per row) ──
    expect(Array.isArray(r.forward_prices)).toBe(true);
    if (r.forward_prices.length > 0) {
      const fp = r.forward_prices[0] as Record<string, unknown>;
      for (const k of ['expiry', 'days_to_expiry', 'forward', 'spot', 'basis_pct']) {
        expect(fp).toHaveProperty(k);
      }
    }

    // ── total_variance_surface (5 fields) ──
    for (const k of ['moneyness', 'expiries', 'tenors', 'total_variance', 'implied_vol']) {
      expect(r.total_variance_surface).toHaveProperty(k);
    }

    // ── arbitrage_flags[] (4 fields per row) ──
    expect(Array.isArray(r.arbitrage_flags)).toBe(true);
    if (r.arbitrage_flags.length > 0) {
      const a = r.arbitrage_flags[0] as Record<string, unknown>;
      for (const k of ['expiry', 'type', 'strike_or_k', 'description']) {
        expect(a).toHaveProperty(k);
      }
    }

    // ── variance_swap_fair_values[] (5 fields per row) ──
    expect(Array.isArray(r.variance_swap_fair_values)).toBe(true);
    if (r.variance_swap_fair_values.length > 0) {
      const v = r.variance_swap_fair_values[0] as Record<string, unknown>;
      for (const k of ['expiry', 'days_to_expiry', 'fair_variance',
                       'fair_vol', 'atm_iv', 'convexity_adjustment']) {
        expect(v).toHaveProperty(k);
      }
    }

    // ── greeks_surfaces (4 surfaces × 3 axes) ──
    for (const surface of ['vanna', 'charm', 'volga', 'speed'] as const) {
      expect(r.greeks_surfaces).toHaveProperty(surface);
      for (const k of ['strikes', 'expiries', 'values']) {
        expect(r.greeks_surfaces[surface]).toHaveProperty(k);
      }
    }
  });

  test('surface — every field declared in SurfaceResponse must be referenced', async () => {
    const r = (await hx.surface('SPY', { at: SPY_AT })) as Record<string, unknown> & {
      symbol: string;
      spot: number | null;
      as_of: string;
      grid_size: number;
      tenors: number[];
      moneyness: number[];
      iv: number[][];
      slices_used: string[];
    };

    // ── all 8 fields ──
    for (const k of ['symbol', 'spot', 'as_of', 'grid_size',
                     'tenors', 'moneyness', 'iv', 'slices_used']) {
      expect(r).toHaveProperty(k);
    }
    expect(r.symbol).toBe('SPY');
    expect(typeof r.as_of).toBe('string');
    expect(typeof r.grid_size).toBe('number');
    expect(Array.isArray(r.tenors)).toBe(true);
    expect(Array.isArray(r.moneyness)).toBe(true);
    expect(Array.isArray(r.iv)).toBe(true);
    expect(Array.isArray(r.slices_used)).toBe(true);
  });

  test('gex — every field declared in GexResponse must be referenced', async () => {
    const r = (await hx.gex('SPY', { at: SPY_AT })) as Record<string, unknown> & {
      symbol: string;
      underlying_price: number | null;
      as_of: string;
      gamma_flip: number | null;
      net_gex: number | null;
      net_gex_label: string | null;
      strikes: unknown[];
    };

    // ── top-level (7 fields) ──
    for (const k of ['symbol', 'underlying_price', 'as_of', 'gamma_flip',
                     'net_gex', 'net_gex_label', 'strikes']) {
      expect(r).toHaveProperty(k);
    }
    expect(r.symbol).toBe('SPY');

    // ── strikes[] (10 fields per row) ──
    expect(Array.isArray(r.strikes)).toBe(true);
    if (r.strikes.length > 0) {
      const s = r.strikes[0] as Record<string, unknown>;
      for (const k of ['strike', 'call_gex', 'put_gex', 'net_gex',
                       'call_oi', 'put_oi', 'call_volume', 'put_volume',
                       'call_oi_change', 'put_oi_change']) {
        expect(s).toHaveProperty(k);
      }
    }
  });

  test('dex — every field declared in DexResponse must be referenced', async () => {
    const r = (await hx.dex('SPY', { at: SPY_AT })) as Record<string, unknown> & {
      symbol: string;
      underlying_price: number | null;
      as_of: string;
      net_dex: number | null;
      strikes: unknown[];
    };

    // ── top-level (5 fields) ──
    for (const k of ['symbol', 'underlying_price', 'as_of', 'net_dex', 'strikes']) {
      expect(r).toHaveProperty(k);
    }
    expect(r.symbol).toBe('SPY');

    // ── strikes[] (4 fields per row) ──
    expect(Array.isArray(r.strikes)).toBe(true);
    if (r.strikes.length > 0) {
      const s = r.strikes[0] as Record<string, unknown>;
      for (const k of ['strike', 'call_dex', 'put_dex', 'net_dex']) {
        expect(s).toHaveProperty(k);
      }
    }
  });

  test('vex — every field declared in VexResponse must be referenced', async () => {
    const r = (await hx.vex('SPY', { at: SPY_AT })) as Record<string, unknown> & {
      symbol: string;
      underlying_price: number | null;
      as_of: string;
      net_vex: number | null;
      vex_interpretation: string | null;
      strikes: unknown[];
    };

    // ── top-level (6 fields) ──
    for (const k of ['symbol', 'underlying_price', 'as_of', 'net_vex',
                     'vex_interpretation', 'strikes']) {
      expect(r).toHaveProperty(k);
    }
    expect(r.symbol).toBe('SPY');

    // ── strikes[] (4 fields per row) ──
    expect(Array.isArray(r.strikes)).toBe(true);
    if (r.strikes.length > 0) {
      const s = r.strikes[0] as Record<string, unknown>;
      for (const k of ['strike', 'call_vex', 'put_vex', 'net_vex']) {
        expect(s).toHaveProperty(k);
      }
    }
  });

  test('chex — every field declared in ChexResponse must be referenced', async () => {
    const r = (await hx.chex('SPY', { at: SPY_AT })) as Record<string, unknown> & {
      symbol: string;
      underlying_price: number | null;
      as_of: string;
      net_chex: number | null;
      chex_interpretation: string | null;
      strikes: unknown[];
    };

    // ── top-level (6 fields) ──
    for (const k of ['symbol', 'underlying_price', 'as_of', 'net_chex',
                     'chex_interpretation', 'strikes']) {
      expect(r).toHaveProperty(k);
    }
    expect(r.symbol).toBe('SPY');

    // ── strikes[] (4 fields per row) ──
    expect(Array.isArray(r.strikes)).toBe(true);
    if (r.strikes.length > 0) {
      const s = r.strikes[0] as Record<string, unknown>;
      for (const k of ['strike', 'call_chex', 'put_chex', 'net_chex']) {
        expect(s).toHaveProperty(k);
      }
    }
  });
});
