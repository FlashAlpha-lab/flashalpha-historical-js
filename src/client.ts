/**
 * FlashAlpha Historical API client.
 *
 * Point-in-time replay of every live FlashAlpha analytics endpoint. Every
 * analytics method takes a required `at` value — string, `Date`, or epoch
 * millis — and returns the same response shape as the live API at that
 * moment in history.
 *
 * Base URL: https://historical.flashalpha.com
 *
 * Requires Node.js 18+ (uses built-in fetch).
 */

import {
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
import type {
  ExposureLevelsResponse,
  ExposureSummaryResponse,
  MaxPainResponse,
  NarrativeResponse,
  StockSummaryResponse,
  VrpResponse,
  ZeroDteResponse,
} from './types';

export const BASE_URL = 'https://historical.flashalpha.com';
const DEFAULT_TIMEOUT = 60_000;

/** A point-in-time `at` value. ET wall-clock — do NOT shift by UTC offset. */
export type AtLike = string | Date;

/** URL-escape a single path segment. */
const _seg = (s: string): string => encodeURIComponent(s);

const _pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

/**
 * Coerce an `at` value to the ET wall-clock string the API expects.
 *
 * Strings pass through unchanged. `Date` objects are formatted as
 * `yyyy-MM-ddTHH:mm:ss` using the date's *local* clock — the convention is
 * "ET wall-clock", so callers building `Date` objects should construct them
 * in the ET frame they want to query (e.g. `new Date('2026-03-05T15:30:00')`
 * with the runtime in ET, or use a string directly).
 */
export function formatAt(at: AtLike): string {
  if (typeof at === 'string') return at;
  if (at instanceof Date) {
    return (
      `${at.getFullYear()}-${_pad(at.getMonth() + 1)}-${_pad(at.getDate())}` +
      `T${_pad(at.getHours())}:${_pad(at.getMinutes())}:${_pad(at.getSeconds())}`
    );
  }
  throw new TypeError(`\`at\` must be a string or Date — got ${typeof at}`);
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface FlashAlphaHistoricalOptions {
  /** Override the API base URL (useful for testing). */
  baseUrl?: string;
  /** Request timeout in milliseconds. Default: 60000. */
  timeout?: number;
  /** Override the fetch implementation (useful for testing). */
  fetch?: FetchFn;
}

// ── parameter option shapes ──────────────────────────────────────────────────

export interface AtOptions {
  at: AtLike;
}

export interface TickersOptions {
  symbol?: string;
}

export interface OptionQuoteOptions extends AtOptions {
  expiry?: string;
  strike?: number;
  type?: string;
}

export interface ExposureWithExpirationOptions extends AtOptions {
  expiration?: string;
}

export interface GexOptions extends AtOptions {
  expiration?: string;
  minOi?: number;
}

export interface ZeroDteOptions extends AtOptions {
  strikeRange?: number;
}

export interface MaxPainOptions extends AtOptions {
  expiration?: string;
}

// ── client ────────────────────────────────────────────────────────────────────

export class FlashAlphaHistorical {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly fetchImpl: FetchFn;

  constructor(apiKey: string, options: FlashAlphaHistoricalOptions = {}) {
    if (!apiKey) {
      throw new Error('apiKey is required');
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/+$/, '');
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FetchFn);
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private buildUrl(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async _get(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    const url = this.buildUrl(path, params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    return this._handle(response);
  }

  private async _handle(response: Response): Promise<unknown> {
    const status = response.status;
    if (status === 200) {
      return response.json();
    }

    const rawText = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      body = { detail: rawText };
    }

    const code = body['error'] as string | undefined;
    const msg = String(body['message'] ?? body['detail'] ?? `HTTP ${status}`);

    if (status === 400) {
      if (code === 'invalid_at') throw new InvalidAtError(msg, 400, body);
      throw new FlashAlphaHistoricalError(msg, 400, body);
    }
    if (status === 401) throw new AuthenticationError(msg, 401, body);
    if (status === 403) {
      throw new TierRestrictedError(
        msg,
        403,
        body,
        body['current_plan'] as string | undefined,
        body['required_plan'] as string | undefined,
      );
    }
    if (status === 404) {
      if (code === 'no_coverage') throw new NoCoverageError(msg, 404, body);
      if (code === 'symbol_not_found')
        throw new SymbolNotFoundError(msg, 404, body);
      if (code === 'insufficient_data')
        throw new InsufficientDataError(msg, 404, body);
      // Treat all remaining 404s (including bare `{error: "<text>"}` from
      // optionquote) as no_data — they all mean "this minute has no row".
      throw new NoDataError(msg, 404, body);
    }
    if (status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfter = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) || undefined
        : undefined;
      throw new RateLimitError(msg, 429, body, retryAfter);
    }
    if (status >= 500) throw new ServerError(msg, status, body);

    throw new FlashAlphaHistoricalError(msg, status, body);
  }

  // ── Coverage & Support ──────────────────────────────────────────────────────

  /**
   * List symbols with historical coverage. With `symbol`, returns one
   * coverage object; throws `NoCoverageError` if the symbol isn't in
   * the historical dataset.
   */
  async tickers(options: TickersOptions = {}): Promise<unknown> {
    const params = options.symbol ? { symbol: options.symbol } : undefined;
    return this._get('/v1/tickers', params);
  }

  // ── Market Data ─────────────────────────────────────────────────────────────

  async stockQuote(ticker: string, options: AtOptions): Promise<unknown> {
    return this._get(`/v1/stockquote/${_seg(ticker)}`, {
      at: formatAt(options.at),
    });
  }

  /**
   * Option quote(s) + greeks + OI. With all three filters → single object;
   * otherwise → array. `bidSize` / `askSize` / `volume` always 0 (minute
   * table has no sizes); `svi_vol` always null in backtest mode.
   */
  async optionQuote(
    ticker: string,
    options: OptionQuoteOptions,
  ): Promise<unknown> {
    const params: Record<string, string | number | undefined> = {
      at: formatAt(options.at),
    };
    if (options.expiry) params['expiry'] = options.expiry;
    if (options.strike !== undefined) params['strike'] = options.strike;
    if (options.type) params['type'] = options.type;
    return this._get(`/v1/optionquote/${_seg(ticker)}`, params);
  }

  /** 50×50 IV surface grid. Throws `InsufficientDataError` on sparse days. */
  async surface(symbol: string, options: AtOptions): Promise<unknown> {
    return this._get(`/v1/surface/${_seg(symbol)}`, {
      at: formatAt(options.at),
    });
  }

  // ── Exposure Analytics ──────────────────────────────────────────────────────

  async gex(symbol: string, options: GexOptions): Promise<unknown> {
    const params: Record<string, string | number | undefined> = {
      at: formatAt(options.at),
    };
    if (options.expiration) params['expiration'] = options.expiration;
    if (options.minOi !== undefined) params['min_oi'] = options.minOi;
    return this._get(`/v1/exposure/gex/${_seg(symbol)}`, params);
  }

  async dex(
    symbol: string,
    options: ExposureWithExpirationOptions,
  ): Promise<unknown> {
    const params: Record<string, string | number | undefined> = {
      at: formatAt(options.at),
    };
    if (options.expiration) params['expiration'] = options.expiration;
    return this._get(`/v1/exposure/dex/${_seg(symbol)}`, params);
  }

  async vex(
    symbol: string,
    options: ExposureWithExpirationOptions,
  ): Promise<unknown> {
    const params: Record<string, string | number | undefined> = {
      at: formatAt(options.at),
    };
    if (options.expiration) params['expiration'] = options.expiration;
    return this._get(`/v1/exposure/vex/${_seg(symbol)}`, params);
  }

  async chex(
    symbol: string,
    options: ExposureWithExpirationOptions,
  ): Promise<unknown> {
    const params: Record<string, string | number | undefined> = {
      at: formatAt(options.at),
    };
    if (options.expiration) params['expiration'] = options.expiration;
    return this._get(`/v1/exposure/chex/${_seg(symbol)}`, params);
  }

  async exposureSummary(symbol: string, options: AtOptions): Promise<ExposureSummaryResponse> {
    return this._get(`/v1/exposure/summary/${_seg(symbol)}`, {
      at: formatAt(options.at),
    }) as Promise<ExposureSummaryResponse>;
  }

  async exposureLevels(symbol: string, options: AtOptions): Promise<ExposureLevelsResponse> {
    return this._get(`/v1/exposure/levels/${_seg(symbol)}`, {
      at: formatAt(options.at),
    }) as Promise<ExposureLevelsResponse>;
  }

  async narrative(symbol: string, options: AtOptions): Promise<NarrativeResponse> {
    return this._get(`/v1/exposure/narrative/${_seg(symbol)}`, {
      at: formatAt(options.at),
    }) as Promise<NarrativeResponse>;
  }

  /**
   * 0DTE-specific analytics. `time_to_close_hours` is computed from `at` vs
   * 16:00 ET so intraday theta / greek-acceleration values are
   * minute-accurate. Note: intraday 0DTE greeks may arrive as 0 / null for
   * very-near-expiry contracts at minute resolution.
   */
  async zeroDte(symbol: string, options: ZeroDteOptions): Promise<ZeroDteResponse> {
    const params: Record<string, string | number | undefined> = {
      at: formatAt(options.at),
    };
    if (options.strikeRange !== undefined)
      params['strike_range'] = options.strikeRange;
    return this._get(`/v1/exposure/zero-dte/${_seg(symbol)}`, params) as Promise<ZeroDteResponse>;
  }

  // ── Max Pain ────────────────────────────────────────────────────────────────

  async maxPain(symbol: string, options: MaxPainOptions): Promise<MaxPainResponse> {
    const params: Record<string, string | number | undefined> = {
      at: formatAt(options.at),
    };
    if (options.expiration) params['expiration'] = options.expiration;
    return this._get(`/v1/maxpain/${_seg(symbol)}`, params) as Promise<MaxPainResponse>;
  }

  // ── Stock Summary (composite) ──────────────────────────────────────────────

  async stockSummary(symbol: string, options: AtOptions): Promise<StockSummaryResponse> {
    return this._get(`/v1/stock/${_seg(symbol)}/summary`, {
      at: formatAt(options.at),
    }) as Promise<StockSummaryResponse>;
  }

  // ── Volatility ──────────────────────────────────────────────────────────────

  async volatility(symbol: string, options: AtOptions): Promise<unknown> {
    return this._get(`/v1/volatility/${_seg(symbol)}`, {
      at: formatAt(options.at),
    });
  }

  async advVolatility(symbol: string, options: AtOptions): Promise<unknown> {
    return this._get(`/v1/adv_volatility/${_seg(symbol)}`, {
      at: formatAt(options.at),
    });
  }

  // ── VRP ─────────────────────────────────────────────────────────────────────

  /**
   * Variance Risk Premium dashboard. Percentile / z-score history is
   * date-bounded — only snapshots dated strictly before `at` are included,
   * so percentiles reflect what was knowable at that moment (no future
   * leakage).
   */
  async vrp(symbol: string, options: AtOptions): Promise<VrpResponse> {
    return this._get(`/v1/vrp/${_seg(symbol)}`, {
      at: formatAt(options.at),
    }) as Promise<VrpResponse>;
  }
}
