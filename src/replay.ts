/**
 * Backtesting helpers — point-in-time replay loops over the Historical API.
 *
 * - `iterDays`     yield session-close ET timestamps for each trading day
 * - `iterMinutes`  yield ET wall-clock minute timestamps inside RTH
 * - `replay`       walk an iterable of timestamps over any client method
 * - `Backtester`   collect strategy outputs across a date range
 *
 * Calendar handling is deliberately simple: NYSE trading days = weekdays
 * minus US market holidays. The Historical API itself returns `no_data` on
 * holidays, so `replay` defaults to skipping them silently.
 */

import { FlashAlphaHistorical, formatAt, AtLike } from './client';
import {
  InsufficientDataError,
  NoDataError,
  SymbolNotFoundError,
} from './errors';

// ── Calendar ─────────────────────────────────────────────────────────────────

/** Set of NYSE full-close holidays 2018-2026. Early-close days (1pm) are NOT
 * here — the API returns valid minute-level data up to the actual close. */
const FULL_CLOSE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2018
  '2018-01-01', '2018-01-15', '2018-02-19', '2018-03-30', '2018-05-28',
  '2018-07-04', '2018-09-03', '2018-11-22', '2018-12-05', '2018-12-25',
  // 2019
  '2019-01-01', '2019-01-21', '2019-02-18', '2019-04-19', '2019-05-27',
  '2019-07-04', '2019-09-02', '2019-11-28', '2019-12-25',
  // 2020
  '2020-01-01', '2020-01-20', '2020-02-17', '2020-04-10', '2020-05-25',
  '2020-07-03', '2020-09-07', '2020-11-26', '2020-12-25',
  // 2021
  '2021-01-01', '2021-01-18', '2021-02-15', '2021-04-02', '2021-05-31',
  '2021-07-05', '2021-09-06', '2021-11-25', '2021-12-24',
  // 2022
  '2022-01-17', '2022-02-21', '2022-04-15', '2022-05-30', '2022-06-20',
  '2022-07-04', '2022-09-05', '2022-11-24', '2022-12-26',
  // 2023
  '2023-01-02', '2023-01-16', '2023-02-20', '2023-04-07', '2023-05-29',
  '2023-06-19', '2023-07-04', '2023-09-04', '2023-11-23', '2023-12-25',
  // 2024
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27',
  '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  // 2025
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27',
  '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
]);

const _pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** Format a Date in YYYY-MM-DD using its local clock (ET wall-clock convention). */
function _fmtDate(d: Date): string {
  return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
}

function _coerceDate(d: string | Date): Date {
  if (d instanceof Date) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  // 'YYYY-MM-DD' → local date (no UTC shift)
  const [y, m, day] = d.split('-').map((s) => parseInt(s, 10));
  return new Date(y, (m ?? 1) - 1, day ?? 1);
}

export function isTradingDay(d: Date | string): boolean {
  const date = _coerceDate(d);
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  return !FULL_CLOSE_HOLIDAYS.has(_fmtDate(date));
}

export interface IterDaysOptions {
  /** Hour of day for the close stamp. Default 16. */
  closeHour?: number;
  /** Minute of close stamp. Default 0. */
  closeMinute?: number;
  /** Override the default holiday calendar. */
  tradeDays?: Iterable<string | Date>;
}

/**
 * Yield one Date per trading day in `[start, end]` inclusive, stamped at
 * `closeHour:closeMinute` (default 16:00 ET).
 */
export function* iterDays(
  start: string | Date,
  end: string | Date,
  options: IterDaysOptions = {},
): Generator<Date> {
  const closeHour = options.closeHour ?? 16;
  const closeMinute = options.closeMinute ?? 0;
  const startD = _coerceDate(start);
  const endD = _coerceDate(end);

  let candidates: Date[];
  if (options.tradeDays !== undefined) {
    const seen = new Set<string>();
    candidates = [];
    for (const td of options.tradeDays) {
      const d = _coerceDate(td);
      const key = _fmtDate(d);
      if (d >= startD && d <= endD && !seen.has(key)) {
        seen.add(key);
        candidates.push(d);
      }
    }
    candidates.sort((a, b) => a.getTime() - b.getTime());
  } else {
    candidates = [];
    for (
      let d = new Date(startD);
      d <= endD;
      d.setDate(d.getDate() + 1)
    ) {
      if (isTradingDay(d)) {
        candidates.push(new Date(d));
      }
    }
  }

  for (const d of candidates) {
    yield new Date(d.getFullYear(), d.getMonth(), d.getDate(), closeHour, closeMinute);
  }
}

