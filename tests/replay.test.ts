import {
  Backtester,
  BASE_URL,
  FlashAlphaHistorical,
  isTradingDay,
  iterDays,
  iterMinutes,
  replay,
} from '../src';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('isTradingDay', () => {
  it('rejects weekends', () => {
    expect(isTradingDay('2024-01-06')).toBe(false); // Sat
    expect(isTradingDay('2024-01-07')).toBe(false); // Sun
    expect(isTradingDay('2024-01-02')).toBe(true);
  });
  it('rejects known holidays', () => {
    expect(isTradingDay('2024-01-01')).toBe(false);
    expect(isTradingDay('2024-12-25')).toBe(false);
    expect(isTradingDay('2024-07-04')).toBe(false);
  });
});

describe('iterDays', () => {
  it('skips weekends and holidays', () => {
    const days = [...iterDays('2024-01-01', '2024-01-08')];
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08',
    ]);
    expect(days.every((d) => d.getHours() === 16 && d.getMinutes() === 0)).toBe(true);
  });

  it('honors a custom calendar', () => {
    const custom = ['2024-01-01', '2024-01-08'];
    const days = [...iterDays('2024-01-01', '2024-01-08', { tradeDays: custom })];
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2024-01-01', '2024-01-08',
    ]);
  });
});

describe('iterMinutes', () => {
  it('emits 391 stamps per day at 1-minute step', () => {
    const minutes = [...iterMinutes('2024-01-02', '2024-01-02')];
    expect(minutes).toHaveLength(391); // 9:30 → 16:00 inclusive
    expect(minutes[0].getHours()).toBe(9);
    expect(minutes[0].getMinutes()).toBe(30);
    const last = minutes[minutes.length - 1];
    expect(last.getHours()).toBe(16);
    expect(last.getMinutes()).toBe(0);
  });

  it('respects step size', () => {
    const minutes = [...iterMinutes('2024-01-02', '2024-01-02', { stepMinutes: 30 })];
    expect(minutes).toHaveLength(14); // 9:30, 10:00, …, 16:00
  });

  it('rejects bad step', () => {
    expect(() => [...iterMinutes('2024-01-02', '2024-01-02', { stepMinutes: 0 })])
      .toThrow();
  });
});

describe('replay', () => {
  it('yields {at, response} for each timestamp', async () => {
    const responses = [
      jsonResponse({ regime: 'positive_gamma' }),
      jsonResponse({ regime: 'negative_gamma' }),
    ];
    const fakeFetch = (async () => responses.shift()!) as typeof fetch;
    const hx = new FlashAlphaHistorical('K', { fetch: fakeFetch });

    const out = [];
    for await (const step of replay<{ regime: string }>(
      hx,
      'exposureSummary',
      'SPY',
      iterDays('2024-01-02', '2024-01-03'),
    )) {
      out.push(step);
    }
    expect(out).toHaveLength(2);
    expect(out[0].at).toBe('2024-01-02T16:00:00');
    expect(out[1].response.regime).toBe('negative_gamma');
  });

  it('skips no_data when skipMissing=true', async () => {
    const responses = [
      jsonResponse({ regime: 'positive_gamma' }),
      jsonResponse({ error: 'no_data' }, 404),
    ];
    const fakeFetch = (async () => responses.shift()!) as typeof fetch;
    const hx = new FlashAlphaHistorical('K', { fetch: fakeFetch });

    const errs: unknown[] = [];
    const out = [];
    for await (const step of replay(
      hx,
      'exposureSummary',
      'SPY',
      ['2024-01-02', '2024-01-03'],
      { onError: (_at, e) => errs.push(e) },
    )) {
      out.push(step);
    }
    expect(out).toHaveLength(1);
    expect(errs).toHaveLength(1);
  });

  it('rejects unknown method', async () => {
    const hx = new FlashAlphaHistorical('K', { fetch: (async () => jsonResponse({})) as typeof fetch });
    await expect(async () => {
      const it = replay(hx, 'tickers', 'SPY', ['2024-01-02']);
      // pull one to trigger evaluation
      await it.next();
    }).rejects.toThrow(/expects a method that takes/);
  });
});

describe('Backtester', () => {
  it('runs a strategy and exposes records', async () => {
    const fakeFetch = (async () =>
      jsonResponse({
        as_of: '2024-01-02T16:00:00',
        price: { mid: 470.5 },
        exposure: { regime: 'positive_gamma' },
        volatility: { vrp: 6.7, atm_iv: 14.0 },
      })) as typeof fetch;
    const hx = new FlashAlphaHistorical('K', { fetch: fakeFetch });

    const bt = new Backtester(hx, { method: 'stockSummary', symbol: 'SPY' });
    const results = await bt.run<{ volatility: { vrp: number } }, { signal: string | null }>(
      ['2024-01-02'],
      (_at, snap) => ({ signal: snap.volatility.vrp > 5 ? 'go' : null }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].output).toEqual({ signal: 'go' });

    const rec = bt.toRecords(results)[0];
    expect(rec).toMatchObject({
      at: '2024-01-02',
      underlying_price: 470.5,
      signal: 'go',
    });
    // BASE_URL is exported correctly
    expect(BASE_URL).toBe('https://historical.flashalpha.com');
  });
});
