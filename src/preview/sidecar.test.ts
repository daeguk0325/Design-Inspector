import { describe, expect, it } from 'vitest';
import { MAX_PREVIEW_BLOCK_CHARS } from './contract.ts';
import { PreviewSidecarParser, createPreviewSidecarParser } from './sidecar.ts';

const VALID_BLOCK = JSON.stringify({
  version: 1,
  rules: [{ target: 1, declarations: { 'border-radius': '10px', color: '#112233' } }],
});

const KOREAN_PREFIX = [
  '## 디자이너 전달문',
  '',
  '버튼의 대비를 높이 [1]',
  '',
  '## 검수 체크리스트',
  '',
  '- 포커스 링 확인',
  '',
].join('\n');

interface Run {
  text: string;
  candidate: ReturnType<PreviewSidecarParser['flush']>['candidate'];
  parser: PreviewSidecarParser;
}

function run(fragments: string[], context?: { knownCitationNumbers?: number[] }): Run {
  const parser = new PreviewSidecarParser(context);
  let text = '';
  let candidate: Run['candidate'] = null;
  for (const fragment of fragments) {
    const delta = parser.push(fragment);
    text += delta.text;
    if (delta.candidate !== null) candidate = delta.candidate;
  }
  const flushed = parser.flush();
  text += flushed.text;
  if (flushed.candidate !== null) candidate = flushed.candidate;
  return { text, candidate, parser };
}

const splitEvery = (value: string, size: number): string[] => {
  const chars = [...value];
  const parts: string[] = [];
  for (let index = 0; index < chars.length; index += size) {
    parts.push(chars.slice(index, index + size).join(''));
  }
  return parts;
};

