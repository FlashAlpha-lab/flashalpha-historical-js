/**
 * Typed response models for the FlashAlpha Historical SDK.
 *
 * These are pure TypeScript interfaces — they have zero runtime cost and don't
 * change the shape of the JSON returned by the API. Existing code that did
 * `result.field` (after a cast to `any`) keeps working unchanged. New code
 * gets autocomplete, IDE hints, and type-checking on documented fields.
 *
 * The Historical API returns the same response shapes as the live API; the
 * only difference is every analytics endpoint requires an `at=` query
 * parameter.
 *
 * Numeric fields are typed `| null` because the API returns `null` for any
 * value it can't compute (insufficient data, market closed, historical
 * "backtest_mode" gaps, etc.).
 */

// ─── ExposureSummary ─────────────────────────────────────────────────────────
//
// Typed model for `GET /v1/exposure/summary/{symbol}?at=...`.
//
// Direction casing: /v1/exposure/summary/ and /v1/exposure/zero-dte/ both
// return lowercase "buy" / "sell". Docs and typed models use that casing
// consistently.

export interface ExposureSummaryExposures {
  // Field-level `| null` matches C#/Go/Java (defensive — API may return null
  // under unobserved edge conditions even when the parent block is present).
  net_gex?: number | null;
  net_dex?: number | null;
  net_vex?: number | null;
  net_chex?: number | null;
}

export interface ExposureSummaryInterpretation {
  gamma?: string | null;
  vanna?: string | null;
  charm?: string | null;
}

export interface ExposureSummaryHedgingMove {
  dealer_shares_to_trade?: number | null;
  direction?: 'buy' | 'sell' | null;
  notional_usd?: number | null;
}

export interface ExposureSummaryHedgingEstimate {
  spot_up_1pct?: ExposureSummaryHedgingMove;
  spot_down_1pct?: ExposureSummaryHedgingMove;
}

export interface ExposureSummaryZeroDte {
  net_gex?: number | null;
  pct_of_total_gex?: number | null;
  expiration?: string | null;
}

export interface ExposureSummaryResponse {
  symbol?: string;
  underlying_price?: number | null;
  /** As-of stamp the API returned (snapped to the available minute). */
  as_of?: string;
  // Note: `as_of_requested` exists on /v1/exposure/{gex,dex,narrative} but
  // NOT on /v1/exposure/summary. Don't add it to this type even though it
  // would be defensive — the field genuinely isn't returned for this endpoint.
  gamma_flip?: number | null;
  /**
   * Confirmed live values in tests across Py/JS/.NET/Go/Java:
   *   positive_gamma | negative_gamma | neutral
   * Documented fourth value: undetermined (when there's no usable options
   * data). `neutral` appears in edge cases where net_gex straddles zero.
   * Don't conflate with `maxpain.signal` (also bullish/bearish/neutral but
   * a separate field).
   */
  regime?: 'positive_gamma' | 'negative_gamma' | 'neutral' | 'undetermined';
  exposures?: ExposureSummaryExposures;
  interpretation?: ExposureSummaryInterpretation;
  hedging_estimate?: ExposureSummaryHedgingEstimate;
  zero_dte?: ExposureSummaryZeroDte;
}


// ─── VRP (Variance Risk Premium) ─────────────────────────────────────────────
//
// Typed model for `GET /v1/vrp/{symbol}?at=...` (Alpha+).
//
// Same shape as the live API with two macro diffs:
//   - `hy_spread`: populated on historical (live currently returns null)
//   - `fed_funds`: absent on historical (live includes it)
//
// This is THE classic nested-trap endpoint in the FlashAlpha API. Every
// customer who has tripped on this response has hit at least one of these
// silent-null patterns — the typed shape makes them impossible at the SDK
// boundary:
//
//   - `response.z_score`  ✗  → use `response.vrp?.z_score`
//   - `response.percentile` ✗ → use `response.vrp?.percentile`
//   - `response.put_vrp` ✗ → use `response.directional?.downside_vrp`
//   - `response.net_gex` ✗ → use `response.regime?.net_gex`

/**
 * Core VRP metrics block — the heart of the response.
 *
 * The variance risk premium is the spread between IMPLIED volatility
 * (forward-looking, priced into options) and REALIZED volatility
 * (backward-looking, observed from spot returns). Positive VRP = options
 * are pricing more vol than the underlying actually moved → premium for
 * selling vol. Negative VRP = options too cheap relative to realized →
 * premium for buying vol.
 *
 * Nested under `response.vrp` — NOT top-level. `response.z_score` is
 * undefined; use `response.vrp.z_score`.
 */
