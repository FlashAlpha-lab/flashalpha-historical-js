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
