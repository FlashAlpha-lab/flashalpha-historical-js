/**
 * Example 2 — daily backtest of a VRP-harvest signal.
 *
 * Walks SPY day by day, pulls the full stock summary at session close, and
 * flags days where:
 *   1. variance risk premium (VRP) > 5 vol points
 *   2. dealers are long gamma (positive_gamma regime)
 *
 * Run with:  FLASHALPHA_API_KEY=... npx ts-node examples/02_daily_vrp_backtest.ts
 */
import { Backtester, FlashAlphaHistorical, iterDays } from '../src';

type Snap = {
  volatility: { vrp: number | null; atm_iv: number | null };
  exposure: { regime: string };
};

async function main() {
  const hx = new FlashAlphaHistorical(process.env.FLASHALPHA_API_KEY!);
  const bt = new Backtester(hx, { method: 'stockSummary', symbol: 'SPY' });

  const results = await bt.run<Snap, {
    fire: boolean;
    vrp: number | null;
    regime: string;
    atm_iv: number | null;
  }>(
    iterDays('2024-01-02', '2024-03-29'),
    (_at, snap) => {
      const vrp = snap.volatility.vrp;
      const regime = snap.exposure.regime;
      return {
        fire: vrp !== null && vrp > 5 && regime === 'positive_gamma',
        vrp,
        regime,
        atm_iv: snap.volatility.atm_iv,
      };
    },
  );

  const fires = results.filter((r) => r.output.fire);
  const regimeCounts = new Map<string, number>();
  for (const r of results) {
    regimeCounts.set(r.output.regime, (regimeCounts.get(r.output.regime) ?? 0) + 1);
  }

  console.log(`days replayed:   ${results.length}`);
  console.log(`signal fires:    ${fires.length}`);
  console.log('regime breakdown:');
  for (const [regime, n] of [...regimeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${regime.padStart(20)}: ${n}`);
  }
  console.log('');
  console.log('first fires:');
  for (const r of fires.slice(0, 10)) {
    console.log(`  ${r.at}  vrp=${r.output.vrp?.toFixed(2)}  iv=${r.output.atm_iv?.toFixed(2)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