export interface VrpCore {
  /** At-the-money implied volatility (annualised, e.g. 18.5 = 18.5%). */
  atm_iv?: number | null;
  /** Realized vol over trailing 5 trading days (annualised %). */
  rv_5d?: number | null;
  rv_10d?: number | null;
  rv_20d?: number | null;
  rv_30d?: number | null;
  /** Variance risk premium at this horizon: `atm_iv - rv_Nd`. */
  vrp_5d?: number | null;
  vrp_10d?: number | null;
  vrp_20d?: number | null;
  vrp_30d?: number | null;
  /**
   * Z-score of the current 20-day VRP vs its trailing `history_days`
   * window. `+2.0` = unusually rich (often a fade signal). `null` when
   * warm-up is insufficient.
   */
  z_score?: number | null;
  /** Percentile rank (0-100) within the trailing window. `null` when warmup is short. */
  percentile?: number | null;
  /** Trading days in the trailing percentile/z-score window. */
  history_days?: number | null;
}

/**
 * Directional VRP skew — separates upside-tail vs downside-tail premia.
 *
 * Splits the VRP by direction: DOWNSIDE (puts) vs UPSIDE (calls). A large
 * `downside_vrp` with small `upside_vrp` is the classic "expensive crash
 * insurance" pattern.
 *
 * The canonical names are `downside_vrp` / `upside_vrp`. Customers from
 * other vendors type `put_vrp` / `call_vrp` — those don't exist here.
 */
export interface VrpDirectional {
  put_wing_iv_25d?: number | null;
  call_wing_iv_25d?: number | null;
  downside_rv_20d?: number | null;
  upside_rv_20d?: number | null;
  /** `put_wing_iv_25d - downside_rv_20d`. Positive = crash insurance rich. */
  downside_vrp?: number | null;
  /** `call_wing_iv_25d - upside_rv_20d`. Positive = upside calls rich. */
  upside_vrp?: number | null;
}

/** One row of the VRP term structure — `{dte, iv, rv, vrp}`. */
export interface VrpTermItem {
  dte?: number | null;
  iv?: number | null;
  rv?: number | null;
  vrp?: number | null;
}

/** VRP harvest score conditioned on the prevailing dealer-gamma regime. */
export interface VrpGexConditioned {
  regime?: string | null;
  /** 0-100 composite. >70 = strong harvest; <30 = avoid. */
  harvest_score?: number | null;
  /** Plain-English explanation; safe to surface verbatim. */
  interpretation?: string | null;
}

/** VRP outlook conditioned on net dealer vanna exposure. */
export interface VrpVannaConditioned {
  /** Forward-looking outlook label. */
  outlook?: string | null;
  interpretation?: string | null;
}

/**
 * Regime snapshot block.
 *
 * `net_gex` lives HERE, not at the top level. `response.net_gex` is
 * undefined; use `response.regime.net_gex`.
 */
export interface VrpRegime {
  /** "positive_gamma" | "negative_gamma" | "neutral" | "undetermined". */
  gamma?: string | null;
  /** "harvestable" | "selling_too_cheap" | etc. `null` when warmup is short. */
  vrp_regime?: string | null;
  /** Net dealer gamma exposure in dollars per 1% spot move. */
  net_gex?: number | null;
  gamma_flip?: number | null;
}

/**
 * 0-100 suitability scores for canonical short-vol strategies. Higher =
 * better fit. Each field can be null when inputs are not computable.
 */
export interface VrpStrategyScores {
  short_put_spread?: number | null;
  short_strangle?: number | null;
  iron_condor?: number | null;
  calendar_spread?: number | null;
}

/**
 * Macro-context snapshot used to condition the VRP outlook.
 *
 * Historical-specific: `fed_funds` is absent (live-only). `hy_spread`
 * is populated here (live returns null currently).
 */
export interface VrpMacro {
  /** CBOE VIX index level. */
  vix?: number | null;
  /** CBOE VIX3M (3-month VIX). */
  vix_3m?: number | null;
  /** `(vix_3m - vix) / vix * 100` — positive = contango. */
  vix_term_slope?: number | null;
  /** 10-year US Treasury yield (%, FRED DGS10). */
  dgs10?: number | null;
  /** ICE BofA US HY OAS. Live currently null; historical populated. */
  hy_spread?: number | null;
}

