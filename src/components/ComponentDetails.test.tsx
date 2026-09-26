import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { SelectionRecord } from '../protocol/types.ts';
import { clearSourceCache } from '../target/sourceCache.ts';
import { ComponentDetails } from './ComponentDetails.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  // Nothing answers the source route in a test that is not about the source
  // block, so the read is left pending: a settled one would push a state update
  // into a synchronous test, outside act(), and every row assertion with it.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  // The source cache is module state: an entry one test read must not answer
  // the next test's read, or the fetch counts below would prove nothing.
  clearSourceCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(record: SelectionRecord): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ComponentDetails record={record} />));
  mounted.push({ root, container });
  return container;
}

/** Re-render into a container `render` already mounted, as a new record would. */
function update(container: HTMLElement, next: SelectionRecord): void {
  const entry = mounted.find((item) => item.container === container);
  if (entry === undefined) throw new Error('container is not mounted here');
  act(() => entry.root.render(<ComponentDetails record={next} />));
}

/** Let the source read settle: the block lands through a promise chain. */
async function settle(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function record(overrides: Partial<SelectionRecord> = {}): SelectionRecord {
  return {
    selectionId: 's1',
    elementKey: 'button.primary',
    component: 'PrimaryButton',
    file: 'src/ui/Button.tsx',
    line: 42,
    mode: 'html',
    state: 'active',
    order: 0,
    ...overrides,
  };
}

function rows(container: HTMLElement): Array<[string, string]> {
  return [...container.querySelectorAll('.cdetails-row')].map((row) => [
    row.querySelector('dt')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? '',
  ]);
}

/**
 * A stand-in for the supervisor's source route, keyed off its own query.
 *
 * The body follows the request, so a panel that asked about the wrong file or
 * line is caught here instead of passing on a snippet that happened to match.
 */
function sourceRoute(): Mock<(input: RequestInfo | URL) => Promise<Response>> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const query = new URL(String(input)).searchParams;
    const path = query.get('path') ?? '';
    const line = Number(query.get('line') ?? '0');
    const lines = [
      `// cited at line ${line}`,
      'export function Button() {',
      '  return <button />;',
      '}',
    ];
    return new Response(JSON.stringify({ path, startLine: line - 1, totalLines: 200, lines }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

/** A refused read, as the supervisor reports one. */
function refused(reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

function headings(container: HTMLElement): string[] {
  return [...container.querySelectorAll('h4, h5')].map((node) => node.textContent ?? '');
}

describe('ComponentDetails', () => {
  it('renders component, tag, element key, location, and mode', () => {
    const container = render(record());
    expect(rows(container)).toEqual([
      ['Component', 'PrimaryButton'],
      ['Tag', 'button'],
      ['Element key', 'button.primary'],
      ['Location', 'src/ui/Button.tsx:42'],
      ['Mode', 'HTML'],
    ]);
    expect(container.querySelector('.cdetails')?.getAttribute('aria-label')).toBe(
      'Component details: PrimaryButton',
    );
  });

  it('prefers a sanitized tag from extra and derives text fields', () => {
    const container = render(
      record({ extra: { tagName: 'SECTION', text: 'Save changes', role: 'button', 'aria-label': 'Save' } }),
    );
    expect(rows(container)).toEqual([
      ['Component', 'PrimaryButton'],
      ['Tag', 'section'],
      ['Element key', 'button.primary'],
      ['Location', 'src/ui/Button.tsx:42'],
      ['Mode', 'HTML'],
      ['Text', 'Save changes'],
      ['Aria label', 'Save'],
      ['Role', 'button'],
    ]);
  });

  it('omits the line and shows the mode when no file is known', () => {
    const container = render(record({ file: null, line: null, mode: '3d', elementKey: 'stage#root' }));
    expect(rows(container)).toEqual([
      ['Component', 'PrimaryButton'],
      ['Tag', 'stage'],
      ['Element key', 'stage#root'],
      ['Mode', '3D'],
    ]);
  });

  it('drops data URLs, markup, and nested payloads, and bounds long text', () => {
    const container = render(
      record({
        extra: {
          text: 'data:image/png;base64,AAAABBBB',
          content: '<img src=x onerror=alert(1)>',
          title: 'x'.repeat(400),
          role: { nested: 'value' },
          label: 12,
        },
      }),
    );
    const values = rows(container).map(([, value]) => value);
    expect(values).not.toContain('data:image/png;base64,AAAABBBB');
    expect(values).not.toContain('<img src=x onerror=alert(1)>');
    expect(values).not.toContain('x'.repeat(400));
    expect(container.querySelector('img')).toBeNull();
    const long = rows(container).find(([label]) => label === 'Title')?.[1] ?? '';
    expect(long).toHaveLength(160);
    expect(long.endsWith('…')).toBe(true);
    expect(rows(container).find(([label]) => label === 'Label')?.[1]).toBe('12');
  });

  it('keeps rendering when a record has almost no data', () => {
    const container = render({
      selectionId: 's9',
      elementKey: '',
      component: null,
      file: null,
      line: null,
      mode: 'konva',
      state: 'inactive',
      order: 3,
    });
    expect(rows(container)).toEqual([['Mode', 'Konva']]);
    expect(container.querySelector('.cdetails')?.getAttribute('aria-label')).toBe(
      'Component details: Component',
    );
  });
});

describe('ComponentDetails style facts', () => {
  function groups(container: HTMLElement): Array<[string, Array<[string, string]>]> {
    return [...container.querySelectorAll('.cdetails-style-group')].map((group) => [
      group.querySelector('.cdetails-style-group-label')?.textContent ?? '',
      [...group.querySelectorAll('.cdetails-row')].map((row) => [
        row.querySelector('dt')?.textContent ?? '',
        row.querySelector('dd')?.textContent ?? '',
      ]),
    ]);
  }

  const FACTS = {
    props: {
      color: '#1e1e1e',
      'background-color': '#3884ff',
      'font-size': '14px',
      'padding-top': '12px',
      display: 'inline-flex',
      'transition-duration': '0.2s',
    },
    geometry: { x: 24, y: 180, width: 120, height: 40 },
    ancestors: ['header.nav', 'main'],
    tagName: 'button',
  };

  it('renders each group under its own heading, in group order', () => {
    const container = render(record({ styleFacts: FACTS }));
    expect(groups(container)).toEqual([
      ['Color', [['Color', '#1e1e1e'], ['Background color', '#3884ff']]],
      ['Typography', [['Font size', '14px']]],
      ['Box', [['Padding top', '12px']]],
      ['Layout', [['Display', 'inline-flex']]],
      ['Motion', [['Transition duration', '0.2s']]],
    ]);
  });

  it('renders the ancestor chain from the sanitized copy', () => {
    const container = render(record({ styleFacts: FACTS }));
    const inside = rows(container).find(([label]) => label === 'Inside');
    expect(inside?.[1]).toBe('header.nav > main');
  });

  it('shows a swatch only for a hex color', () => {
    const container = render(record({ styleFacts: FACTS }));
    const swatches = [...container.querySelectorAll('.cdetails-swatch')];
    expect(swatches).toHaveLength(2);
    // jsdom normalizes the authored hex, so assert the swatch is painted
    // rather than pinning the serialization.
    const painted = swatches.map((node) => node.getAttribute('style') ?? '');
    expect(painted[0]).toContain('background');
    expect(painted[1]).toContain('background');
    expect(painted[0]).not.toBe(painted[1]);
  });

  it('renders a non-hex color as text with no swatch', () => {
    const container = render(record({ styleFacts: { props: { color: 'rgb(30, 30, 30)' } } }));
    expect(container.querySelectorAll('.cdetails-swatch')).toHaveLength(0);
    expect(rows(container)).toContainEqual(['Color', 'rgb(30, 30, 30)']);
  });

  it('renders nothing at all when the facts are not measurable', () => {
    const container = render(record({ styleFacts: { props: {} } }));
    expect(container.querySelector('.cdetails-style')).toBeNull();
  });

  it('drops a value that would smuggle markup instead of rendering it', () => {
    const container = render(record({
      styleFacts: { props: { 'background-color': '#3884ff', 'font-family': 'Pretendard<img src=x>' } },
    }));
    const html = container.innerHTML;
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
    // The offending row is dropped, not sanitized into something plausible.
    expect(rows(container).some(([label]) => label === 'Font family')).toBe(false);
    expect(rows(container)).toContainEqual(['Background color', '#3884ff']);
  });

  it('refuses facts carrying a property outside the allowlist', () => {
    const container = render(record({
      styleFacts: { props: { 'background-image': 'url(https://evil.test/x.png)' } },
    }));
    expect(container.querySelector('.cdetails-style')).toBeNull();
  });

  it('rejects an injected label instead of rendering it', () => {
    const container = render(record({
      styleFacts: { props: { display: 'flex' }, label: '<script>alert(1)</script>' },
    }));
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('alert(1)');
    expect(rows(container).some(([label]) => label === 'Label')).toBe(false);
  });

  it('renders an ordinary label as text', () => {
    const container = render(record({
      styleFacts: { props: { display: 'flex' }, label: '주문하기' },
    }));
    expect(rows(container)).toContainEqual(['Label', '주문하기']);
  });

  it('keeps the existing detail rows intact alongside the style section', () => {
    const container = render(record({ component: 'PrimaryButton', styleFacts: FACTS }));
    expect(rows(container).slice(0, 2)).toEqual([
      ['Component', 'PrimaryButton'],
      ['Tag', 'button'],
    ]);
  });
});

describe('ComponentDetails measured', () => {
  // The panel is where someone checks whether the tool knows. So a measurement
  // that could not be taken has to be visible as such: a blank row reads as
  // "no problem found", which is the one thing it must never mean.
  const FACTS = {
    props: {
      color: '#1e1e1e',
      'background-color': '#3884ff',
      'font-size': '14px',
      display: 'inline-flex',
    },
    geometry: { x: 24, y: 180, width: 120, height: 40 },
    tagName: 'button',
  };
  const PASS = { ratio: 4.54, min: 4.5, pass: true, large: false, background: '#3884ff' };

  /** The rows under the `Measured` heading, or [] when the group is absent. */
  function measured(container: HTMLElement): Array<[string, string]> {
    const heading = [...container.querySelectorAll('.cdetails-style-group-label')]
      .find((node) => node.textContent === 'Measured');
    if (heading === undefined) return [];
    return [...(heading.nextElementSibling?.querySelectorAll('.cdetails-row') ?? [])].map((row) => [
      row.querySelector('dt')?.textContent ?? '',
      row.querySelector('dd')?.textContent ?? '',
    ]);
  }

  it('renders a passing contrast with its ratio, threshold, and verdict', () => {
    const container = render(record({ styleFacts: { ...FACTS, derived: { contrast: PASS } } }));
    expect(measured(container)).toEqual([['Contrast', '4.54:1 · AA pass (min 4.5)']]);
    const contrast = measured(container)[0]?.[1] ?? '';
    expect(contrast).toContain('4.54:1');
    expect(contrast).toContain('AA pass');
    expect(contrast).toContain('min 4.5');
    expect(container.querySelector('.cdetails-style-group-label')?.textContent).toBe('Measured');
  });

  it('paints the swatch with the backdrop the ratio was measured against', () => {
    // The number only means something next to the colour it was computed
    // against, so the resolved backdrop travels with the verdict.
    const container = render(record({ styleFacts: { ...FACTS, derived: { contrast: PASS } } }));
    // jsdom normalizes the authored hex, so assert the paint rather than
    // pinning the serialization.
    const painted = [...container.querySelectorAll('.cdetails-swatch')]
      .map((node) => node.getAttribute('style') ?? '');
    expect(painted).toHaveLength(3);
    expect(painted.some((style) => style.toLowerCase().includes('rgb(56, 132, 255)'))).toBe(true);
  });

  it('renders a failing contrast as a failure', () => {
    const container = render(record({
      styleFacts: { ...FACTS, derived: { contrast: { ...PASS, ratio: 4.48, pass: false } } },
    }));
    const contrast = measured(container)[0]?.[1] ?? '';
    expect(contrast).toContain('4.48:1');
    expect(contrast).toContain('AA fail');
    expect(contrast).not.toContain('AA pass');
  });

  it('says an unmeasurable contrast was not measurable, instead of showing nothing', () => {
    // A backdrop of an image or a gradient has no ratio. Silence here is the
    // failure mode this row exists to prevent: the reader, and the model
    // downstream of the same fact, would both take the blank for "no problem".
    const container = render(record({ styleFacts: { ...FACTS, derived: { contrast: { unmeasurable: true } } } }));
    expect(measured(container)).toEqual([['Contrast', 'not measurable']]);
    expect(measured(container)[0]?.[1]).not.toMatch(/\d/);
    // Nothing to paint when there is no colour behind the text.
    expect(container.querySelectorAll('.cdetails-swatch')).toHaveLength(2);
  });

  it('renders truncation and font load as their own rows', () => {
    const container = render(record({
      styleFacts: { ...FACTS, derived: { contrast: PASS, truncated: true, fontLoad: 'fallback' } },
    }));
    expect(measured(container)).toEqual([
      ['Contrast', '4.54:1 · AA pass (min 4.5)'],
      ['Text', 'truncated'],
      ['Font load', 'fallback'],
    ]);
  });

  it('drops the whole Measured group when nothing was measured', () => {
    const container = render(record({ styleFacts: FACTS }));
    expect(measured(container)).toEqual([]);
    expect([...container.querySelectorAll('.cdetails-style-group-label')].map((node) => node.textContent))
      .not.toContain('Measured');
  });

  it('refuses a forged verdict rather than rendering it as a finding', () => {
    // The panel re-sanitizes what arrived over postMessage, so a hand-rolled
    // contrast claim on the page cannot appear here as a tool measurement.
    const container = render(record({
      styleFacts: { ...FACTS, derived: { contrast: { ...PASS, pass: 'yes' } } as never },
    }));
    expect(measured(container)).toEqual([]);
  });
});

/**
 * The cited source under the record it belongs to.
 *
 * The Location row says where the element is; this says what is written there,
 * so a person can judge the change against the code instead of against the
 * name of a file. The rules below are about when that block may appear at all:
 * only for a record the bridge located, only when the file could be read, and
 * never carrying a word about the failure when it could not.
 */
describe('ComponentDetails source block', () => {
  it('asks for nothing and shows nothing when the record carries no file', async () => {
    const container = render(record({ file: null, line: null }));
    await settle();
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('.cdetails-source')).toBeNull();
    expect(headings(container).some((label) => label.startsWith('Source'))).toBe(false);
  });

  it('quotes the file from its first line, numbering every line in turn', async () => {
    vi.stubGlobal('fetch', sourceRoute());
    const container = render(record());
    await settle();
    const block = container.querySelector('.cdetails-source');
    // The window starts one line above the cited line, and the heading says
    // where the quoted text begins rather than where the element was found.
    expect(block?.querySelector('h5')?.textContent).toBe('Source src/ui/Button.tsx:41');
    // The numbers are the only way a line means anything in a file, so they run
    // from the window's first line without a gap.
    expect([...container.querySelectorAll('.cdetails-source-no')].map((node) => node.textContent)).toEqual(
      ['41', '42', '43', '44'],
    );
    expect(
      [...container.querySelectorAll('.cdetails-source-text')].map((node) => node.textContent),
    ).toEqual(['// cited at line 42', 'export function Button() {', '  return <button />;', '}']);
  });

  it('stays silent when the file cannot be read', async () => {
    // Silence is the intended behaviour. The Location row already says where
    // the element is, and a block that said "unavailable" on every target whose
    // source is missing would be noise the reader learns to skip. Three
    // different files, because a refusal is remembered: a second look at the
    // same one would be answered from the cache rather than the route.
    const cases: Array<[string, () => Promise<Response>]> = [
      ['src/ui/Outside.tsx', async () => refused('outside-root')],
      ['src/ui/Unreadable.tsx', async () => refused('unreadable')],
      [
        'src/ui/NoSupervisor.tsx',
        () => {
          throw new Error('no supervisor');
        },
      ],
    ];
    for (const [file, responder] of cases) {
      vi.stubGlobal('fetch', vi.fn(responder));
      const container = render(record({ file, line: 3 }));
      await settle();
      expect(container.querySelector('.cdetails-source')).toBeNull();
      expect(headings(container).some((label) => label.startsWith('Source'))).toBe(false);
      // The failure itself is not reported either: the panel states what it
      // knows, not what it could not find out.
      expect(container.textContent).toContain('Location');
      expect(container.textContent).not.toMatch(/unavailable|not found|error/i);
    }
  });

  it('reads the source again for a record from a different file', async () => {
    const route = sourceRoute();
    vi.stubGlobal('fetch', route);
    const container = render(record());
    await settle();
    expect(route).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.cdetails-source h5')?.textContent).toBe(
      'Source src/ui/Button.tsx:41',
    );

    update(container, record({ file: 'src/ui/Card.tsx', line: 7 }));
    await settle();
    expect(route).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.cdetails-source h5')?.textContent).toBe(
      'Source src/ui/Card.tsx:6',
    );
    // The previous window is gone rather than left above the new one: two
    // blocks would read as two files, and only one of them is this record's.
    expect(container.querySelectorAll('.cdetails-source')).toHaveLength(1);
    expect(container.textContent).not.toContain('src/ui/Button.tsx:41');
  });

  it('does not read the same file twice when only the record object changed', async () => {
    const route = sourceRoute();
    vi.stubGlobal('fetch', route);
    const container = render(record());
    await settle();
    update(container, record({ styleFacts: { props: { display: 'flex' } } }));
    await settle();
    expect(route).toHaveBeenCalledTimes(1);
  });
});