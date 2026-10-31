# FlashAlpha options backtester (JavaScript)

A single-file backtester for the FlashAlpha Historical API. It replays the API day by day, decides entries and exits
from FlashAlpha signals, fills trades on historical bid/ask quotes, and writes `trades.csv` and `equity.csv`.
It is a port of `flashalpha_backtest.py` and produces the same files, row for row.

Guide: [How to Backtest Options Strategies in Python](https://flashalpha.com/articles/how-to-backtest-options-strategies-python-flashalpha-historical-api).
The reference version is the [Python backtester](https://github.com/FlashAlpha-lab/flashalpha-historical-python/tree/main/examples/backtester).

## Requirements

- Node.js 18 or later. No npm packages.
- A FlashAlpha Alpha plan or higher (Historical API access).

## Run a backtest

```sh
export FLASHALPHA_API_KEY=your_key
node flashalpha_backtest.mjs --symbol SPY --start 2024-01-02 --end 2024-06-28
```

On Windows PowerShell, set the key with `$env:FLASHALPHA_API_KEY = "your_key"`.

The run prints a summary and writes `results/trades.csv` and `results/equity.csv`. To see every flag and its
default, run `node flashalpha_backtest.mjs --help`. Common flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--symbol` | `SPY` | Underlying to trade |
| `--start`, `--end` | `2024-01-02`, `2024-06-28` | Date range, inclusive |
| `--max-positions` | `1` | Open positions allowed at once |
| `--short-delta`, `--width` | `0.2`, `5` | Short put delta and spread width in points |
| `--profit-target`, `--stop-loss`, `--exit-dte` | `0.5`, `2`, `21` | Exit settings |
| `--out` | `results` | Folder for the CSV files |
| `--cache` | `.fa_cache` | Folder for cached API responses |

Every API response is saved in `.fa_cache/`, so a rerun with changed rules makes no API calls for days already
fetched. The cache file names match the Python version, so both versions can share one cache folder.

## Change the strategy

Edit the three functions in the section marked `STRATEGY: edit these three functions` in
`flashalpha_backtest.mjs`:

- `entryRules(snap, history, cfg)`: return `true` to open a position at this decision time.
- `selectLegs(chain, snap, cfg)`: return the contracts to trade as `{type, strike, expiry, side}` objects.
- `exitRules(pos, snap, history, cfg)`: return a reason string to close a position, or `null` to hold.

To give the rules more data, add fields to `buildSnapshot()`. Settings and their defaults are in the `Config` class.

## Run the tests

The tests replace the API with canned data, so they need no key and no network:

```sh
node --test flashalpha_backtest.test.mjs
```
