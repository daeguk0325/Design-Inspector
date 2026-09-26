import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { SelectionRecord } from '../protocol/types.ts';
import { ComponentDetails } from './ComponentDetails.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function render(record: SelectionRecord): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ComponentDetails record={record} />));
  mounted.push({ root, container });
  return container;
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