export interface IterMinutesOptions extends IterDaysOptions {
  /** Open hour. Default 9. */
  openHour?: number;
  /** Open minute. Default 30. */
  openMinute?: number;
  /** Step between yielded minutes. Default 1. */
  stepMinutes?: number;
}

/**
 * Yield ET wall-clock minute timestamps inside RTH for every trading day
 * in `[start, end]`. Default cadence is 1 minute (390 stamps/day) — coarsen
 * with `stepMinutes` to avoid burning quota.
 */
export function* iterMinutes(
  start: string | Date,
  end: string | Date,
  options: IterMinutesOptions = {},
): Generator<Date> {
  const stepMinutes = options.stepMinutes ?? 1;
  if (stepMinutes <= 0) {
    throw new Error('stepMinutes must be positive');
  }
  const openHour = options.openHour ?? 9;
  const openMinute = options.openMinute ?? 30;
  const closeHour = options.closeHour ?? 16;
  const closeMinute = options.closeMinute ?? 0;

  for (const dayClose of iterDays(start, end, {
    closeHour,
    closeMinute,
    tradeDays: options.tradeDays,
  })) {
    const y = dayClose.getFullYear();
    const m = dayClose.getMonth();
    const day = dayClose.getDate();
    const endStamp = new Date(y, m, day, closeHour, closeMinute);
    for (
      let cur = new Date(y, m, day, openHour, openMinute);
      cur <= endStamp;
      cur = new Date(cur.getTime() + stepMinutes * 60_000)
    ) {
      yield new Date(cur);
    }
  }
}

// ── Replay ───────────────────────────────────────────────────────────────────

const AT_METHODS: ReadonlySet<string> = new Set([
  'stockQuote',
  'optionQuote',
  'surface',
  'gex',
  'dex',
  'vex',
  'chex',
  'exposureSummary',
  'exposureLevels',
  'narrative',
  'zeroDte',
  'maxPain',
  'stockSummary',
  'volatility',
  'advVolatility',
  'vrp',
]);

export interface ReplayResult<T = unknown> {
  /** ET wall-clock string formatted from the iterator value. */
  at: string;
  /** API response. */
  response: T;
}

export interface ReplayOptions {
  /** Skip 404-class errors (no_data / symbol_not_found / insufficient_data). Default true. */
  skipMissing?: boolean;
  /** Hook invoked when `skipMissing` swallows an error. */
  onError?: (at: AtLike, exc: unknown) => void;
  /** Extra options forwarded to the endpoint method (after `at`). */
  methodOptions?: Record<string, string | number | undefined>;
}

/**
 * Replay one endpoint across an iterable of timestamps. Yields async — the
 * generator awaits each call before yielding, so quota / rate limits flow
 * through naturally.
 *
 * @example
 * for await (const { at, response } of replay(hx, 'exposureSummary', 'SPY',
 *     iterDays('2024-01-02', '2024-01-31'))) {
 *   console.log(at, response.regime);
 * }
 */
export async function* replay<T = unknown>(
  client: FlashAlphaHistorical,
  method: string,
  symbol: string,
  timestamps: Iterable<AtLike> | AsyncIterable<AtLike>,
  options: ReplayOptions = {},
): AsyncGenerator<ReplayResult<T>> {
  if (!AT_METHODS.has(method)) {
    throw new Error(
      `replay() expects a method that takes \`at\`. Got '${method}'. Allowed: ${[
        ...AT_METHODS,
      ].join(', ')}`,
    );
  }

  const skipMissing = options.skipMissing ?? true;
  const fn = (client as unknown as Record<string, Function>)[method];
  if (typeof fn !== 'function') {
    throw new Error(`client.${method} is not a function`);
  }

  for await (const ts of timestamps as AsyncIterable<AtLike>) {
    const at = formatAt(ts);
    try {
      const response = (await fn.call(client, symbol, {
        at: ts,
        ...(options.methodOptions ?? {}),
      })) as T;
      yield { at, response };
    } catch (exc) {
      if (
        skipMissing &&
        (exc instanceof NoDataError ||
          exc instanceof SymbolNotFoundError ||
          exc instanceof InsufficientDataError)
      ) {
        if (options.onError) options.onError(ts, exc);
        continue;
      }
      throw exc;
    }
  }
}

