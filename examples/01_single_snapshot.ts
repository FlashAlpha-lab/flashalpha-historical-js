/**
 * Example 1 — pull a single point-in-time snapshot.
 *
 * Run with:  FLASHALPHA_API_KEY=... npx ts-node examples/01_single_snapshot.ts
 */
import { FlashAlphaHistorical } from '../src';

async function main() {
  const hx = new FlashAlphaHistorical(process.env.FLASHALPHA_API_KEY!);

  const snap = (await hx.exposureSummary('SPY', {
    at: '2020-03-16T15:30:00',
  })) as {
    as_of: string;
    underlying_price: number;
    regime: string;
    gamma_flip: number;
    exposures: { net_gex: number; net_dex: number; net_vex: number };
    interpretation: Record<string, string>;
  };

  console.log(`SPY @ ${snap.as_of}`);
  console.log(`  spot:        ${snap.underlying_price}`);
  console.log(`  regime:      ${snap.regime}`);
  console.log(`  net GEX:     $${snap.exposures.net_gex.toLocaleString()}`);
  console.log(`  net DEX:     $${snap.exposures.net_dex.toLocaleString()}`);
  console.log(`  gamma flip:  ${snap.gamma_flip}`);
  for (const [k, v] of Object.entries(snap.interpretation)) {
    console.log(`  ${k}: ${v}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
