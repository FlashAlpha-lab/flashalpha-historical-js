#!/usr/bin/env node
/**
 * FlashAlpha options backtester: a complete, runnable template (JavaScript port of flashalpha_backtest.py).
 *
 * Replays the FlashAlpha Historical API day by day, decides entries and exits from the same endpoint outputs you
 * would read live, fills trades on real historical bid/ask quotes, and writes trades.csv and equity.csv.
 *
 * Edit the three marked functions to change the strategy:
 *     entryRules()  - when to open a position (reads FlashAlpha signals)
 *     selectLegs()  - which option contracts to trade (reads the option chain)
 *     exitRules()   - when to close (reads the position's marks and FlashAlpha signals)
 *
 * Requirements: Node.js 18+, no npm packages. An Alpha plan or higher (Historical API).
 *
 *     export FLASHALPHA_API_KEY=your_key
 *     node flashalpha_backtest.mjs --symbol SPY --start 2024-01-02 --end 2024-06-28
 *
 * Every API response is cached in .fa_cache/, so a rerun with changed rules costs no API calls for days already
 * fetched. The cache file names match the Python version, so both versions can share one cache folder.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BASE_URL = "https://historical.flashalpha.com";

// ============================================================================================================
// Settings
// ============================================================================================================
export class Config {
  symbol = "SPY";
  start = "2024-01-02";
  end = "2024-06-28";
  decisionTime = "15:45"; // ET; every decision and fill uses quotes at this minute
  // Trade selection (a put credit spread by default)
  targetDte = 35;         // pick the expiry closest to this many calendar days out...
  minDte = 25;            // ...within this window
  maxDte = 50;
  shortDelta = 0.2;       // sell the put closest to this absolute delta
  width = 5.0;            // buy the put this many points lower
  contracts = 1;
  maxPositions = 1;       // open positions allowed at once
  // Exits
  profitTarget = 0.5;     // close when 50% of the entry credit is captured
  stopLoss = 2.0;         // close when the loss reaches 2x the entry credit
  exitDte = 21;           // close with this many calendar days left
  // Costs
  slippage = 0.5;         // 0 = fill at mid, 1 = fill at the bid or ask, 0.5 = halfway
  commission = 0.65;      // per contract per leg, each side

  constructor(overrides = {}) {
    Object.assign(this, overrides);
  }
}

// Settings that take whole numbers on the command line. The other numeric settings accept decimals.
const INTEGER_SETTINGS = new Set(["targetDte", "minDte", "maxDte", "contracts", "maxPositions", "exitDte"]);

// ============================================================================================================
// FlashAlpha data: a small cached client for the Historical API
// ============================================================================================================
export class FlashAlphaError extends Error {}

export class FlashAlphaData {
  constructor(apiKey, cacheDir = ".fa_cache", baseUrl = BASE_URL) {
    if (!apiKey) throw new FlashAlphaError("Set FLASHALPHA_API_KEY (Alpha plan or higher).");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.cache = cacheDir;
    fs.mkdirSync(this.cache, { recursive: true });
    this.calls = 0;
  }

  /** GET with a disk cache. Returns parsed JSON, or null when the API has no data (404). */
  async get(urlPath, params = {}) {
    params = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined));
    const hit = path.join(this.cache, `${cacheKey(urlPath, params)}.json`);
    if (fs.existsSync(hit)) return JSON.parse(fs.readFileSync(hit, "utf8"));

    const url = `${this.baseUrl}${urlPath}?${new URLSearchParams(params)}`;
    let body = null;
    for (let attempt = 0; attempt < 5 && body === null; attempt++) {
      let r, text;
      try {
        r = await fetch(url, { headers: { "X-Api-Key": this.apiKey }, signal: AbortSignal.timeout(60_000) });
        text = await r.text();
      } catch (err) {
        if (!isConnectionError(err)) throw err;
        await sleep(2 ** attempt); // connection error or timeout: wait 1, 2, 4, 8, 16 s and try again
        continue;
      }
      this.calls += 1;
      if (r.status === 200) {
        JSON.parse(text); // fail here, before caching, if the body is not JSON
        body = text;
      } else if (r.status === 404) {
        body = "null";
      } else if ([429, 500, 502, 503, 504].includes(r.status)) {
        const wait = r.headers.get("Retry-After") ?? ""; // whole seconds; anything else (an HTTP date) uses 2^attempt
        await sleep(/^\d+$/.test(wait) ? Number(wait) : 2 ** attempt);
      } else {
        throw new FlashAlphaError(`FlashAlpha API error ${r.status} on ${urlPath}: ${text.slice(0, 200)}`);
      }
    }
    if (body === null) throw new FlashAlphaError(`FlashAlpha API kept failing on ${urlPath}`);
    fs.writeFileSync(hit, body);
    return JSON.parse(body);
  }

  stockQuote(symbol, at) {
    return this.get(`/v1/stockquote/${symbol}`, { at });
  }

  exposureSummary(symbol, at) {
    return this.get(`/v1/exposure/summary/${symbol}`, { at });
  }

  vrp(symbol, at) {
    return this.get(`/v1/vrp/${symbol}`, { at });
  }

  async chain(symbol, at, expiry) {
    return (await this.get(`/v1/optionquote/${symbol}`, { at, expiry })) || [];
  }

  option(symbol, at, expiry, strike, optType) {
    return this.get(`/v1/optionquote/${symbol}`, { at, expiry, strike: strikeText(strike), type: optType });
  }
}

