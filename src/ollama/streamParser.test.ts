// Ollama stream parser tests (§§16.5, 22.5): arbitrary chunk boundaries.
import { describe, expect, it } from 'vitest';
import { OllamaStreamParser } from './streamParser.ts';

function collect(feeds: string[]) {
  const parser = new OllamaStreamParser();
  const tokens: string[] = [];
  let doneCount = 0;
  let errors: string[] = [];
  for (const f of feeds) {
    parser.push(
      f,
      (t) => tokens.push(t),
      () => {
        doneCount += 1;
      },
      (m) => errors.push(m),
    );
  }
  parser.flush((t) => tokens.push(t));
  return { tokens, doneCount, errors, parser };
}

describe('OllamaStreamParser', () => {
  it('handles a JSON object split across arbitrary chunk boundaries', () => {
    const full = JSON.stringify({ message: { content: 'hello' } }) + '\n';
    const cut = Math.floor(full.length / 2);
    const { tokens } = collect([full.slice(0, cut), full.slice(cut)]);
    expect(tokens.join('')).toBe('hello');
  });

  it('handles multiple JSON objects in one chunk', () => {
    const chunk =
      JSON.stringify({ message: { content: 'a' } }) +
      '\n' +
      JSON.stringify({ message: { content: 'b' } }) +
      '\n';
    const { tokens } = collect([chunk]);
    expect(tokens.join('')).toBe('ab');
  });

  it('handles UTF-8 multi-byte content split mid-stream', () => {
    // Feed decoded-text fragments that split an emoji sequence across pushes.
    const obj = JSON.stringify({ message: { content: 'héllo 🌍' } }) + '\n';
    const chars = [...obj];
    const mid = Math.floor(chars.length / 2);
    const { tokens } = collect([chars.slice(0, mid).join(''), chars.slice(mid).join('')]);
    expect(tokens.join('')).toBe('héllo 🌍');
  });

  it('skips malformed chunks and still completes', () => {
    const { tokens, parser } = collect([
      'not json\n',
      JSON.stringify({ message: { content: 'ok' } }) + '\n',
      '{truncated',
    ]);
    expect(tokens.join('')).toBe('ok');
    expect(parser.malformedChunks).toBeGreaterThanOrEqual(1);
  });

  it('honours done signals and surfaces server errors', () => {
    const { doneCount, errors } = collect([
      JSON.stringify({ message: { content: 'x' }, done: true }) + '\n',
      JSON.stringify({ error: 'boom' }) + '\n',
    ]);
    expect(doneCount).toBe(1);
    expect(errors).toEqual(['boom']);
  });
});
