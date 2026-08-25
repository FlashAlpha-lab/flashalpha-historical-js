import * as fs from 'fs';
import * as path from 'path';

/**
 * Guard that every response type carries the envelope.
 *
 * The envelope was added to 20 interfaces by a sweep. Trusting that the sweep reached
 * all of them - and that an interface added later will not quietly miss it - is exactly
 * the assumption worth testing.
 *
 * TypeScript interfaces are erased at runtime, so there is no object to inspect: the
 * guard reads the declarations from source. That makes it a check against the source
 * drifting, not a runtime behaviour test.
 */

const TYPES_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'types.ts'), 'utf8');

/** Every `export interface *Response { ... }` block, paired with its body. */
function responseInterfaces(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /export interface (\w+Response) \{/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(TYPES_SRC)) !== null) {
    // Walk braces from the opening one so nested object literals do not end the block
    // early - a lazy match to the first '}' would stop inside any inline sub-object.
    let depth = 0;
    let i = TYPES_SRC.indexOf('{', m.index);
    const start = i;
    for (; i < TYPES_SRC.length; i++) {
      if (TYPES_SRC[i] === '{') depth++;
      else if (TYPES_SRC[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push([m[1], TYPES_SRC.slice(start, i + 1)]);
  }
  return out;
}

describe('response envelope', () => {
  const interfaces = responseInterfaces();

  it('finds the response interfaces at all', () => {
    // Without this the per-interface checks below would pass vacuously if the file
    // moved or the scan broke.
    expect(interfaces.length).toBeGreaterThan(10);
  });

  it.each(interfaces.map(([name]) => name))('%s declares the envelope', (name) => {
    const body = interfaces.find(([n]) => n === name)![1];
    expect(body).toContain('data_as_of');
    expect(body).toContain('archive_as_of');
    expect(body).toContain('endpoint_version');
  });

  it('declares every feed on DataAsOf', () => {
    // The nine feeds are a contract shared with the live API and the other SDKs. Spot
    // and options are separate on purpose: they arrive over different pipes and fail
    // independently, so collapsing any pair would lose the distinction the field exists
    // to make.
    const m = TYPES_SRC.match(/export interface DataAsOf \{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();

    const declared = [...m![1].matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]);
    expect(new Set(declared)).toEqual(
      new Set([
        'node',
        'equity_feed',
        'equity_options_feed',
        'index_feed',
        'index_options_feed',
        'futures_feed',
        'futures_options_feed',
        'flow_feed',
        'oi_feed',
        'macro_feed',
      ]),
    );
  });

  it('exports both envelope types from the package root', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(index).toMatch(/\bDataAsOf\b/);
    expect(index).toMatch(/\bArchiveAsOf\b/);
  });
});