/**
 * Variance Risk Premium dashboard from `GET /v1/vrp/{symbol}`.
 *
 * The single most-misread response shape in the FlashAlpha API. Every
 * nested block exists for a reason — core metrics, directional skew,
 * gamma conditioning, vanna conditioning, regime, strategy scores, and
 * macro context are deliberately separated.
 *
 * Common silent-null traps (now type-checked at the SDK boundary):
 *   - `response.z_score` → use `response.vrp.z_score`
 *   - `response.percentile` → use `response.vrp.percentile`
 *   - `response.atm_iv` → use `response.vrp.atm_iv`
 *   - `response.vrp_20d` → use `response.vrp.vrp_20d`
 *   - `response.put_vrp` → use `response.directional.downside_vrp`
 *   - `response.call_vrp` → use `response.directional.upside_vrp`
 *   - `response.net_gex` → use `response.regime.net_gex`
 *   - `response.harvest_score` (top-level) → use
 *     `response.gex_conditioned.harvest_score`;
 *     `response.net_harvest_score` is a SEPARATE composite.
 *
 * Returns 403 `tier_restricted` for anything below Alpha plan.
 */
export interface VrpResponse {
  /** Echoed from the request path (e.g. "SPY"). */
  symbol?: string;
  /** Spot mid at `as_of`. */
  underlying_price?: number | null;
  /** ET wall-clock timestamp this snapshot was computed for. */
  as_of?: string;
  /** True if NYSE was open at `as_of`. */
  market_open?: boolean | null;
  /** Core VRP metrics block. See {@link VrpCore}. */
  vrp?: VrpCore;
  /** `vrp_20d / 100` as a decimal. Same as `vrp.vrp_20d / 100`. */
  variance_risk_premium?: number | null;
  /** `fair_vol - atm_iv`. Curvature premium between IV smile and var-swap fair vol. */
  convexity_premium?: number | null;
  /** Variance-swap fair vol (annualised %). */
  fair_vol?: number | null;
  /** Directional VRP skew (downside vs upside). See {@link VrpDirectional}. */
  directional?: VrpDirectional;
  /** Term structure — array of {dte, iv, rv, vrp}. Empty when surface fitting fails. */
  term_vrp?: VrpTermItem[];
  /** GEX-conditioned harvest score. See {@link VrpGexConditioned}. */
  gex_conditioned?: VrpGexConditioned;
  /** Vanna-conditioned outlook. See {@link VrpVannaConditioned}. */
  vanna_conditioned?: VrpVannaConditioned;
  /** Regime snapshot block. `net_gex` lives HERE, not top-level. */
  regime?: VrpRegime;
  /** 0-100 strategy suitability scores. Null on historical when warmup is short. */
  strategy_scores?: VrpStrategyScores | null;
  /** 0-100 composite harvest signal. Null on historical when warmup is short. */
  net_harvest_score?: number | null;
  /** 0-100 — risk that dealer hedging flow disrupts a short-vol harvest. */
  dealer_flow_risk?: number | null;
  /** Server-side warnings about data quality. Always present (possibly empty). */
  warnings?: string[];
  /** Macro context. See {@link VrpMacro}. */
  macro?: VrpMacro;
}


// ─── MaxPain ─────────────────────────────────────────────────────────────────
//
// Typed model for `GET /v1/maxpain/{symbol}?at=...` (Basic+).
//
// Same shape as the live API, with one operational difference:
// `oi_by_strike[].call_volume` and `put_volume` are always `0` on historical
// (the minute-resolution options table doesn't carry intraday volume).


/** Distance from spot to the max-pain strike. */
export interface MaxPainDistance {
  /** Dollar distance: `|underlying_price - max_pain_strike|`. */
  absolute?: number | null;
  /** Percent of spot: `absolute / underlying_price * 100`. */
  percent?: number | null;
  /** Spot relative to max-pain. */
  direction?: 'above' | 'below' | 'at' | null;
}

/**
 * One row of the strike-by-strike pain curve.
 *
 * Each row is the dollar pain (intrinsic value × OI × 100 contract
 * multiplier) summed across all expirations at that strike. The strike
 * where `total_pain` is minimized is the max-pain strike.
 */
