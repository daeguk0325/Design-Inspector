import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CitationSnapshot } from '../state/models.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function render(content: string): string {
  return renderToStaticMarkup(<MarkdownMessage content={content} />);
}

function mount(element: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

function citation(overrides: Partial<CitationSnapshot> = {}): CitationSnapshot {
  return {
    selectionId: 'sel-1',
    elementKey: 'html:testid:cta',
    component: 'PrimaryButton',
    file: 'src/ui/Button.tsx',
    line: 42,
    mode: 'html',
    displayNumber: 1,
    ...overrides,
  };
}

describe('MarkdownMessage', () => {
  it('renders markdown, hard breaks, and fenced code', () => {
    const html = render('**bold**\nnext\n\n```ts\nconst x = 1;\n```');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<br');
    expect(html).toContain('<pre>');
    expect(html).toContain('const x = 1;');
  });

  it('renders display math', () => {
    const html = render('$$x^2 + y^2$$');
    expect(html).toContain('katex');
  });

  it('drops raw html and unsafe links', () => {
    const html = render('<script>alert(1)</script> [open](javascript:alert(1))');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('href="javascript:');
  });

  it('blocks remote markdown images', () => {
    const html = render('![tracker](https://example.com/pixel.png)');
    expect(html).not.toContain('src="https://example.com/pixel.png"');
    expect(html).toContain('Image blocked');
  });

  it('marks safe external links', () => {
    const html = render('[docs](https://example.com/docs)');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});

describe('MarkdownMessage citation markers', () => {
  it('renders a marker the answer can resolve as a chip', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage content="padding of ({1}) is tight" citations={[citation()]} />,
    );
    expect(html).toContain('cite-inline');
    expect(html).toContain('data-number="1"');
    expect(html).toContain('PrimaryButton');
    expect(html).not.toContain('({1})');
  });

  it('leaves a marker the answer cannot resolve as text', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage content="quoted ({7}) from the request" citations={[citation()]} />,
    );
    expect(html).not.toContain('cite-inline');
    expect(html).toContain('({7})');
  });

  it('leaves markers alone with no citations at all', () => {
    expect(render('the user wrote ({1}) themselves')).toContain('({1})');
  });

  it('never puts a chip inside code', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        content={'```ts\nconst ref = "({1})";\n```\n\ninline `({2})` is code too\n\nbut ({3}) here is prose'}
        citations={[
          citation(),
          citation({ selectionId: 'sel-2', component: 'Card', displayNumber: 2 }),
          citation({ selectionId: 'sel-3', component: 'Stage', displayNumber: 3 }),
        ]}
      />,
    );
    // Three markers exist: two in code, one in prose. Only the prose one is a chip.
    expect(html.match(/cite-inline-btn/g) ?? []).toHaveLength(1);
    expect(html).toContain('const ref = &quot;({1})&quot;;');
    expect(html).toContain('<code class="language-ts">');
  });

  it('resolves markers inside a list and a table cell', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        content={'- tighten ({1})\n- loosen ({2})\n\n| part | note |\n|---|---|\n| gap | see ({1}) |'}
        citations={[citation(), citation({ selectionId: 'sel-2', component: 'Card', displayNumber: 2 })]}
      />,
    );
    expect(html.match(/cite-inline-btn/g) ?? []).toHaveLength(3);
  });

  it('asks the target to re-select when a chip is clicked', () => {
    const onCite = vi.fn();
    const container = mount(
      <MarkdownMessage content="see ({1})" citations={[citation()]} onCite={onCite} />,
    );
    const chip = container.querySelector<HTMLButtonElement>('.cite-inline-btn');
    expect(chip).not.toBeNull();
    act(() => {
      chip?.click();
    });
    expect(onCite).toHaveBeenCalledWith('sel-1');
  });

  it('disables the chip when there is nothing to select with', () => {
    const container = mount(<MarkdownMessage content="see ({1})" citations={[citation()]} />);
    expect(container.querySelector<HTMLButtonElement>('.cite-inline-btn')?.disabled).toBe(true);
  });
});