/** fetch() failures worth retrying: the connection failed or the 60 s timeout fired. */
function isConnectionError(err) {
  return err instanceof TypeError || err?.name === "TimeoutError" || err?.name === "AbortError";
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** Strike as the API and the trade log write it: 512 -> "512", 517.5 -> "517.5", 21012.25 -> "21012.25". */
export function strikeText(strike) {
  return formatG(strike, 10);
}

/** Cache file name: SHA-1 of the same text Python's json.dumps([path, sorted(params.items())]) produces. */
function cacheKey(urlPath, params) {
  const items = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `[${JSON.stringify(k)}, ${JSON.stringify(v)}]`);
  const text = `[${JSON.stringify(urlPath)}, [${items.join(", ")}]]`;
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Everything the rules can read for one decision time, as one flat object. Returns null on a non-trading day.
 *
 * Add fields from any other FlashAlpha endpoint here (exposure levels, narrative, max pain, 0DTE, surface...).
 */
export async function buildSnapshot(fa, symbol, at) {
  const quote = await fa.stockQuote(symbol, at);
  if (!quote || !String(quote.lastUpdate ?? "").startsWith(at.slice(0, 10))) {
    return null; // weekend or market holiday: the archive returned an earlier session's quote
  }
  const ex = (await fa.exposureSummary(symbol, at)) || {};
  const v = (await fa.vrp(symbol, at)) || {};
  const core = v.vrp || {};
  return {
    date: at.slice(0, 10),
    at,
    spot: quote.mid,
    // /v1/exposure/summary
    gammaRegime: ex.regime ?? null,                         // "positive_gamma" or "negative_gamma"
    netGex: (ex.exposures || {}).net_gex ?? null,
    gammaFlip: ex.gamma_flip ?? null,
    // /v1/vrp
    atmIv: core.atm_iv ?? null,                             // vol points
    rv20d: core.rv_20d ?? null,
    vrp20d: core.vrp_20d ?? null,                           // implied minus 20-day realized, vol points
    vrpPercentile: core.percentile ?? null,
    vrpZ: core.z_score ?? null,
    harvestScore: (v.gex_conditioned || {}).harvest_score ?? null,
  };
}

// ============================================================================================================
// STRATEGY: edit these three functions
// ============================================================================================================

/**
 * ENTRY RULES. Return true to open a position at this decision time.
 *
 * snap is today's snapshot (see buildSnapshot); history holds the earlier sessions' snapshots, oldest first.
 * Default: implied vol above 20-day realized (VRP > 0) and dealers long gamma for 2 sessions running.
 */
export function entryRules(snap, history, cfg) {
  const gammaStreak = [...history.slice(-1), snap].map((s) => s.gammaRegime);
  return (
    snap.vrp20d != null && snap.vrp20d > 0
    && gammaStreak.length === 2 && gammaStreak.every((g) => g === "positive_gamma")
  );
}

/**
 * WHICH CONTRACTS. Return legs as objects {type, strike, expiry, side}, side -1 = sell, +1 = buy.
 *
 * Default: put credit spread - sell the put closest to cfg.shortDelta, buy the put cfg.width points lower.
 */
export function selectLegs(chain, snap, cfg) {
  const puts = chain.filter((o) => o.type === "P" && o.delta != null && (o.bid ?? 0) > 0);
  if (puts.length === 0) return null;
  const short = minBy(puts, (o) => Math.abs(Math.abs(o.delta) - cfg.shortDelta));
  const lower = puts.filter((o) => o.strike <= short.strike - cfg.width);
  if (lower.length === 0) return null;
  const long = maxBy(lower, (o) => o.strike);
  return [
    { type: "P", strike: short.strike, expiry: short.expiry, side: -1 },
    { type: "P", strike: long.strike, expiry: long.expiry, side: +1 },
  ];
}

/**
 * EXIT RULES. Return a reason string to close the position at this decision time, or null to hold.
 *
 * pos.pnlMid is the open profit of the whole position in dollars at mid. pos.credit is the net premium taken in,
 * after commission: positive for a credit, negative for a debit, so the targets below use its size.
 * Default: take 50% of the credit, stop at 2x the credit, close at 21 days left, or close after 2 sessions
 * of negative dealer gamma.
 */
export function exitRules(pos, snap, history, cfg) {
  if (pos.pnlMid >= cfg.profitTarget * Math.abs(pos.credit)) return "profit_target";
  if (pos.pnlMid <= -cfg.stopLoss * Math.abs(pos.credit)) return "stop_loss";
  if (pos.dte(snap.date) <= cfg.exitDte) return "time_exit";
  if (history.length > 0 && history.at(-1).gammaRegime === "negative_gamma" && snap.gammaRegime === "negative_gamma") {
    return "negative_gamma_2_sessions";
  }
  return null;
}

// ============================================================================================================
// Engine (no changes needed below to run a new strategy)
// ============================================================================================================
export class Position {
  constructor({ legs, entryDate, credit, marks = {}, pnlMid = 0 }) {
    this.legs = legs;
    this.entryDate = entryDate;
    this.credit = credit; // net premium for the whole position in dollars after commission (negative = debit)
    this.marks = marks;   // last quote per leg, keyed by leg index
    this.pnlMid = pnlMid;
  }

  get expiry() {
    return this.legs.map((leg) => leg.expiry).sort()[0];
  }

  dte(date) {
    return daysBetween(date, this.expiry);
  }
}

/** Price for buying (side +1) or selling (side -1) one contract: mid moved toward the ask or bid. */
export function fillPrice(quote, side, slippage) {
  const mid = (quote.bid + quote.ask) / 2;
  return side > 0 ? mid + slippage * (quote.ask - mid) : mid - slippage * (mid - quote.bid);
}

/** Expiry closest to cfg.targetDte inside [minDte, maxDte] that has a chain (Friday, else Thursday). */
export async function findExpiry(fa, symbol, at, cfg) {
  const today = at.slice(0, 10);
  const fridays = [];
  for (let d = cfg.minDte; d <= cfg.maxDte; d++) {
    if (weekday(addDays(today, d)) === 4) fridays.push(addDays(today, d));
  }
  fridays.sort((a, b) => Math.abs(daysBetween(today, a) - cfg.targetDte) - Math.abs(daysBetween(today, b) - cfg.targetDte));
  for (const friday of fridays) {
    for (const day of [friday, addDays(friday, -1)]) { // Thursday when the Friday is a holiday
      const chain = await fa.chain(symbol, at, day);
      if (chain.length > 0) return [day, chain];
    }
  }
  return null;
}

export function* tradingDays(start, end) {
  for (let day = start; day <= end; day = addDays(day, 1)) {
    if (weekday(day) < 5) yield day;
  }
}

export async function run(cfg, fa, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const openPositions = [];
  const trades = [];
  const equity = [];
  const history = [];
  let realized = 0;
  for (const date of tradingDays(cfg.start, cfg.end)) {
    const at = `${date}T${cfg.decisionTime}:00`;
    const snap = await buildSnapshot(fa, cfg.symbol, at);
    if (snap === null) continue;

    // 1. Mark and exit open positions
    for (const pos of [...openPositions]) {
      let valueMid = 0;
      const onExpiry = pos.dte(date) <= 0; // expiry day, or the first session after it when that day had no data
      for (const [i, leg] of pos.legs.entries()) {
        const q = onExpiry ? null : await fa.option(cfg.symbol, at, leg.expiry, leg.strike, leg.type);
        if (q && q.bid != null && q.ask != null && q.ask > 0) pos.marks[i] = q;
        const mid = (pos.marks[i].bid + pos.marks[i].ask) / 2;
        valueMid += leg.side * mid * 100 * cfg.contracts;
      }
      pos.pnlMid = pos.credit + valueMid; // credit received plus the (negative) value of what we hold
      const reason = onExpiry ? "expiry" : exitRules(pos, snap, history, cfg);
      if (reason) {
        let closeValue;
        if (onExpiry) { // settle at intrinsic value against the spot at the decision time
          closeValue = sum(pos.legs.map((leg) => leg.side * Math.max(0, leg.type === "P"
            ? leg.strike - snap.spot : snap.spot - leg.strike)));
        } else {
          closeValue = sum(pos.legs.map((leg, i) => leg.side * fillPrice(pos.marks[i], -leg.side, cfg.slippage)));
        }
        const costs = onExpiry ? 0 : cfg.commission * pos.legs.length * cfg.contracts;
        const pnl = pos.credit + closeValue * 100 * cfg.contracts - costs;
        realized += pnl;
        openPositions.splice(openPositions.indexOf(pos), 1);
        trades.push({
          entry_date: pos.entryDate,
          exit_date: date,
          expiry: pos.expiry,
          legs: pos.legs.map((l) => `${l.side > 0 ? "+" : "-"}${l.type}${strikeText(l.strike)}`).join(" "),
          credit: pyRound(pos.credit, 2),
          pnl: pyRound(pnl, 2),
          exit_reason: reason,
          days_held: daysBetween(pos.entryDate, date),
        });
      }
    }

    // 2. Entries
    if (openPositions.length < cfg.maxPositions && entryRules(snap, history, cfg)) {
      const found = await findExpiry(fa, cfg.symbol, at, cfg);
      const legs = found ? selectLegs(found[1], snap, cfg) : null;
      if (legs) {
        const contractKey = (o) => `${o.type}|${o.strike}|${o.expiry}`;
        const byKey = new Map(found[1].map((o) => [contractKey(o), o]));
        const missing = legs.filter((leg) => !byKey.has(contractKey(leg)));
        if (missing.length > 0) {
          throw new Error(`select_legs must pick contracts from the chain it receives: ${JSON.stringify(missing)}`);
        }
        const quotes = legs.map((leg) => byKey.get(contractKey(leg)));
        const openValue = sum(legs.map((leg, i) => leg.side * fillPrice(quotes[i], leg.side, cfg.slippage)));
        const credit = -openValue * 100 * cfg.contracts - cfg.commission * legs.length * cfg.contracts;
        const pos = new Position({ legs, entryDate: date, credit, marks: { ...quotes } });
        pos.pnlMid = credit + sum(legs.map((leg, i) => leg.side * (quotes[i].bid + quotes[i].ask) / 2))
          * 100 * cfg.contracts;
        openPositions.push(pos);
      }
    }

    const unrealized = sum(openPositions.map((p) => p.pnlMid));
    equity.push({
      date,
      realized: pyRound(realized, 2),
      unrealized: pyRound(unrealized, 2),
      equity: pyRound(realized + unrealized, 2),
      open_positions: openPositions.length,
      gamma_regime: snap.gammaRegime,
      vrp_20d: snap.vrp20d,
    });
    history.push(snap);
  }

  writeCsv(path.join(outDir, "trades.csv"), trades);
  writeCsv(path.join(outDir, "equity.csv"), equity);
  return summarize(trades, equity);
}

// Columns the Python version writes as floats, so 0 is written "0.0" in both versions.
const FLOAT_COLUMNS = new Set(["credit", "pnl", "realized", "unrealized", "equity"]);

export function writeCsv(file, rows) {
  if (rows.length === 0) {
    fs.writeFileSync(file, "");
    return;
  }
  const columns = Object.keys(rows[0]);
  const cell = (key, value) => {
    const text = value == null ? "" : FLOAT_COLUMNS.has(key) ? pyFloatText(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(","), ...rows.map((row) => columns.map((c) => cell(c, row[c])).join(","))];
  fs.writeFileSync(file, lines.map((line) => line + "\r\n").join("")); // same CRLF line ends as Python's csv module
}

export function summarize(trades, equity) {
  const pnls = trades.map((t) => t.pnl);
  const curve = equity.map((e) => e.equity);
  const daily = curve.map((v, i) => v - (i === 0 ? 0 : curve[i - 1]));
  let sd = 0;
  if (daily.length > 1) {
    const mean = sum(daily) / daily.length;
    sd = Math.sqrt(sum(daily.map((x) => (x - mean) * (x - mean))) / (daily.length - 1));
  }
  let peak = 0;
  let maxDd = 0;
  for (const v of curve) {
    peak = Math.max(peak, v);
    maxDd = Math.max(maxDd, peak - v);
  }
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0); // break-even trades count as losses
  const reasons = {};
  for (const t of trades) reasons[t.exit_reason] = (reasons[t.exit_reason] ?? 0) + 1;
  return {
    sessions: equity.length,
    trades: trades.length,
    win_rate: pnls.length ? pyRound(wins.length / pnls.length, 3) : null,
    total_pnl: pyRound(sum(pnls), 2),
    avg_win: wins.length ? pyRound(sum(wins) / wins.length, 2) : null,
    avg_loss: losses.length ? pyRound(sum(losses) / losses.length, 2) : null,
    max_drawdown: pyRound(maxDd, 2),
    sharpe: sd > 0 ? pyRound((sum(daily) / daily.length / sd) * Math.sqrt(252), 2) : null,
    exit_reasons: reasons,
    open_at_end: equity.length ? equity.at(-1).open_positions : 0,
  };
}

// ============================================================================================================
// Helpers: dates, and number handling that matches Python to the last digit
// ============================================================================================================
const DAY_MS = 86_400_000;

/** Calendar days from date a to date b (both "YYYY-MM-DD"). */
function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
}