export interface MaxPainCurveRow {
  strike?: number | null;
  /** Dollar intrinsic value of all calls at this strike summed across the chain. */
  call_pain?: number | null;
  /** Dollar intrinsic value of all puts at this strike. */
  put_pain?: number | null;
  /** `call_pain + put_pain`. The pain curve's minimum identifies max pain. */
  total_pain?: number | null;
}

/**
 * One row of the OI-by-strike breakdown.
 *
 * Note: on the Historical API, `call_volume` and `put_volume` are always
 * `0` (placeholder fields — the minute table doesn't carry intraday volume).
 */
export interface MaxPainOiRow {
  strike?: number | null;
  call_oi?: number | null;
  put_oi?: number | null;
  total_oi?: number | null;
  call_volume?: number | null;
  put_volume?: number | null;
}

/**
 * Per-expiry max-pain breakdown when no `expiration` filter is applied.
 *
 * `null` when the request specified an expiration filter — the response
 * is then scoped to that single expiry and the multi-expiry view is
 * suppressed.
 */
export interface MaxPainByExpirationRow {
  expiration?: string | null;
  max_pain_strike?: number | null;
  /** Days to expiry (counting from `as_of`). */
  dte?: number | null;
  total_oi?: number | null;
}

/**
 * GEX-based dealer-alignment overlay on the max-pain view.
 *
 * The headline `alignment` label tells you whether dealer hedging will
 * REINFORCE the max-pain pin or fight it.
 */
export interface MaxPainDealerAlignment {
  /**
   * - `"converging"`: max pain near gamma flip and between walls — strongest pin.
   * - `"moderate"`: between walls but far from flip.
   * - `"diverging"`: max pain outside the wall range.
   * - `"unknown"`: insufficient data.
   */
  alignment?: 'converging' | 'moderate' | 'diverging' | 'unknown' | null;
  /** Plain-English explanation. Safe to surface verbatim. */
  description?: string | null;
  /** Strike where net dealer gamma crosses zero. */
  gamma_flip?: number | null;
  /** Strike with highest absolute call GEX (dealer-side resistance). */
  call_wall?: number | null;
  /** Strike with highest absolute put GEX (dealer-side support). */
  put_wall?: number | null;
}

/** Implied move from the ATM straddle, contextualized vs max pain. */
export interface MaxPainExpectedMove {
  /** ATM straddle mid in dollars. Rough proxy for the 1σ implied move. */
  straddle_price?: number | null;
  /** ATM implied volatility (annualised %, e.g. 18.5 = 18.5%). */
  atm_iv?: number | null;
  /** `true` when `|spot - max_pain_strike| <= straddle_price`. */
  max_pain_within_expected_range?: boolean | null;
}

/**
 * Max pain dashboard from `GET /v1/maxpain/{symbol}` (Basic+).
 *
 * Returns the strike where total option-holder pain is minimized, plus
 * per-strike pain curve, OI breakdown, per-expiry calendar (when no
 * `expiration` filter), GEX-based dealer alignment, expected move from
 * the ATM straddle, and a 0-100 pin probability composite.
 */
export interface MaxPainResponse {
  symbol?: string;
  underlying_price?: number | null;
  as_of?: string;
  /** Strike where total chain pain is minimized. */
  max_pain_strike?: number | null;
  distance?: MaxPainDistance;
  /**
   * - `"bullish"`: spot >= 5% below max_pain (pin attracts upside).
   * - `"bearish"`: spot >= 5% above.
   * - `"neutral"`: within 5%.
   */
  signal?: 'bullish' | 'bearish' | 'neutral' | null;
  /**
   * Expiration this view is scoped to. When the request omits the
   * `expiration` filter, this is the front-month expiry the full-chain
   * max-pain happened to land on.
   */
  expiration?: string | null;
  /** Total put OI / total call OI across the relevant chain. >1.0 = put-heavy. */
  put_call_oi_ratio?: number | null;
  pain_curve?: MaxPainCurveRow[];
  oi_by_strike?: MaxPainOiRow[];
  /** `null` when the request specified an `expiration` filter. */
  max_pain_by_expiration?: MaxPainByExpirationRow[] | null;
  dealer_alignment?: MaxPainDealerAlignment;
  /** Same classifier as `exposure_summary.regime`. */
  regime?: 'positive_gamma' | 'negative_gamma' | 'neutral' | 'undetermined' | null;
  expected_move?: MaxPainExpectedMove;
  /**
   * 0-100 composite — likelihood of pinning to `max_pain_strike`. Inputs:
   * OI concentration (30%), magnet proximity (25%), time remaining (25%),
   * gamma magnitude (20%). Most meaningful for near-term expiries.
   */
  pin_probability?: number | null;
}


