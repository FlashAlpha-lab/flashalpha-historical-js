/**
 * Replay sell-window for one session. The backtests entered at 09:35 ET, so T09:35:00
 * returns the backtest's entry strikes.
 *
 * Run:  FLASHALPHA_API_KEY=... npx ts-node examples/sell-window-replay.ts SPY 2026-10-16
 * Docs: https://flashalpha.com/docs/historical-sell-window
 */

import { FlashAlphaHistorical } from '../src';

async function main(): Promise<void> {
  const hx = new FlashAlphaHistorical(process.env.FLASHALPHA_API_KEY ?? '');
  const symbol = process.argv[2] ?? 'SPY';
  const session = process.argv[3] ?? '2026-10-16';
  const answer = await hx.sellWindow(symbol, { at: `${session}T09:35:00` });

  for (const window of answer.windows ?? []) {
    console.log(`${window.expiry ?? 'no listed expiry'}: ${window.action}`);
    for (const trade of window.candidates ?? []) {
      console.log(`  ${trade.structure}, mid credit ${trade.mid_credit}, exit: ${trade.exit}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
