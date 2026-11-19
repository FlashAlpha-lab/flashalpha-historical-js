import * as fs from 'fs';
import * as path from 'path';
import {
  AuthenticationError,
  BASE_URL,
  FlashAlphaHistorical,
  FlashAlphaHistoricalError,
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

describe('sellWindow', () => {
  it('sends `at` and returns the answer', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          symbol: 'SPY',
          session: '2026-10-16',
          spot: 772.255,
          quoted_at: '2026-10-16T13:35:00Z',
          legs_indicative: false,
          windows: [
            {
              expiry: '2026-10-16',
              days_to_expiry: 0,
              action: 'sell',
              candidates: [
                {
                  structure: 'short_put',
                  exit: 'expiry',
                  legs: [{ side: 'sell', quantity: 1, type: 'put', strike: 769, delta: -0.19, bid: 0.39, ask: 0.4 }],
                  mid_credit: 0.395,
                },
              ],
            },
            { expiry: '2026-10-23', days_to_expiry: 7, action: 'skip' },
            { expiry: '2026-10-30', days_to_expiry: 14, action: 'skip' },
            { action: 'unavailable' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const hx = new FlashAlphaHistorical('KEY', { fetch: fakeFetch });
    const answer = await hx.sellWindow('SPY', { at: '2026-10-16T09:35:00' });
    expect(calls[0]).toContain(`${BASE_URL}/v1/strategies/sell-window/SPY`);
    expect(calls[0]).toContain('at=2026-10-16T09%3A35%3A00');
    expect(answer.windows?.[0].candidates?.[0].mid_credit).toBe(0.395);
  });

  it('maps 400 invalid_at to InvalidAtError', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_at', message: 'at is in the future.' }), {
        status: 400,
      })) as typeof fetch;
    const hx = new FlashAlphaHistorical('K', { fetch: fakeFetch });
    await expect(hx.sellWindow('SPY', { at: '2099-01-02T09:35:00' })).rejects.toBeInstanceOf(InvalidAtError);
  });
});