// ── Backtester ───────────────────────────────────────────────────────────────

export interface BacktestStep<T = unknown, O = unknown> {
  at: string;
  snapshot: T;
  output: O;
}

export type Strategy<T = unknown, O = unknown> = (
  at: string,
  snapshot: T,
) => O | Promise<O>;

export interface BacktesterOptions {
  /** Endpoint to pull each step. Default `'stockSummary'`. */
  method?: string;
  /** Symbol passed to the endpoint. Default `'SPY'`. */
  symbol?: string;
  /** Whether to swallow 404-class data gaps. Default true. */
  skipMissing?: boolean;
  /** Forwarded to the endpoint method on each call. */
  methodOptions?: Record<string, string | number | undefined>;
}

/**
 * Run a strategy callback against the historical API across a date range.
 * No fill simulation, no portfolio accounting — that belongs in user code.
 *
 * @example
 * const bt = new Backtester(hx, { method: 'stockSummary', symbol: 'SPY' });
 * const results = await bt.run(
 *   iterDays('2024-01-02', '2024-03-29'),
 *   (at, snap) => ({ vrp: (snap as any).volatility.vrp }),
 * );
 */
export class Backtester {
  constructor(
    public readonly client: FlashAlphaHistorical,
    public readonly options: BacktesterOptions = {},
  ) {}

  async run<T = unknown, O = unknown>(
    timestamps: Iterable<AtLike> | AsyncIterable<AtLike>,
    strategy: Strategy<T, O>,
    onError?: (at: AtLike, exc: unknown) => void,
  ): Promise<BacktestStep<T, O>[]> {
    const results: BacktestStep<T, O>[] = [];
    const method = this.options.method ?? 'stockSummary';
    const symbol = this.options.symbol ?? 'SPY';
    const skipMissing = this.options.skipMissing ?? true;
    for await (const { at, response } of replay<T>(
      this.client,
      method,
      symbol,
      timestamps,
      {
        skipMissing,
        onError,
        methodOptions: this.options.methodOptions,
      },
    )) {
      const output = await strategy(at, response);
      results.push({ at, snapshot: response, output });
    }
    return results;
  }

  /**
   * Flatten results to plain rows — pulls a few common fields out of the
   * snapshot for convenience and merges in `output` (if it's a plain object).
   */
  toRecords<T = any, O = any>(
    results: BacktestStep<T, O>[],
  ): Record<string, unknown>[] {
    return results.map((r) => {
      const row: Record<string, unknown> = { at: r.at };
      const snap = (r.snapshot ?? {}) as Record<string, any>;
      if (snap.underlying_price !== undefined) {
        row['underlying_price'] = snap.underlying_price;
      } else if (snap.price && typeof snap.price === 'object') {
        row['underlying_price'] = snap.price.mid;
      }
      if (typeof snap.regime === 'string') row['regime'] = snap.regime;
      if (snap.gamma_flip !== undefined) row['gamma_flip'] = snap.gamma_flip;
      if (snap.exposures && typeof snap.exposures === 'object') {
        row['net_gex'] = snap.exposures.net_gex;
        row['net_dex'] = snap.exposures.net_dex;
      }
      if (snap.vrp && typeof snap.vrp === 'object') {
        row['vrp_20d'] = snap.vrp.vrp_20d;
        row['vrp_z'] = snap.vrp.z_score;
      }
      if (r.output && typeof r.output === 'object' && !Array.isArray(r.output)) {
        for (const [k, v] of Object.entries(r.output as Record<string, unknown>)) {
          if (!(k in row)) row[k] = v;
        }
      } else {
        row['output'] = r.output;
      }
      return row;
    });
  }
}
