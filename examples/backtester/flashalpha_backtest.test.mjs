/**
 * Offline tests for flashalpha_backtest.mjs: a stub replaces the API, so no key or network is needed.
 *
 *     node --test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as bt from "./flashalpha_backtest.mjs";

/** Three sessions of canned API responses. The put spread opens on day 2 and hits the profit target on day 3. */
class StubData {
  constructor() {
    this.calls = 0;
    this.days = {
      "2024-03-04": ["positive_gamma", 2.0],
      "2024-03-05": ["positive_gamma", 2.0],
      "2024-03-06": ["positive_gamma", 2.0],
    };
    // Marks per date for the two legs: [bid, ask]
    this.marks = { "2024-03-06": { "P|490": [0.30, 0.34], "P|485": [0.10, 0.12] } };
  }

  async stockQuote(symbol, at) {
    if (!(at.slice(0, 10) in this.days)) {
      return { mid: 500.0, lastUpdate: "2024-02-29T16:00:00" }; // holiday: an earlier session's quote
    }
    return { mid: 500.0, lastUpdate: at };
  }

  async exposureSummary(symbol, at) {
    return { regime: this.days[at.slice(0, 10)][0], gamma_flip: 495.0, exposures: { net_gex: 1e9 } };
  }

  async vrp(symbol, at) {
    return {
      vrp: { vrp_20d: this.days[at.slice(0, 10)][1], atm_iv: 14.0, rv_20d: 12.0, percentile: 60, z_score: 0.5 },
      gex_conditioned: { harvest_score: 70 },
    };
  }

  async chain(symbol, at, expiry) {
    if (expiry !== "2024-04-05") return [];
    return [
      { type: "P", strike: 490.0, expiry, bid: 1.00, ask: 1.10, mid: 1.05, delta: -0.21 },
      { type: "P", strike: 485.0, expiry, bid: 0.40, ask: 0.46, mid: 0.43, delta: -0.12 },
      { type: "P", strike: 480.0, expiry, bid: 0.20, ask: 0.24, mid: 0.22, delta: -0.07 },
      { type: "C", strike: 510.0, expiry, bid: 1.00, ask: 1.10, mid: 1.05, delta: 0.20 },
    ];
  }

  async option(symbol, at, expiry, strike, optType) {
    const mark = this.marks[at.slice(0, 10)]?.[`${optType}|${Number(strike)}`];
    if (!mark) return null;
    const [bid, ask] = mark;
    return { bid, ask, mid: (bid + ask) / 2 };
  }
}

const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)),
  `${actual} is not approximately ${expected}`);

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fa-backtest-"));

/** Rows of a CSV file written by writeCsv, as objects keyed by the header. */
function readCsv(file) {
  const [header, ...lines] = fs.readFileSync(file, "utf8").split("\r\n").filter(Boolean);
  const columns = header.split(",");
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, i) => [columns[i], value])));
}

test("fill price moves from mid toward the far side", () => {
  const q = { bid: 1.00, ask: 1.20 };
  approx(bt.fillPrice(q, -1, 0.0), 1.10);
  approx(bt.fillPrice(q, -1, 1.0), 1.00);
  approx(bt.fillPrice(q, +1, 0.5), 1.15);
});

test("selectLegs builds a put credit spread", async () => {
  const cfg = new bt.Config();
  const legs = bt.selectLegs(await new StubData().chain("SPY", "2024-03-05T15:45:00", "2024-04-05"), {}, cfg);
  assert.deepEqual(legs.map((l) => [l.strike, l.side]), [[490.0, -1], [485.0, +1]]);
});

test("run opens and closes one trade with exact accounting", async () => {
  const dir = tmpDir();
  const cfg = new bt.Config({ start: "2024-03-04", end: "2024-03-06", minDte: 25, maxDte: 40, targetDte: 31 });
  const summary = await bt.run(cfg, new StubData(), dir);
  const trades = readCsv(path.join(dir, "trades.csv"));
  assert.equal(summary.trades, 1);
  assert.equal(trades.length, 1);
  const t = trades[0];
  // Entry on 03-05 (2 positive-gamma sessions, VRP > 0), halfway fills: sell 490 at 1.025, buy 485 at 0.445.
  // Credit = (1.025 - 0.445) * 100 - 2 legs * 0.65 = 56.70
  assert.equal(t.entry_date, "2024-03-05");
  approx(Number(t.credit), 56.70);
  // Day 3 mid value of the spread: 0.32 - 0.11 = 0.21 -> open profit 56.70 - 21 = 35.70 >= 50% of credit.
  // Close halfway: buy 490 at 0.33, sell 485 at 0.105 -> -22.50, less 1.30 commission: 56.70 - 22.50 - 1.30 = 32.90
  assert.equal(t.exit_reason, "profit_target");
  approx(Number(t.pnl), 32.90);
  assert.equal(t.legs, "-P490 +P485");
  assert.equal(t.expiry, "2024-04-05");
});

test("strikeText keeps every digit", () => {
  assert.deepEqual([512.0, 517.5, 21012.25].map(bt.strikeText), ["512", "517.5", "21012.25"]);
});

test("holidays are skipped", async () => {
  const cfg = new bt.Config({ start: "2024-03-01", end: "2024-03-04" }); // 03-01 returns an earlier quote, 03-02/03 are a weekend
  const summary = await bt.run(cfg, new StubData(), tmpDir());
  assert.equal(summary.sessions, 1);
});
