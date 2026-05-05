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
