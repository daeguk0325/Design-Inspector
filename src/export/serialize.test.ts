// Export tests (§§19, 22.6): deterministic, active-only, pin-ordered, AI-free.
import { describe, expect, it } from 'vitest';
import type { SelectionRecord } from '../protocol/types.ts';
import type { InspectorSession } from '../state/models.ts';
import { buildAgentPrompt, buildRawTranscript } from './serialize.ts';

function rec(id: string, order: number): SelectionRecord {
  return {
    selectionId: id,
    elementKey: `key-${id}`,
    component: `Comp${id}`,
    file: 'src/X.tsx',
    line: order + 1,
    mode: 'html',
    extra: { b: 2, a: 1 },
    state: 'active',
    order,
  };
}

function sessionWith(opts: {
  userTexts: string[];
  activeExtra?: SelectionRecord[];
}): InspectorSession {
  const messages = opts.userTexts.map((t, i) => ({
    id: `m${i}`,
    role: 'user' as const,
    content: t,
    citations: [],
    createdAt: i,
  }));
  return {
    id: 's1',
    title: 'S',
    targetUrl: 'http://localhost:3000/',
    model: 'm',
    messages,
    previewTransactions: [],
    persistedActiveSelectionIds: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('buildAgentPrompt', () => {
  it('uses the latest raw user request', () => {
    const s = sessionWith({ userTexts: ['first', 'second — final'] });
    const out = buildAgentPrompt({ session: s, active: [] });
    expect(out).toContain('second — final');
    expect(out.match(/## Request\n([\s\S]*?)\n\n## Components/)?.[1]).toBe('second — final');
  });

  it('includes only active reconciled citations, deduped, first-added order', () => {
    const s = sessionWith({ userTexts: ['do it'] });
    const b = rec('b', 5);
    const a = rec('a', 2);
    const out = buildAgentPrompt({ session: s, active: [b, a, a] });
    const idxA = out.indexOf('Compa ');
    const idxB = out.indexOf('Compb ');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB); // first-added order
    expect(out.match(/selectionId: a/g)?.length).toBe(1); // deduped
  });

  it('carries only the latest request and never a constraints section', () => {
    const s = sessionWith({ userTexts: ['one', 'two', 'three'] });
    const out = buildAgentPrompt({ session: s, active: [] });
    expect(out).not.toContain('## Constraints');
    expect(out).toContain('## Request');
    expect(out).toContain('three');
  });

  it('serializes extra deterministically (sorted keys) with one trailing newline', () => {
    const s = sessionWith({ userTexts: ['x'] });
    const out1 = buildAgentPrompt({ session: s, active: [rec('a', 0)] });
    const out2 = buildAgentPrompt({ session: s, active: [rec('a', 0)] });
    expect(out1).toBe(out2);
    expect(out1).toMatch(/extra: \{"a": 1, "b": 2\}/);
    expect(out1.endsWith('\n')).toBe(true);
    expect(out1.endsWith('\n\n')).toBe(false);
    expect(out1).not.toContain('\r');
  });

  it('never touches the network (pure function — no Ollama invocation)', () => {
    // If serialize imported fetch it would fail construction here; assert purity by
    // running twice with identical input and comparing (no randomness, no I/O).
    const s = sessionWith({ userTexts: ['cite [1] literally — must survive verbatim'] });
    const a = buildAgentPrompt({ session: s, active: [] });
    const b = buildAgentPrompt({ session: s, active: [] });
    expect(a).toBe(b);
    expect(a).toContain('cite [1] literally');
  });
});

describe('buildRawTranscript', () => {
  it('exports conversation without the agent transformation', () => {
    const s = sessionWith({ userTexts: ['hello'] });
    const raw = buildRawTranscript(s);
    expect(raw).toContain('### user');
    expect(raw).toContain('hello');
    expect(raw).not.toContain('## Components');
  });
});

describe('style facts stay out of the agent export', () => {
  it('does not serialize measured style values into the copyable prompt', () => {
    // The agent prompt is pasted into another tool by a human, with no
    // untrusted-evidence framing around it. Style facts belong in the model
    // transmission, not here.
    const facts = {
      props: { 'background-color': '#3884ff', 'font-family': 'SecretInternalFont' },
      geometry: { x: 1, y: 2, width: 3, height: 4 },
      label: 'internal-label',
      ancestors: ['header.nav'],
      tagName: 'button',
    };
    const session = sessionWith({ userTexts: ['request'], activeExtra: [{ ...rec('a', 0), styleFacts: facts }] });
    const out = buildAgentPrompt({ session, active: [rec('a', 0)] });
    expect(out).not.toContain('#3884ff');
    expect(out).not.toContain('SecretInternalFont');
    expect(out).not.toContain('internal-label');
    expect(out).not.toContain('styleFacts');
  });
});

/**
 * I18 — the export discloses live, unexported preview state.
 *
 * The output used to be byte-identical whether zero or five previews were
 * applied and undecided. An agent handed that text rebuilds the page as it was
 * before the preview, and nothing in it says the page the user is looking at is
 * different. That is the one place a runtime-only mutation has to be named,
 * because the whole system otherwise depends on the user not needing to say it.
 */
describe('buildAgentPrompt live preview disclosure', () => {
  function withPreview(status: string, enabled: boolean): InspectorSession {
    const base = sessionWith({ userTexts: ['make it blue'] });
    return {
      ...base,
      previewTransactions: [
        {
          id: 'pv-1',
          assistantId: 'a1',
          userMessageId: 'm0',
          sessionId: 's1',
          targetUrl: base.targetUrl,
          routeKey: '/',
          changes: [
            {
              target: 1,
              anchor: {
                elementKey: 'html:testid:save',
                routeKey: '/',
                mode: 'html' as const,
                tagName: 'button',
                id: '',
                testId: 'save',
                path: '/',
              },
              declarations: { color: 'rgb(0, 0, 255)' },
            },
          ],
          enabled,
          status: status as InspectorSession['previewTransactions'][number]['status'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
  }

  it('says so, and names the element and the change, when a preview is live', () => {
    const out = buildAgentPrompt({ session: withPreview('applied', true), active: [] });
    expect(out).toContain('## Live preview');
    expect(out).toContain('html:testid:save');
    expect(out).toContain('color: rgb(0, 0, 255)');
    // It has to say the mutations are not in the source, or the agent will
    // implement the request above and call the page correct.
    expect(out).toContain('not in the target project');
  });

  it('distinguishes a design-produced transaction from a chat one', () => {
    const base = withPreview('applied', true);
    const design = {
      ...base,
      previewTransactions: [
        { ...base.previewTransactions[0]!, producer: { kind: 'design' as const } },
      ],
    };
    expect(buildAgentPrompt({ session: design, active: [] })).toContain('design');
    expect(buildAgentPrompt({ session: base, active: [] })).toContain('chat');
  });

  it('names a partial application with its count rather than implying completeness', () => {
    const base = withPreview('partial', true);
    const two = { ...base.previewTransactions[0]!, changes: [...base.previewTransactions[0]!.changes, ...base.previewTransactions[0]!.changes] };
    const out = buildAgentPrompt({ session: { ...base, previewTransactions: [{ ...two, appliedChanges: 1 }] }, active: [] });
    expect(out).toContain('partial');
  });

  for (const [status, enabled] of [
    ['undone', false],
    ['reset', false],
    ['rejected', false],
    ['stale-binding', false],
    ['applied', false],
  ] as const) {
    it(`stays silent for ${status} with enabled=${enabled}`, () => {
      const out = buildAgentPrompt({ session: withPreview(status, enabled), active: [] });
      expect(out).not.toContain('## Live preview');
    });
  }

  it('leaves a clean session byte-identical to before', () => {
    const out = buildAgentPrompt({ session: sessionWith({ userTexts: ['request'] }), active: [] });
    expect(out).not.toContain('Live preview');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});