function addDays(date, days) {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Monday = 0 ... Sunday = 6, like Python's date.weekday(). */
function weekday(date) {
  return (new Date(Date.parse(date)).getUTCDay() + 6) % 7;
}

/** First item with the smallest key, like Python's min(items, key=...). */
function minBy(items, key) {
  return items.reduce((best, item) => (key(item) < key(best) ? item : best));
}

/** First item with the largest key, like Python's max(items, key=...). */
function maxBy(items, key) {
  return items.reduce((best, item) => (key(item) > key(best) ? item : best));
}

/** Sum of numbers with compensated (Neumaier) summation, the algorithm Python's built-in sum() uses since 3.12. */
function sum(values) {
  let total = 0;
  let compensation = 0;
  for (const x of values) {
    const t = total + x;
    compensation += Math.abs(total) >= Math.abs(x) ? (total - t) + x : (x - t) + total;
    total = t;
  }
  return compensation && Number.isFinite(compensation) ? total + compensation : total;
}

/** Python's round(x, digits): rounds the exact binary value, and exact halves go to the even digit. */
function pyRound(x, digits) {
  if (!Number.isFinite(x) || x === 0) return x;
  const fraction = Math.abs(x).toFixed(100).split(".")[1]; // exact decimal expansion
  const exactHalf = fraction[digits] === "5" && /^0*$/.test(fraction.slice(digits + 1));
  if (!exactHalf) return Number(x.toFixed(digits)); // toFixed rounds the exact value correctly when it is not a tie
  const scale = 10 ** digits;
  const below = Math.floor(Math.abs(x) * scale);
  return (Math.sign(x) * (below % 2 === 0 ? below : below + 1)) / scale;
}

/** A number as Python's str(float) writes it: 0 -> "0.0", 50.7 -> "50.7". */
function pyFloatText(x) {
  if (Object.is(x, -0)) return "-0.0";
  return Number.isInteger(x) && Math.abs(x) < 1e16 ? x.toFixed(1) : String(x);
}

/** Python's format(x, ".<precision>g"): that many significant digits, trailing zeros removed. */
function formatG(x, precision) {
  const stripZeros = (s) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
  const [mantissa, expText] = x.toExponential(precision - 1).split("e");
  const exp = Number(expText);
  if (exp >= -4 && exp < precision) return stripZeros(x.toFixed(precision - 1 - exp));
  return `${stripZeros(mantissa)}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

// Summary values the Python version prints as floats (1.0, 0.0), so the printed JSON is the same text.
const SUMMARY_FLOATS = ["win_rate", "total_pnl", "avg_win", "avg_loss", "max_drawdown", "sharpe"];

/** The summary as Python's json.dumps(summary, indent=2) prints it. */
export function summaryText(summary) {
  const wholeFloat = new RegExp(`^(\\s*"(?:${SUMMARY_FLOATS.join("|")})": -?\\d+)(,?)$`, "gm");
  return JSON.stringify(summary, null, 2).replace(wholeFloat, "$1.0$2");
}

// ============================================================================================================
// Command line
// ============================================================================================================
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function usage(defaults) {
  const flags = Object.entries(defaults).map(([name, value]) => `  --${kebab(name)} ${value}`);
  return ["usage: node flashalpha_backtest.mjs [--flag value ...]", "", "FlashAlpha options backtester. Flags and defaults:",
    ...flags, "  --out results", "  --cache .fa_cache"].join("\n");
}

function parseArgs(argv) {
  const defaults = { ...new Config() };
  const flags = new Map([...Object.keys(defaults), "out", "cache"].map((name) => [`--${kebab(name)}`, name]));
  const values = { ...defaults, out: "results", cache: ".fa_cache" };
  const fail = (message) => {
    console.error(`${usage(defaults)}\n\nerror: ${message}`);
    process.exit(2);
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-h" || argv[i] === "--help") {
      console.log(usage(defaults));
      process.exit(0);
    }
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const name = flags.get(flag);
    if (!name) fail(`unrecognized argument: ${argv[i]}`);
    const text = inline ?? argv[++i];
    if (text === undefined) fail(`${flag} expects a value`);
    if (typeof defaults[name] !== "number") {
      values[name] = text;
    } else if (INTEGER_SETTINGS.has(name)) {
      if (!/^\s*[+-]?\d+\s*$/.test(text)) fail(`${flag}: invalid int value: '${text}'`);
      values[name] = Number(text);
    } else {
      if (text.trim() === "" || Number.isNaN(Number(text))) fail(`${flag}: invalid float value: '${text}'`);
      values[name] = Number(text);
    }
  }
  const { out, cache, ...settings } = values;
  return { cfg: new Config(settings), out, cache };
}

async function main() {
  const { cfg, out, cache } = parseArgs(process.argv.slice(2));
  const fa = new FlashAlphaData(process.env.FLASHALPHA_API_KEY ?? "", cache);
  const summary = await run(cfg, fa, out);
  console.log(summaryText(summary));
  console.log(`API calls this run: ${fa.calls}. Trades: ${path.join(out, "trades.csv")}. Equity: ${path.join(out, "equity.csv")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof FlashAlphaError ? err.message : err.stack);
    process.exit(1);
  });
}
