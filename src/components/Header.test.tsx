import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Header, type HeaderProps, type ViewportPreset } from './Header.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function render(element: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

function click(target: Element | null | undefined): void {
  act(() => {
    (target as HTMLElement | null)?.click();
  });
}

function props(overrides: Partial<HeaderProps> = {}): HeaderProps {
  return {
    status: 'connected',
    ready: true,
    frozen: true,
    mode: 'html',
    onModeChange: vi.fn(),
    onToggleFreeze: vi.fn(),
    onReconnect: vi.fn(),
    onCopyAgent: vi.fn(),
    canCopyAgent: true,
    copied: false,
    onOpenSessions: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenMore: vi.fn(),
    sessionCount: 2,
    ...overrides,
  };
}

function preset(container: HTMLElement, label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`.viewport-btn[aria-label^="${label}"]`);
}

describe('Header viewport presets', () => {
  it('renders a compact group and reports the selected preset', () => {
    const onViewportChange = vi.fn();
    const container = render(
      <Header {...props({ viewport: 'tablet', onViewportChange })} />,
    );

    const group = container.querySelector('.topgroup[aria-label="Viewport preset"]');
    expect(group).not.toBeNull();
    expect(container.querySelectorAll('.viewport-btn')).toHaveLength(3);
    expect(preset(container, 'Tablet')?.getAttribute('aria-pressed')).toBe('true');
    expect(preset(container, 'Desktop')?.getAttribute('aria-pressed')).toBe('false');
    expect(preset(container, 'Mobile')?.getAttribute('title')).toContain('390×844');

    click(preset(container, 'Mobile'));
    expect(onViewportChange).toHaveBeenCalledWith('mobile' satisfies ViewportPreset);
  });

  it('locks the group until the target is ready', () => {
    const container = render(
      <Header {...props({ ready: false, onViewportChange: vi.fn() })} />,
    );
    for (const button of container.querySelectorAll<HTMLButtonElement>('.viewport-btn')) {
      expect(button.disabled).toBe(true);
    }
    const locked = render(<Header {...props({ viewportDisabled: true, onViewportChange: vi.fn() })} />);
    for (const button of locked.querySelectorAll<HTMLButtonElement>('.viewport-btn')) {
      expect(button.disabled).toBe(true);
    }
  });

  it('is omitted when no handler is supplied', () => {
    const container = render(<Header {...props({ viewport: 'mobile' })} />);
    expect(container.querySelector('.topgroup[aria-label="Viewport preset"]')).toBeNull();
  });
});

describe('Header preview group', () => {
  it('reports the active preview count and resets them', () => {
    const onResetPreviews = vi.fn();
    const container = render(
      <Header {...props({ previewCount: 1, onResetPreviews })} />,
    );
    const pill = container.querySelector('.preview-pill');
    expect(pill?.textContent).toContain('1 preview');
    expect(pill?.getAttribute('role')).toBe('status');
    const reset = container.querySelector<HTMLButtonElement>('.preview-reset');
    expect(reset?.disabled).toBe(false);
    click(reset);
    expect(onResetPreviews).toHaveBeenCalledTimes(1);
  });

  it('disables reset with no previews and pluralizes the count', () => {
    const container = render(
      <Header {...props({ previewCount: 0, onResetPreviews: vi.fn() })} />,
    );
    expect(container.querySelector('.preview-pill')?.textContent).toContain('0 previews');
    expect(container.querySelector<HTMLButtonElement>('.preview-reset')?.disabled).toBe(true);

    const several = render(<Header {...props({ previewCount: 3 })} />);
    expect(several.querySelector('.preview-pill')?.textContent).toContain('3 previews');
    expect(several.querySelector<HTMLButtonElement>('.preview-reset')?.disabled).toBe(true);
  });

  it('is omitted when neither prop is supplied', () => {
    const container = render(<Header {...props()} />);
    expect(container.querySelectorAll('.topgroup')).toHaveLength(0);
  });
});

describe('Header existing controls', () => {
  it('keeps the status, freeze, mode, and drawer buttons intact', () => {
    const onToggleFreeze = vi.fn();
    const onModeChange = vi.fn();
    const onOpenSessions = vi.fn();
    const container = render(
      <Header {...props({ onToggleFreeze, onModeChange, onOpenSessions, previewCount: 1 })} />,
    );
    expect(container.querySelector('.statusline .pill')?.textContent).toContain('Connected');
    const select = container.querySelector<HTMLSelectElement>('select');
    expect(select?.getAttribute('aria-label')).toBe('Inspector mode');
    expect(select?.value).toBe('html');
    act(() => {
      if (!select) return;
      select.value = 'konva';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onModeChange).toHaveBeenCalledWith('konva');

    click(container.querySelector('[aria-label="Sessions"]'));
    expect(onOpenSessions).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.brand-name')?.textContent).toBe('Design Inspector');
  });
});
