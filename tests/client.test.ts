import {
  AuthenticationError,
  BASE_URL,
  FlashAlphaHistorical,
  InsufficientDataError,
  InvalidAtError,
  NoCoverageError,
  NoDataError,
  SymbolNotFoundError,
  TierRestrictedError,
  formatAt,
} from '../src';

describe('formatAt', () => {
  it('passes strings through', () => {
    expect(formatAt('2026-03-05T15:30:00')).toBe('2026-03-05T15:30:00');
    expect(formatAt('2026-03-05')).toBe('2026-03-05');
  });

  it('formats Date in local clock', () => {
    const d = new Date(2026, 2, 5, 15, 30, 0); // March = month 2
    expect(formatAt(d)).toBe('2026-03-05T15:30:00');
  });
});

describe('FlashAlphaHistorical', () => {
  it('throws if api key missing', () => {
    expect(() => new FlashAlphaHistorical('')).toThrow(/apiKey is required/);
  });

  it('forwards X-Api-Key header and `at` query', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ regime: 'positive_gamma' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const hx = new FlashAlphaHistorical('KEY', { fetch: fakeFetch });
    const out = await hx.exposureSummary('SPY', { at: '2026-03-05T15:30:00' });
    expect((out as { regime: string }).regime).toBe('positive_gamma');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`${BASE_URL}/v1/exposure/summary/SPY`);
    expect(calls[0].url).toContain('at=2026-03-05T15%3A30%3A00');
    expect((calls[0].init?.headers as Record<string, string>)['X-Api-Key']).toBe(
      'KEY',
    );
  });

  it('maps 400 invalid_at to InvalidAtError', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_at', message: 'bad' }), {
        status: 400,
      })) as typeof fetch;
    const hx = new FlashAlphaHistorical('K', { fetch: fakeFetch });
    await expect(hx.gex('SPY', { at: 'garbage' })).rejects.toBeInstanceOf(
      InvalidAtError,
    );
  });

  it('maps 401 to AuthenticationError', async () => {
    const fakeFetch = (async () => new Response('', { status: 401 })) as typeof fetch;
    const hx = new FlashAlphaHistorical('K', { fetch: fakeFetch });
    await expect(hx.tickers()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('maps 403 tier_restricted to TierRestrictedError with plan info', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          error: 'tier_restricted',
          current_plan: 'Growth',
          required_plan: 'Alpha',
          message: 'needs Alpha',
        }),
        { status: 403 },
      )) as typeof fetch;
    const hx = new FlashAlphaHistorical('K', { fetch: fakeFetch });
    await expect(hx.exposureSummary('SPY', { at: '2026-03-05' })).rejects.toMatchObject(
      {
        name: 'TierRestrictedError',
        currentPlan: 'Growth',
        requiredPlan: 'Alpha',
      },
    );
  });

  it('maps 404 no_coverage to NoCoverageError', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'no_coverage' }), {
        status: 404,
      })) as typeof fetch;
    const hx = new FlashAlphaHistorical('K', { fetch: fakeFetch });
    await expect(hx.tickers({ symbol: 'UNKNOWN' })).rejects.toBeInstanceOf(
      NoCoverageError,
    );
  });

  it('maps 404 symbol_not_found to SymbolNotFoundError', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'symbol_not_found' }), {
        status: 404,
      })) as typeof fetch;
    const hx = new FlashAlphaHistorical('K', { fetch: fakeFetch });
    await expect(hx.stockQuote('XYZ', { at: '2024-01-02' })).rejects.toBeInstanceOf(
      SymbolNotFoundError,
    );
  });

  it('maps 404 insufficient_data to InsufficientDataError', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'insufficient_data' }), {
        status: 404,
      })) as typeof fetch;
    const hx = new FlashAlphaHistorical('K', { fetch: fakeFetch });
    await expect(hx.surface('SPY', { at: '2018-04-16' })).rejects.toBeInstanceOf(
      InsufficientDataError,
    );
  });

  it('maps generic 404 to NoDataError', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'no_data' }), {
        status: 404,
      })) as typeof fetch;
    const hx = new FlashAlphaHistorical('K', { fetch: fakeFetch });
    await expect(hx.exposureSummary('SPY', { at: '2017-01-01' })).rejects.toBeInstanceOf(
      NoDataError,
    );
  });

  it('forwards all option_quote filters', async () => {
    const calls: { url: string }[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push({ url });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    const hx = new FlashAlphaHistorical('K', { fetch: fakeFetch });
    await hx.optionQuote('SPY', {
      at: '2026-03-05T15:30:00',
      expiry: '2026-03-06',
      strike: 680,
      type: 'C',
    });
    const u = calls[0].url;
    expect(u).toContain('strike=680');
    expect(u).toContain('type=C');
    expect(u).toContain('expiry=2026-03-06');
  });
});