// ─── StockSummary ────────────────────────────────────────────────────────────
//
// Typed model for `GET /v1/stock/{symbol}/summary?at=...`.
//
// Same response shape as the live API — see the live SDK's docs for the
// full description. Historical-specific notes:
//   - The `at=` query parameter is REQUIRED. The API snaps to the nearest
//     available minute on or before `at` and returns that snapshot in
//     `as_of`. Always inspect `as_of` to confirm you got what you asked
//     for; on gap days (holidays, pre-2018-04-16) the request will error.
//   - `market_open` reflects NYSE session state at the snapped `as_of`,
//     not at the requested `at`.

/** Top-of-book spot quote at the snapped `as_of`. */
export interface StockSummaryPrice {
  bid?: number | null;
  ask?: number | null;
  /** `(bid + ask) / 2`. */
  mid?: number | null;
  last?: number | null;
  /** ISO timestamp of the last trade or quote tick. */
  last_update?: string | null;
}

/**
 * One row of the 25-delta skew curve — call/put 25-delta IVs vs the ATM
 * strike for a single expiry.
 */
export interface StockSummarySkew25d {
  /** Expiry date (YYYY-MM-DD). */
  expiry?: string | null;
  /** Calendar days to this expiry. */
  days_to_expiry?: number | null;
  /** 25-delta put IV (annualised %). */
  put_25d_iv?: number | null;
  /** ATM IV (annualised %). */
  atm_iv?: number | null;
  /** 25-delta call IV (annualised %). */
  call_25d_iv?: number | null;
  /** `put_25d_iv - call_25d_iv`. Positive = downside-skewed. */
  skew_25d?: number | null;
  /** `(put_25d_iv + call_25d_iv) / 2 / atm_iv`. */
  smile_ratio?: number | null;
}

/** One node of the ATM IV term structure — `{expiry, iv, days_to_expiry}`. */
export interface StockSummaryIvTermItem {
  expiry?: string | null;
  /** ATM IV at this expiry (annualised %). */
  iv?: number | null;
  days_to_expiry?: number | null;
}

/**
 * Volatility block — implied, realized, VRP scalar, skew, and term
 * structure.
 *
 * `vrp` is a single scalar here (`atm_iv - hv_20`); the full directional
 * VRP dashboard lives at `/v1/vrp/{symbol}` (`VrpResponse`).
 */
export interface StockSummaryVolatility {
  /** ATM implied volatility (annualised %). */
  atm_iv?: number | null;
  /** 20-day historical (close-to-close) volatility, annualised %. */
  hv_20?: number | null;
  /** 60-day historical volatility, annualised %. */
  hv_60?: number | null;
  /** Variance risk premium scalar: `atm_iv - hv_20`. */
  vrp?: number | null;
  /** 25-delta skew at the front expiry. See {@link StockSummarySkew25d}. */
  skew_25d?: StockSummarySkew25d | null;
  /** ATM IV term structure across listed expiries. */
  iv_term_structure?: StockSummaryIvTermItem[];
}

/** Aggregate options-flow stats across the listed expirations. */
export interface StockSummaryOptionsFlow {
  total_call_oi?: number | null;
  total_put_oi?: number | null;
  total_call_volume?: number | null;
  total_put_volume?: number | null;
  /** Total put OI / total call OI. >1.0 = put-heavy. */
  pc_ratio_oi?: number | null;
  /** Total put volume / total call volume. */
  pc_ratio_volume?: number | null;
  /** Number of expirations contributing to the aggregates. */
  active_expirations?: number | null;
}

/** Plain-English interpretation of the dealer-exposure block. Safe verbatim. */
export interface StockSummaryInterpretation {
  gamma?: string | null;
  vanna?: string | null;
  charm?: string | null;
}

/**
 * One bucket of the hedging estimate.
 *
 * IMPORTANT: on `/v1/stock/{symbol}/summary`, `dealer_shares` is the
 * MAGNITUDE (always non-negative) — the sign is carried by `direction`.
 * This differs from `/v1/exposure/zero-dte/`, where fields like
 * `net_chex` and `net_vex` are signed scalars. Always combine
 * `dealer_shares` with `direction` to reconstruct the signed flow.
 */