// ── expiry impact and strike dependency ──────────────────────────────────────
// Fixtures are real production responses captured 2026-11-19 (lists trimmed).

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function fixtureFetch(status: number, body: unknown, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('expiryImpact', () => {
  it('sends only `at` when expiry and limit are omitted', async () => {
    const calls: string[] = [];
    const hx = new FlashAlphaHistorical('KEY', {
      fetch: fixtureFetch(200, fixture('expiry_impact_historical.json'), calls),
    });
    await hx.expiryImpact('SPY', { at: '2026-10-09T15:55:00' });
    const url = new URL(calls[0]);
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE_URL}/v1/exposure/expiry-impact/SPY`);
    expect(url.search).toBe('?at=2026-10-09T15%3A55%3A00');
  });

  it('sends expiry and limit when given', async () => {
    const calls: string[] = [];
    const hx = new FlashAlphaHistorical('KEY', {
      fetch: fixtureFetch(200, fixture('expiry_impact_historical.json'), calls),
    });
    await hx.expiryImpact('QQQ', { at: '2026-10-09', expiry: '2026-10-12', limit: 3 });
    const url = new URL(calls[0]);
    expect(url.pathname).toBe('/v1/exposure/expiry-impact/QQQ');
    expect(url.search).toBe('?at=2026-10-09&expiry=2026-10-12&limit=3');
  });

  it('binds the typed response at every level', async () => {
    const hx = new FlashAlphaHistorical('KEY', {
      fetch: fixtureFetch(200, fixture('expiry_impact_historical.json')),
    });
    const r = await hx.expiryImpact('SPY', { at: '2026-10-09T15:55:00' });
    expect(r.selected_expiry).toBe('2026-10-09');
    expect(r.available_expiries[1]).toBe('2026-10-12');
    expect(r.current.contract_count).toBe(12078);
    expect(r.excluding_expiry.status).toBe('available');
    expect(r.impact.removed_gross_share_pct).toBeCloseTo(27.355976302706107, 12);
    expect(r.impact.largest_gross_reductions[0].strike).toBe(778);
    expect(r.impact.strongest_remaining_concentrations[1].excluded_net_gex_usd).toBeCloseTo(-186739.42129722596, 6);
    expect(r.strikes[2].strike).toBe(60);
    expect(r.facts[0].supporting_values['gross_share_pct']).toBeCloseTo(27.355976302706107, 12);
    expect(r.reasons[0].code).toBe('historical_model_reconstruction');
    expect(r.reasons[1].contract_count).toBe(302);
    expect(r.pricing_basis).toBe('historical_quote_repriced_dated_inputs');
    expect(r.endpoint_version).toBe('2026.09.30');
    expect(r.data_as_of?.node).toBe('f3');
    expect(r.archive_as_of?.node).toBe('f3');
    expect(r.archive_as_of?.equity_options_feed).toBe('2026-10-09T19:55:00Z');
  });

  it('throws TierRestrictedError below Alpha', async () => {
    const hx = new FlashAlphaHistorical('KEY', {
      fetch: fixtureFetch(403, { error: 'tier_restricted', message: 'Requires Alpha plan.' }),
    });
    await expect(hx.expiryImpact('SPY', { at: '2026-10-09' })).rejects.toBeInstanceOf(TierRestrictedError);
  });

  it('surfaces 422 unsupported_symbol as FlashAlphaHistoricalError', async () => {
    const hx = new FlashAlphaHistorical('KEY', {
      fetch: fixtureFetch(422, fixture('error_unsupported_symbol.json')),
    });
    const err = await hx.expiryImpact('AAPL', { at: '2026-10-09' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlashAlphaHistoricalError);
    expect((err as FlashAlphaHistoricalError).statusCode).toBe(422);
    expect(((err as FlashAlphaHistoricalError).response as Record<string, unknown>)['error']).toBe(
      'unsupported_symbol',
    );
  });
});

describe('strikeDependency', () => {
  it('sends `at` and a fractional strike exactly', async () => {
    const calls: string[] = [];
    const hx = new FlashAlphaHistorical('KEY', {
      fetch: fixtureFetch(200, fixture('strike_dependency_historical.json'), calls),
    });
    await hx.strikeDependency('SPY', { at: '2026-10-09T15:55:00', strike: 672.5 });
    const url = new URL(calls[0]);
    expect(url.pathname).toBe('/v1/exposure/strike-dependency/SPY');
    expect(url.search).toBe('?at=2026-10-09T15%3A55%3A00&strike=672.5');
  });

  it('sends a whole strike', async () => {
    const calls: string[] = [];
    const hx = new FlashAlphaHistorical('KEY', {
      fetch: fixtureFetch(200, fixture('strike_dependency_historical.json'), calls),
    });
    await hx.strikeDependency('SPY', { at: '2026-10-09', strike: 670 });
    expect(new URL(calls[0]).search).toBe('?at=2026-10-09&strike=670');
  });

  it('binds the typed response at every level', async () => {
    const hx = new FlashAlphaHistorical('KEY', {
      fetch: fixtureFetch(200, fixture('strike_dependency_historical.json')),
    });
    const r = await hx.strikeDependency('SPY', { at: '2026-10-09T15:55:00', strike: 670 });
    expect(r.strike).toBe(670);
    expect(r.contract_count).toBe(60);
    expect(r.put_gex_usd).toBeCloseTo(-105726839.68087156, 6);
    expect(r.by_expiry[0].expiry).toBe('2026-10-13');
    expect(r.by_expiry[0].valuation_cutoff_at).toBe('2026-10-13T20:00:00Z');
    expect(r.by_expiry[0].settlement_at).toBeNull();
    expect(r.by_expiry[2].calendar_days_to_expiry).toBe(6);
    expect(r.by_expiry[2].share_of_strike_gross_pct).toBeCloseTo(0.4462196855682832, 12);
    expect(r.dominant_expiry).toBe('2026-12-18');
    expect(r.dominant_expiry_share_pct).toBeCloseTo(29.844720445178503, 12);
    expect(r.endpoint_version).toBe('2026.09.30');
    expect(r.data_as_of?.equity_feed).toBeNull();
    expect(r.archive_as_of?.node).toBe('f3');
    expect(r.archive_as_of?.oi_feed).toBe('2026-10-08T20:00:00Z');
  });

  it('throws TierRestrictedError below Alpha', async () => {
    const hx = new FlashAlphaHistorical('KEY', {
      fetch: fixtureFetch(403, { error: 'tier_restricted', message: 'Requires Alpha plan.' }),
    });
    await expect(hx.strikeDependency('SPY', { at: '2026-10-09', strike: 670 })).rejects.toBeInstanceOf(
      TierRestrictedError,
    );
  });

  it('maps 404 strike_not_found to NoDataError with the body', async () => {
    const hx = new FlashAlphaHistorical('KEY', {
      fetch: fixtureFetch(404, fixture('error_strike_not_found.json')),
    });
    const err = await hx.strikeDependency('SPY', { at: '2026-10-09', strike: 671.3 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoDataError);
    expect(((err as NoDataError).response as Record<string, unknown>)['error']).toBe('strike_not_found');
    expect(((err as NoDataError).response as Record<string, unknown>)['requested_strike']).toBe(671.3);
  });

  it('surfaces 422 unsupported_symbol as FlashAlphaHistoricalError', async () => {
    const hx = new FlashAlphaHistorical('KEY', {
      fetch: fixtureFetch(422, fixture('error_unsupported_symbol.json')),
    });
    const err = await hx.strikeDependency('AAPL', { at: '2026-10-09', strike: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlashAlphaHistoricalError);
    expect((err as FlashAlphaHistoricalError).statusCode).toBe(422);
  });
});