describe('PreviewSidecarParser', () => {
  it('passes plain Markdown through untouched', () => {
    const body = `${KOREAN_PREFIX}\n`;
    const { text, candidate, parser } = run([body]);
    expect(text).toBe(body);
    expect(candidate).toBeNull();
    expect(parser.hasOpenBlock).toBe(false);
    expect(parser.stats.blocksStripped).toBe(0);
  });

  it('removes a final block and yields a validated candidate', () => {
    const body = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    const { text, candidate, parser } = run([body]);
    expect(text).toBe(`${KOREAN_PREFIX}\n`);
    expect(candidate).toEqual({
      version: 1,
      rules: [{ target: 1, declarations: { 'border-radius': '10px', color: '#112233' } }],
    });
    expect(parser.candidate).toEqual(candidate);
    expect(parser.stats.blocksStripped).toBe(1);
    expect(parser.stats.blocksInvalid).toBe(0);
  });

  it('emits visible tokens incrementally while buffering the block', () => {
    const parser = new PreviewSidecarParser();
    expect(parser.push('## 제목\n\n본문 ')).toEqual({ text: '## 제목\n\n본문 ', candidate: null });
    expect(parser.push('텍스트\n').text).toBe('텍스트\n');
    expect(parser.push('```design-inspector-').text).toBe('');
    expect(parser.hasOpenBlock).toBe(false);
    expect(parser.push('preview\n').text).toBe('');
    expect(parser.hasOpenBlock).toBe(true);
    expect(parser.push(`${VALID_BLOCK.slice(0, 12)}`).text).toBe('');
    expect(parser.push(`${VALID_BLOCK.slice(12)}\n`).text).toBe('');
    expect(parser.push('```\n').text).toBe('');
    const flushed = parser.flush();
    expect(flushed.candidate).not.toBeNull();
    expect(flushed.text).toBe('');
  });

  it('streams visible partial lines and holds back only fence-shaped prefixes', () => {
    const parser = new PreviewSidecarParser();
    expect(parser.push('가').text).toBe('가');
    expect(parser.push('나').text).toBe('나');
    expect(parser.push('\n').text).toBe('\n');
    expect(parser.push('`').text).toBe('');
    expect(parser.push('``').text).toBe('');
    expect(parser.push('d').text).toBe('');
    expect(parser.push('X').text).toBe('```dX');
    expect(parser.push('typescript\n').text).toBe('typescript\n');
    expect(parser.push('끝').text).toBe('끝');
    expect(parser.flush().text).toBe('');
  });

  it('handles fences and bodies split at every possible chunk boundary', () => {
    const body = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    for (const size of [1, 2, 3, 5, 7, 11, 13, 32, 64, 997]) {
      const { text, candidate } = run(splitEvery(body, size), { knownCitationNumbers: [1] });
      expect({ size, text }).toEqual({ size, text: `${KOREAN_PREFIX}\n` });
      expect({ size, rules: candidate?.rules.length ?? 0 }).toEqual({ size, rules: 1 });
    }
  });

  it('preserves CRLF line endings in visible output', () => {
    const lfBody = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    const { text, candidate } = run([lfBody.replaceAll('\n', '\r\n')]);
    expect(text).toBe(`${KOREAN_PREFIX}\n`.replaceAll('\n', '\r\n'));
    expect(candidate?.rules[0]?.target).toBe(1);
  });

  it('accepts trailing whitespace and a missing final newline', () => {
    const body = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`   \n\n \t\n`;
    const { text, candidate } = run([body]);
    expect(text).toBe(`${KOREAN_PREFIX}\n\n \t\n`);
    expect(candidate).not.toBeNull();
  });

  it('emits a trailing partial line on flush', () => {
    const parser = new PreviewSidecarParser();
    expect(parser.push('완료 문장\n').text).toBe('완료 문장\n');
    expect(parser.flush().text).toBe('');
    const other = new PreviewSidecarParser();
    expect(other.push('완료 문장').text).toBe('완료 문장');
    expect(other.flush().text).toBe('');
  });

  it('rejects a candidate when visible content follows the closing fence', () => {
    const body = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n추가 설명\n`;
    const { text, candidate, parser } = run([body]);
    expect(text).toBe(`${KOREAN_PREFIX}\n추가 설명\n`);
    expect(candidate).toBeNull();
    expect(parser.stats.blocksStripped).toBe(1);
  });

  it('clears a candidate when a second block starts', () => {
    const body =
      `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n` +
      '중간 텍스트\n' +
      '```design-inspector-preview\n' +
      `${JSON.stringify({ version: 1, rules: [{ target: 7, declarations: { color: 'red' } }] })}\n` +
      '```\n';
    const { text, candidate } = run([body], { knownCitationNumbers: [1, 7] });
    expect(text).toBe(`${KOREAN_PREFIX}\n중간 텍스트\n`);
    expect(candidate?.rules[0]?.target).toBe(7);
  });

  it('uses only the last block when several are adjacent', () => {
    const first = JSON.stringify({ version: 1, rules: [{ target: 1, declarations: { color: 'red' } }] });
    const second = JSON.stringify({ version: 1, rules: [{ target: 2, declarations: { color: 'blue' } }] });
    const body =
      `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${first}\n\`\`\`\n` +
      '```design-inspector-preview\n' +
      `${second}\n\`\`\`\n`;
    const { text, candidate, parser } = run([body], { knownCitationNumbers: [1, 2] });
    expect(text).toBe(`${KOREAN_PREFIX}\n`);
    expect(candidate?.rules[0]?.target).toBe(2);
    expect(parser.stats.blocksStripped).toBe(2);
  });

  it('rejects invalid JSON without leaking it', () => {
    const body = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n{"version":1,\n\`\`\`\n`;
    const { text, candidate, parser } = run([body]);
    expect(text).toBe(`${KOREAN_PREFIX}\n`);
    expect(candidate).toBeNull();
    expect(parser.stats.blocksStripped).toBe(1);
    expect(parser.stats.blocksInvalid).toBe(1);
  });

  it('rejects empty blocks and fences holding Markdown', () => {
    const empty = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n\n\`\`\`\n`;
    const markdown = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\nsome prose\n\`\`\`\n`;
    expect(run([empty]).candidate).toBeNull();
    const leaked = run([markdown]);
    expect(leaked.candidate).toBeNull();
    expect(leaked.text).toBe(`${KOREAN_PREFIX}\n`);
    expect(leaked.parser.stats.blocksInvalid).toBe(1);
  });

  it('rejects blocks with unknown keys or an unknown version', () => {
    const extra = JSON.stringify({ version: 1, rules: [{ target: 1, declarations: { color: 'red' } }], extra: true });
    const v2 = JSON.stringify({ version: 2, rules: [{ target: 1, declarations: { color: 'red' } }] });
    for (const body of [extra, v2]) {
      const { text, candidate } = run([`${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${body}\n\`\`\`\n`]);
      expect(text).toBe(`${KOREAN_PREFIX}\n`);
      expect(candidate).toBeNull();
    }
  });

  it('rejects duplicate citation numbers inside one block', () => {
    const body = JSON.stringify({
      version: 1,
      rules: [
        { target: 2, declarations: { color: 'red' } },
        { target: 2, declarations: { color: 'blue' } },
      ],
    });
    const { candidate, parser } = run([
      `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${body}\n\`\`\`\n`,
    ]);
    expect(candidate).toBeNull();
    expect(parser.stats.blocksStripped).toBe(1);
  });

  it('rejects unknown citation numbers', () => {
    const body = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    expect(run([body], { knownCitationNumbers: [1] }).candidate).not.toBeNull();
    expect(run([body], { knownCitationNumbers: [2, 3] }).candidate).toBeNull();
    expect(run([body], { knownCitationNumbers: [] }).candidate).toBeNull();
    expect(run([body]).candidate).not.toBeNull();
  });

  it('drops an oversized block and keeps streaming', () => {
    const huge = JSON.stringify({
      version: 1,
      rules: [
        {
          target: 1,
          declarations: { 'font-family': `"${'a'.repeat(MAX_PREVIEW_BLOCK_CHARS + 500)}"` },
        },
      ],
    });
    const body = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${huge}\n\`\`\`\n`;
    const { text, candidate, parser } = run([body]);
    expect(text).toBe(`${KOREAN_PREFIX}\n`);
    expect(candidate).toBeNull();
    expect(parser.stats.blocksOversized).toBe(1);
    expect(parser.stats.blocksStripped).toBe(1);
  });

  it('drops an unterminated block and exposes the open state', () => {
    const body = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${VALID_BLOCK}`;
    const parser = new PreviewSidecarParser();
    let text = '';
    for (const fragment of splitEvery(body, 9)) text += parser.push(fragment).text;
    expect(parser.hasOpenBlock).toBe(true);
    const flushed = parser.flush();
    expect(text + flushed.text).toBe(`${KOREAN_PREFIX}\n`);
    expect(flushed.candidate).toBeNull();
    expect(parser.stats.blocksUnterminated).toBe(1);
    expect(parser.stats.blocksStripped).toBe(0);
  });

  it('ignores a fence that is not anchored to a line or has a different tag', () => {
    const inline = `${KOREAN_PREFIX}내에 \`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    const other = `${KOREAN_PREFIX}\n\`\`\`json\n${VALID_BLOCK}\n\`\`\`\n`;
    const trailing = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview-note\n${VALID_BLOCK}\n\`\`\`\n`;
    for (const body of [inline, other, trailing]) {
      const { text, candidate } = run([body]);
      expect(candidate).toBeNull();
      expect(text).toBe(body);
    }
  });

  it('keeps unrelated fenced code blocks visible', () => {
    const body = `${KOREAN_PREFIX}\n\`\`\`ts\nconst a = 1;\n\`\`\`\n`;
    const { text, candidate } = run([body]);
    expect(text).toBe(body);
    expect(candidate).toBeNull();
  });

  it('accepts a longer closing fence', () => {
    const body = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\`\`\`\n`;
    expect(run([body]).candidate).not.toBeNull();
  });

  it('is case tolerant for the info string only', () => {
    const body = `${KOREAN_PREFIX}\n\`\`\`Design-Inspector-Preview\n${VALID_BLOCK}\n\`\`\`\n`;
    expect(run([body]).candidate).not.toBeNull();
  });

  // Observed from the 9B model: with the exact tag in its context it wrote
  // `design-insector-preview`, one letter short. The cost of not recognising
  // that is not a lost preview, it is the JSON printed into the answer.
  it('accepts an info string that is a near miss for ours, and hides the payload', () => {
    for (const tag of [
      'design-insector-preview',
      'design-inspector-prevew',
      'design-inspector_preview',
      'design-inspector-previwe',
    ]) {
      const body = `${KOREAN_PREFIX}\n\`\`\`${tag}\n${VALID_BLOCK}\n\`\`\`\n`;
      const { text, candidate } = run([body]);
      expect(candidate, tag).not.toBeNull();
      expect(text, tag).toBe(`${KOREAN_PREFIX}\n`);
    }
  });

  it('counts a near-miss block so the slip is visible rather than silent', () => {
    const parser = new PreviewSidecarParser();
    parser.push(`${KOREAN_PREFIX}\n\`\`\`design-insector-preview\n${VALID_BLOCK}\n\`\`\`\n`);
    parser.flush();
    expect(parser.stats.blocksNearMiss).toBe(1);
    expect(parser.stats.blocksStripped).toBe(1);
    expect(parser.stats.blocksInvalid).toBe(0);
  });

  it('does not count the exact tag as a near miss', () => {
    const parser = new PreviewSidecarParser();
    parser.push(`${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`);
    parser.flush();
    expect(parser.stats.blocksNearMiss).toBe(0);
  });

  it('refuses a near-miss block whose payload does not validate', () => {
    // The tolerance is only about recognising the fence. Everything downstream
    // of that is unchanged, so a near-miss cannot smuggle anything past the
    // validator that the exact tag could not.
    const body = `${KOREAN_PREFIX}\n\`\`\`design-insector-preview\n{"version":1,"rules":[{"target":1,"declarations":{"position":"fixed"}}]}\n\`\`\`\n`;
    const { text, candidate } = run([body]);
    expect(candidate).toBeNull();
    expect(text).toBe(`${KOREAN_PREFIX}\n`);
  });

  it('keeps a far-off tag as prose, and an unfenced payload as text', () => {
    const far = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview-note\n${VALID_BLOCK}\n\`\`\`\n`;
    expect(run([far]).text).toBe(far);
    const unfenced = `${KOREAN_PREFIX}\n${VALID_BLOCK}\n`;
    expect(run([unfenced]).text).toBe(unfenced);
  });

  it('ignores empty pushes and pushes after flush', () => {
    const parser = createPreviewSidecarParser();
    expect(parser.push('')).toEqual({ text: '', candidate: null });
    expect(parser.push('본문\n').text).toBe('본문\n');
    expect(parser.flush().candidate).toBeNull();
    expect(parser.push('무시됨\n')).toEqual({ text: '', candidate: null });
    expect(parser.flush()).toEqual({ text: '', candidate: null });
  });

  it('surfaces a candidate only once', () => {
    const body = `${KOREAN_PREFIX}\n\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    const parser = new PreviewSidecarParser();
    for (const fragment of splitEvery(body, 5)) {
      expect(parser.push(fragment).candidate).toBeNull();
    }
    expect(parser.flush().candidate).not.toBeNull();
    expect(parser.flush().candidate).toBeNull();
  });

  it('handles a block immediately after the Korean checklist with no blank line', () => {
    const body = `${KOREAN_PREFIX}\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\``;
    const { text, candidate } = run([body]);
    expect(text).toBe(KOREAN_PREFIX);
    expect(candidate).not.toBeNull();
  });

  it('removes a suppressed block from the text but never offers it', () => {
    // The request ruled out a change, so the JSON must not print into the
    // answer and must not become a pending card either.
    const body = `${KOREAN_PREFIX}\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    const parser = new PreviewSidecarParser({}, { suppressBlock: true });
    let text = '';
    for (const fragment of splitEvery(body, 7)) text += parser.push(fragment).text;
    const flushed = parser.flush();
    text += flushed.text;
    expect(text).toBe(KOREAN_PREFIX);
    expect(text).not.toContain('border-radius');
    expect(flushed.candidate).toBeNull();
    expect(parser.candidate).toBeNull();
  });

  it('counts a suppressed block apart from an invalid one', () => {
    // Nothing is wrong with the payload; the request was. Folding this into
    // blocksInvalid would make a stat report read like a model failure.
    const body = `${KOREAN_PREFIX}\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    const parser = new PreviewSidecarParser({}, { suppressBlock: true });
    parser.push(body);
    parser.flush();
    expect(parser.stats.blocksSuppressed).toBe(1);
    expect(parser.stats.blocksInvalid).toBe(0);
    expect(parser.stats.blocksStripped).toBe(1);
  });

  it('still strips the payload when the request allows a change', () => {
    const body = `${KOREAN_PREFIX}\`\`\`design-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    const parser = new PreviewSidecarParser({}, { suppressBlock: false });
    parser.push(body);
    expect(parser.flush().candidate).not.toBeNull();
    expect(parser.stats.blocksSuppressed).toBe(0);
  });

  it('strips a block whose info string is on the line below the fence', () => {
    // Observed from a real 9B in the real app: it wrote the fence bare and the
    // tag on the next line. No line of that matches the opening-fence pattern,
    // so the whole JSON payload rendered as visible text — the exact outcome the
    // near-miss tolerance exists to prevent, reached by a shape it missed.
    const body = `${KOREAN_PREFIX}\`\`\`\ndesign-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    const { text, candidate } = run([body]);
    expect(text).toBe(KOREAN_PREFIX);
    expect(candidate).toEqual({
      version: 1,
      rules: [{ target: 1, declarations: { 'border-radius': '10px', color: '#112233' } }],
    });
  });

  it('strips a split fence with a misspelled tag too', () => {
    const body = `${KOREAN_PREFIX}\`\`\`\ndesign-insector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    const { text, candidate, parser } = run([body]);
    expect(text).toBe(KOREAN_PREFIX);
    expect(candidate).not.toBeNull();
    expect(parser.stats.blocksNearMiss).toBe(1);
  });

  it('strips a split fence at every chunk boundary', () => {
    // The held fence has to survive a fragment boundary, including one landing
    // in the middle of the tag line.
    const body = `${KOREAN_PREFIX}\`\`\`\ndesign-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    for (const size of [1, 2, 3, 5, 7, 13, 29]) {
      const { text, candidate } = run(splitEvery(body, size));
      expect({ size, text }).toEqual({ size, text: KOREAN_PREFIX });
      expect({ size, ok: candidate !== null }).toEqual({ size, ok: true });
    }
  });

  it('still shows an ordinary code fence whose info string is on the next line', () => {
    // The hold-back must not swallow a code block the model wrote for the user.
    const body = `${KOREAN_PREFIX}\`\`\`\njs\nconst a = 1;\n\`\`\`\n`;
    const { text, candidate } = run([body]);
    expect(candidate).toBeNull();
    expect(text).toBe(`${KOREAN_PREFIX}\`\`\`\njs\nconst a = 1;\n\`\`\`\n`);
  });

  it('shows a bare fence when nothing follows it', () => {
    const body = `${KOREAN_PREFIX}조회 예시\n\`\`\`\n`;
    const { text } = run([body]);
    expect(text).toBe(body);
  });

  it('removes a suppressed block that arrived in split-fence form', () => {
    const body = `${KOREAN_PREFIX}\`\`\`\ndesign-inspector-preview\n${VALID_BLOCK}\n\`\`\`\n`;
    const parser = new PreviewSidecarParser({}, { suppressBlock: true });
    let text = '';
    for (const fragment of splitEvery(body, 4)) text += parser.push(fragment).text;
    text += parser.flush().text;
    expect(text).toBe(KOREAN_PREFIX);
    expect(parser.stats.blocksSuppressed).toBe(1);
  });
});