export interface StockSummaryHedgingMove {
  /** Magnitude of dealer shares to trade (always >= 0). */
  dealer_shares?: number | null;
  /** `'buy'` = dealers must buy; `'sell'` = dealers must sell. */
  direction?: 'buy' | 'sell' | null;
  /** `dealer_shares * spot`, in USD. */
  notional_usd?: number | null;
}

/** Hedging estimate for a 1% spot move up vs down. */
export interface StockSummaryHedgingEstimate {
  spot_up_1pct?: StockSummaryHedgingMove;
  spot_down_1pct?: StockSummaryHedgingMove;
}

/** 0DTE summary line — net GEX and its share of the chain total. */
export interface StockSummaryZeroDte {
  /** Signed net dealer GEX from 0DTE only. */
  net_gex?: number | null;
  /** 0DTE share of total chain absolute GEX (0-100). */
  pct_of_total?: number | null;
  /** 0DTE expiration (YYYY-MM-DD). */
  expiration?: string | null;
}

/** Top strike by absolute net GEX, with OI breakdown. */
export interface StockSummaryTopStrike {
  strike?: number | null;
  net_gex?: number | null;
  call_oi?: number | null;
  put_oi?: number | null;
  total_oi?: number | null;
}

/**
 * Dealer-exposure block — the same regime classifier and key levels as
 * `/v1/exposure/summary/`, plus an embedded 0DTE summary, top strikes,
 * and an OI-weighted DTE.
 *
 * `null` on the response when there's no usable options data
 * (illiquid name, dataset gap, etc.).
 */
export interface StockSummaryExposure {
  /** Net dealer gamma exposure ($ per 1% spot move). */
  net_gex?: number | null;
  /** Net dealer delta exposure (shares-equivalent). */
  net_dex?: number | null;
  /** Net dealer vanna exposure. */
  net_vex?: number | null;
  /** Net dealer charm exposure. */
  net_chex?: number | null;
  /** Strike where net dealer gamma crosses zero. */
  gamma_flip?: number | null;
  /** Strike with highest absolute call GEX (resistance). */
  call_wall?: number | null;
  /** Strike with highest absolute put GEX (support). */
  put_wall?: number | null;
  /** Max-pain strike across the listed chain. */
  max_pain?: number | null;
  /** Strike with highest total OI (calls + puts). */
  highest_oi_strike?: number | null;
  /**
   * `'positive_gamma'` = dealers long gamma (mean-reverting tape).
   * `'negative_gamma'` = dealers short gamma (trend-amplifying tape).
   * `'undetermined'` = insufficient data.
   */
  regime?: 'positive_gamma' | 'negative_gamma' | 'undetermined' | null;
  /** Plain-English interpretation. */
  interpretation?: StockSummaryInterpretation;
  /** Hedging estimate for ±1% spot moves. */
  hedging_estimate?: StockSummaryHedgingEstimate;
  /** Embedded 0DTE summary (subset of `/v1/exposure/zero-dte/`). */
  zero_dte?: StockSummaryZeroDte | null;
  /** Top strikes by absolute net GEX. */
  top_strikes?: StockSummaryTopStrike[];
  /** OI-weighted average days-to-expiry across the chain. */
  oi_weighted_dte?: number | null;
}

/** Generic macro index row — `{value, change, change_pct}`. */
export interface StockSummaryMacroIndex {
  value?: number | null;
  /** Daily change in raw units. */
  change?: number | null;
  /** Daily percentage change. */
  change_pct?: number | null;
}

/** VIX complex term-structure levels. */
export interface StockSummaryVixTermLevels {
  vix9d?: number | null;
  vix?: number | null;
  vix3m?: number | null;
  vix6m?: number | null;
}

/** VIX term-structure block with shape classification. */
export interface StockSummaryVixTermStructure {
  levels?: StockSummaryVixTermLevels;
  /** Slope from VIX9D → VIX3M, in percent. */
  near_slope_pct?: number | null;
  /** `'contango'` = upward-sloping; `'backwardation'` = inverted (stress). */
  structure?: 'contango' | 'backwardation' | null;
}

/** VIX futures front-month vs spot, basis, and basis classification. */
export interface StockSummaryVixFutures {
  /** Front-month VIX futures price. */
  front_month?: number | null;
  /** VIX spot. */
  spot?: number | null;
  /** `front_month - spot`. */
  spread?: number | null;
  /** `(front_month - spot) / spot * 100`. */
  basis_pct?: number | null;
  /** `'contango'` = future > spot; `'backwardation'` = future < spot (stress). */
  basis?: 'contango' | 'backwardation' | null;
}

