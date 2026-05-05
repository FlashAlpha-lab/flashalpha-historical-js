/**
 * FlashAlpha Historical SDK — public exports.
 */

export {
  FlashAlphaHistorical,
  formatAt,
  BASE_URL,
} from './client';
export type {
  AtLike,
  AtOptions,
  FlashAlphaHistoricalOptions,
  TickersOptions,
  OptionQuoteOptions,
  ExposureWithExpirationOptions,
  GexOptions,
  ZeroDteOptions,
  MaxPainOptions,
} from './client';

export {
  AuthenticationError,
  FlashAlphaHistoricalError,
  InsufficientDataError,
  InvalidAtError,
  NoCoverageError,
  NoDataError,
  RateLimitError,
  ServerError,
  SymbolNotFoundError,
  TierRestrictedError,
} from './errors';

export {
  Backtester,
  iterDays,
  iterMinutes,
  isTradingDay,
  replay,
} from './replay';
export type {
  BacktestStep,
  BacktesterOptions,
  IterDaysOptions,
  IterMinutesOptions,
  ReplayOptions,
  ReplayResult,
  Strategy,
} from './replay';

export type {
  ExposureSummaryExposures,
  ExposureSummaryHedgingEstimate,
  ExposureSummaryHedgingMove,
  ExposureSummaryInterpretation,
  ExposureSummaryResponse,
  ExposureSummaryZeroDte,
  // ── VRP ──
  VrpResponse,
  VrpCore,
  VrpDirectional,
  VrpTermItem,
  VrpGexConditioned,
  VrpVannaConditioned,
  VrpRegime,
  VrpStrategyScores,
  VrpMacro,
} from './types';
