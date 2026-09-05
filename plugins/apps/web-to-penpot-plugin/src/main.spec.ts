import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportDocument } from './model.js';
import { normalizeSnapshot } from './normalize.js';

vi.mock('./normalize.js', () => ({ normalizeSnapshot: vi.fn() }));

const normalizeMock = vi.mocked(normalizeSnapshot);

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes));
}

function envelope(title: string): string {
  return `<!--(figmeta)${encode({ dataType: 'h2d', h2d: { v: 1 } })}(/figmeta)--><!--(figh2d)${encode({ root: {}, title })}(/figh2d)-->`;
}

function documentFixture(title: string): ImportDocument {
  return {
    protocol: 'h2d-v1',
    title,
    assets: [],
    warnings: [],
    stats: { nodeCount: 1, assetCount: 0 },
    root: {
      id: 'root',
      name: title,
      kind: 'container',
      rect: { x: 0, y: 0, width: 100, height: 80 },
      style: {
        fills: [],
        borders: {},
        radius: { top: 0, right: 0, bottom: 0, left: 0 },
        opacity: 1,
        rotation: 0,
        shadows: [],
        overflowHidden: false,
      },
      layoutItem: {
        absolute: false,
        zIndex: 0,
        horizontalSizing: 'fix',
        verticalSizing: 'fix',
        alignSelf: 'auto',
      },
      children: [],
    },
  };
}

function installUi(): void {
  document.body.innerHTML = `
    <button id="read"></button><div id="paste-zone" tabindex="0"></div>
    <p id="status"></p><section id="preview" class="hidden"></section>
    <section id="progress-card" class="hidden"></section><progress id="progress"></progress>
    <section id="result" class="hidden"></section><button id="import" disabled></button>
    <button id="clear"></button><button id="cancel"></button><button id="download"></button>
    <span id="title"></span><span id="nodes"></span><span id="assets"></span>
    <span id="warnings"></span><span id="size"></span><span id="version"></span>
    <span id="progress-label"></span><span id="result-summary"></span><pre id="report"></pre>
  `;
}

function paste(html: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/html' ? html : '') },
  });
  document.getElementById('paste-zone')!.dispatchEvent(event);
}

describe('plugin UI', () => {
  beforeEach(async () => {
    vi.resetModules();
    normalizeMock.mockReset();
    installUi();
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    await import('./main.js');
  });

  it('focuses the manual paste fallback when clipboard access is unavailable', async () => {
    document.getElementById('read')!.click();

    await vi.waitFor(() =>
      expect(document.activeElement?.id).toBe('paste-zone'),
    );
    expect(document.getElementById('status')!.textContent).toContain(
      '使用下方粘贴区域',
    );
  });

  it('keeps import disabled outside Penpot 2.17', () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'ready', penpotVersion: '2.18.0', supported: false },
      }),
    );
    expect(
      (document.getElementById('import') as HTMLButtonElement).disabled,
    ).toBe(true);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'ready', penpotVersion: '2.17.4', supported: true },
      }),
    );
    expect(
      (document.getElementById('import') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('does not let an older slow paste overwrite a newer preview', async () => {
    let resolveFirst!: (document: ImportDocument) => void;
    normalizeMock.mockImplementation((snapshot) => {
      const title = String((snapshot as { title?: string }).title);
      if (title === 'first')
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      return Promise.resolve(documentFixture(title));
    });

    paste(envelope('first'));
    paste(envelope('second'));
    await vi.waitFor(() =>
      expect(document.getElementById('title')!.textContent).toBe('second'),
    );
    resolveFirst(documentFixture('first'));
    await Promise.resolve();

    expect(document.getElementById('title')!.textContent).toBe('second');
  });

  it('does not let a slow clipboard read overwrite a newer manual paste', async () => {
    let finishRead!: (items: ClipboardItems) => void;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        read: vi.fn(
          () =>
            new Promise<ClipboardItems>((resolve) => {
              finishRead = resolve;
            }),
        ),
      },
    });
    normalizeMock.mockImplementation((snapshot) =>
      Promise.resolve(
        documentFixture(String((snapshot as { title?: string }).title)),
      ),
    );

    document.getElementById('read')!.click();
    paste(envelope('manual'));
    await vi.waitFor(() =>
      expect(document.getElementById('title')!.textContent).toBe('manual'),
    );
    finishRead([
      {
        types: ['text/html'],
        presentationStyle: 'unspecified',
        getType: vi.fn(async () => new Blob([envelope('clipboard')])),
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('title')!.textContent).toBe('manual');
  });

  it('sends import and cancel messages and renders a completion report', async () => {
    normalizeMock.mockResolvedValue(documentFixture('ready'));
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'ready', penpotVersion: '2.17.4', supported: true },
      }),
    );
    paste(envelope('ready'));
    await vi.waitFor(() =>
      expect(document.getElementById('title')!.textContent).toBe('ready'),
    );

    document.getElementById('import')!.click();
    document.getElementById('cancel')!.click();
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'import' }),
      '*',
    );
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      { type: 'cancel' },
      '*',
    );

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'complete',
          result: {
            title: 'ready',
            createdNodes: 1,
            durationMs: 2,
            warnings: [],
            fontSubstitutions: [],
            layoutFallbacks: [],
          },
        },
      }),
    );
    expect(document.getElementById('result-summary')!.textContent).toContain(
      '1 个图层',
    );
  });
});