/** CNN-style fear and greed composite. */
export interface StockSummaryFearAndGreed {
  /** 0-100 composite score. */
  score?: number | null;
  /** Categorical rating ("Extreme Fear", "Greed", etc.). */
  rating?: string | null;
}

/**
 * Macro snapshot — the major vol/sentiment indices at `as_of`.
 *
 * Each scalar index is wrapped in a `{value, change, change_pct}` shape
 * (or `null` if the API couldn't fetch it).
 */
export interface StockSummaryMacro {
  /** CBOE VIX index. */
  vix?: StockSummaryMacroIndex | null;
  /** CBOE VVIX (vol of vol). */
  vvix?: StockSummaryMacroIndex | null;
  /** CBOE SKEW index. */
  skew?: StockSummaryMacroIndex | null;
  /** S&P 500 cash index. */
  spx?: StockSummaryMacroIndex | null;
  /** ICE BofAML MOVE (Treasury vol). */
  move?: StockSummaryMacroIndex | null;
  /** VIX term structure with shape classification. */
  vix_term_structure?: StockSummaryVixTermStructure | null;
  /** VIX futures front-month vs spot. */
  vix_futures?: StockSummaryVixFutures | null;
  /** Fear and greed composite. */
  fear_and_greed?: StockSummaryFearAndGreed | null;
}

/**
 * FlashAlpha's "single best snapshot" at a point in time —
 * `GET /v1/stock/{symbol}/summary?at=...`.
 *
 * Bundles in one call:
 *   - top-of-book price (bid/ask/mid/last)
 *   - implied vol, 20d/60d realized vol, VRP scalar, 25-delta skew,
 *     and ATM IV term structure
 *   - aggregate options flow (OI, volume, PC ratios)
 *   - the FULL dealer-exposure block (regime, GEX/DEX/VEX/CHEX, walls,
 *     max pain, hedging estimate, 0DTE share, top strikes)
 *   - a macro snapshot (VIX/VVIX/SKEW/SPX/MOVE, term structure, futures
 *     basis, fear-and-greed)
 *
 * Historical-specific:
 *   - `at=` is REQUIRED. The API snaps to the nearest available minute
 *     on or before `at` and returns that snapshot in `as_of`. Always
 *     inspect `as_of` to confirm.
 *   - `market_open` reflects NYSE session state at the snapped `as_of`.
 *
 * IMPORTANT: `exposure.hedging_estimate.{spot_up_1pct,spot_down_1pct}.dealer_shares`
 * is MAGNITUDE on this endpoint — sign is carried by `direction`.
 * This differs from `/v1/exposure/zero-dte/`, where fields like
 * `net_chex` and `net_vex` are signed scalars.
 */
export interface StockSummaryResponse {
  /** Echoed from the request path (e.g. "SPY"). */
  symbol?: string;
  /** ET wall-clock timestamp the response is scoped to (snapped from `at`). */
  as_of?: string;
  /** True if NYSE was open at the snapped `as_of`. */
  market_open?: boolean | null;
  price?: StockSummaryPrice;
  volatility?: StockSummaryVolatility;
  options_flow?: StockSummaryOptionsFlow;
  /** Full dealer-exposure block. `null` when no usable options data. */
  exposure?: StockSummaryExposure | null;
  macro?: StockSummaryMacro;
}


// ─── Narrative ───────────────────────────────────────────────────────────────
//
// Typed model for `GET /v1/exposure/narrative/{symbol}?at=...` (Growth+).
//
// FlashAlpha's "LLM-friendly verbal output" — same exposure data as
// `/v1/exposure/summary/` rephrased into plain-English narrative strings,
// safe to surface verbatim into a chat UI or LLM context window.
//
// Historical-specific: `at=` is required and the response is snapped to the
// nearest available minute (see `as_of`).

/** One row of the top OI changes table. */
export interface NarrativeOiChange {
  strike?: number | null;
  /** `'call'` or `'put'`. */
  type?: 'call' | 'put' | null;
  /** Day-over-day change in OI. */
  oi_change?: number | null;
  volume?: number | null;
}

