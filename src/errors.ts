/**
 * Error types for the FlashAlpha Historical SDK.
 *
 * Mirrors the typed error tree of the live SDK, plus historical-specific
 * 404 variants (`NoDataError`, `NoCoverageError`, `SymbolNotFoundError`,
 * `InsufficientDataError`) and a 400 `InvalidAtError` for malformed `at`.
 */

export class FlashAlphaHistoricalError extends Error {
  public readonly statusCode: number;
  public readonly response: unknown;

  constructor(message: string, statusCode: number, response: unknown) {
    super(message);
    this.name = 'FlashAlphaHistoricalError';
    this.statusCode = statusCode;
    this.response = response;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AuthenticationError extends FlashAlphaHistoricalError {
  constructor(message: string, statusCode: number, response: unknown) {
    super(message, statusCode, response);
    this.name = 'AuthenticationError';
  }
}

export class TierRestrictedError extends FlashAlphaHistoricalError {
  public readonly currentPlan: string | undefined;
  public readonly requiredPlan: string | undefined;

  constructor(
    message: string,
    statusCode: number,
    response: unknown,
    currentPlan?: string,
    requiredPlan?: string,
  ) {
    super(message, statusCode, response);
    this.name = 'TierRestrictedError';
    this.currentPlan = currentPlan;
    this.requiredPlan = requiredPlan;
  }
}

export class InvalidAtError extends FlashAlphaHistoricalError {
  constructor(message: string, statusCode: number, response: unknown) {
    super(message, statusCode, response);
    this.name = 'InvalidAtError';
  }
}

/** 404: specific (symbol, at) has no data — outside coverage or in a gap. */
export class NoDataError extends FlashAlphaHistoricalError {
  constructor(message: string, statusCode: number, response: unknown) {
    super(message, statusCode, response);
    this.name = 'NoDataError';
  }
}

/** 404: symbol is not in the historical dataset (`/v1/tickers?symbol=`). */
export class NoCoverageError extends FlashAlphaHistoricalError {
  constructor(message: string, statusCode: number, response: unknown) {
    super(message, statusCode, response);
    this.name = 'NoCoverageError';
  }
}

/** 404: symbol has no historical data at the requested `at`. */
export class SymbolNotFoundError extends FlashAlphaHistoricalError {
  constructor(message: string, statusCode: number, response: unknown) {
    super(message, statusCode, response);
    this.name = 'SymbolNotFoundError';
  }
}

/** 404: surface grid can't be built (too few OTM+liquid contracts). */
export class InsufficientDataError extends FlashAlphaHistoricalError {
  constructor(message: string, statusCode: number, response: unknown) {
    super(message, statusCode, response);
    this.name = 'InsufficientDataError';
  }
}

export class RateLimitError extends FlashAlphaHistoricalError {
  public readonly retryAfter: number | undefined;

  constructor(
    message: string,
    statusCode: number,
    response: unknown,
    retryAfter?: number,
  ) {
    super(message, statusCode, response);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class ServerError extends FlashAlphaHistoricalError {
  constructor(message: string, statusCode: number, response: unknown) {
    super(message, statusCode, response);
    this.name = 'ServerError';
  }
}