/** Quantitative data block backing the narrative strings. */
export interface NarrativeData {
  /** Net dealer gamma exposure ($ per 1% spot move). */
  net_gex?: number | null;
  /** Prior session net GEX. */
  net_gex_prior?: number | null;
  /** `(net_gex - net_gex_prior) / |net_gex_prior| * 100`. */
  net_gex_change_pct?: number | null;
  /** CBOE VIX level at `as_of`. */
  vix?: number | null;
  /** Strike where net dealer gamma crosses zero. */
  gamma_flip?: number | null;
  /** Highest-absolute-call-GEX strike. */
  call_wall?: number | null;
  /** Highest-absolute-put-GEX strike. */
  put_wall?: number | null;
  regime?: 'positive_gamma' | 'negative_gamma' | 'neutral' | 'undetermined' | null;
  /** 0DTE share of total chain absolute GEX (0-100). */
  zero_dte_pct?: number | null;
  top_oi_changes?: NarrativeOiChange[];
}

/**
 * Plain-English narrative strings.
 *
 * Each field is human-readable and safe to surface verbatim into a chat
 * UI, LLM context, or alerting message — they're sentence-level
 * descriptions of the underlying numbers in `data`.
 */
export interface Narrative {
  /** Dealer gamma regime narrative. */
  regime?: string | null;
  /** Day-over-day GEX change narrative. */
  gex_change?: string | null;
  /** Walls, gamma flip, max pain narrative. */
  key_levels?: string | null;
  /** Options flow narrative. */
  flow?: string | null;
  /** Net vanna exposure narrative. */
  vanna?: string | null;
  /** Net charm exposure narrative. */
  charm?: string | null;
  /** 0DTE share narrative. */
  zero_dte?: string | null;
  /** Forward-looking outlook synthesis. */
  outlook?: string | null;
  /** Quantitative data block backing the narrative strings. */
  data?: NarrativeData;
}

/**
 * FlashAlpha's "LLM-friendly verbal output" from
 * `GET /v1/exposure/narrative/{symbol}?at=...` (Growth+).
 *
 * Same exposure data as `/v1/exposure/summary/` but rephrased into
 * sentence-level narrative strings, safe to surface verbatim into a chat
 * UI, LLM context, or alerting message. Pair the strings in `narrative`
 * with the numbers in `narrative.data` for hybrid quant + verbal output.
 */
export interface NarrativeResponse {
  /** Echoed from the request path (e.g. "SPY"). */
  symbol?: string;
  /** Spot mid at the snapped `as_of`. */
  underlying_price?: number | null;
  /** ET wall-clock timestamp this snapshot was computed for. */
  as_of?: string;
  narrative?: Narrative;
}


// ─── ExposureLevels ──────────────────────────────────────────────────────────
//
// Typed model for `GET /v1/exposure/levels/{symbol}?at=...`.
//
// Pure key-levels endpoint — extracts only the support/resistance strikes
// from the full exposure block. Use this when you want a chart overlay
// without the full GEX/DEX/VEX/CHEX dashboard payload.

/**
 * Key support/resistance strikes derived from the full options chain.
 *
 * Each level is a strike price (or `null` when uncomputable):
 *   - `gamma_flip`: net dealer gamma crosses zero
 *   - `max_positive_gamma` / `max_negative_gamma`: extrema of the GEX-by-strike curve
 *   - `call_wall` / `put_wall`: highest absolute call/put GEX
 *   - `highest_oi_strike`: highest total OI (calls + puts)
 *   - `zero_dte_magnet`: dominant 0DTE pin strike (null off 0DTE days)
 */
export interface ExposureLevels {
  gamma_flip?: number | null;
  max_positive_gamma?: number | null;
  max_negative_gamma?: number | null;
  call_wall?: number | null;
  put_wall?: number | null;
  highest_oi_strike?: number | null;
  zero_dte_magnet?: number | null;
}

/**
 * Key levels from `GET /v1/exposure/levels/{symbol}?at=...`.
 *
 * Lean payload — just the support/resistance strikes (gamma flip, walls,
 * max pos/neg gamma, highest OI, 0DTE magnet) without the surrounding
 * dashboard. Ideal for chart overlays and small-context LLM prompts.
 */
export interface ExposureLevelsResponse {
  /** Echoed from the request path (e.g. "SPY"). */
  symbol?: string;
  /** Spot mid at the snapped `as_of`. */
  underlying_price?: number | null;
  /** ET wall-clock timestamp this snapshot was computed for. */
  as_of?: string;
  levels?: ExposureLevels;
}
