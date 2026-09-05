import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportDocument, ImportResult } from './model.js';
import {
  ImportCancelledError,
  renderDocument,
  type RenderOptions,
} from './renderer.js';

vi.mock('./renderer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./renderer.js')>();
  return { ...actual, renderDocument: vi.fn() };
});

const renderMock = vi.mocked(renderDocument);

function documentFixture(): ImportDocument {
  return {
    protocol: 'h2d-v1',
    title: 'Test',
    assets: [],
    warnings: [],
    stats: { nodeCount: 1, assetCount: 0 },
    root: {
      id: 'root',
      name: 'Test',
      kind: 'container',
      rect: { x: 0, y: 0, width: 1, height: 1 },
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

const result: ImportResult = {
  title: 'Test',
  createdNodes: 1,
  durationMs: 1,
  warnings: [],
  fontSubstitutions: [],
  layoutFallbacks: [],
};

describe('plugin message controller', () => {
  let receive!: (message: { type: string; document?: ImportDocument }) => void;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    renderMock.mockReset();
    sendMessage = vi.fn();
    Object.defineProperty(globalThis, 'penpot', {
      configurable: true,
      value: {
        version: '2.17.4',
        flags: { naturalChildOrdering: false },
        ui: {
          open: vi.fn(),
          sendMessage,
          onMessage: vi.fn((handler) => {
            receive = handler;
          }),
        },
      },
    });
    await import('./plugin.js');
  });

  it('pins natural child ordering for predictable z-index output', () => {
    expect(penpot.flags.naturalChildOrdering).toBe(true);
  });

  it('reports the supported Penpot version after the UI handshake', () => {
    receive({ type: 'ui-ready' });

    expect(sendMessage).toHaveBeenCalledWith(
      {
        type: 'ready',
        penpotVersion: '2.17.4',
        supported: true,
      },
      true,
    );
  });

  it('ignores a second import while one is in progress', async () => {
    let finish!: (result: ImportResult) => void;
    renderMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const document = documentFixture();

    receive({ type: 'import', document });
    receive({ type: 'import', document });
    expect(renderMock).toHaveBeenCalledOnce();
    finish(result);
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        { type: 'complete', result },
        true,
      ),
    );
  });

  it('passes cancellation to the renderer and reports cleanup', async () => {
    let options!: RenderOptions;
    let observedCancellation = false;
    renderMock.mockImplementation(async (_document, nextOptions) => {
      options = nextOptions;
      await Promise.resolve();
      observedCancellation = options.isCancelled();
      if (observedCancellation) throw new ImportCancelledError();
      return result;
    });

    receive({ type: 'import', document: documentFixture() });
    receive({ type: 'cancel' });

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({ type: 'cancelled' }, true),
    );
    expect(observedCancellation).toBe(true);
  });

  it('returns renderer errors to the UI', async () => {
    renderMock.mockRejectedValue(new Error('render failed'));

    receive({ type: 'import', document: documentFixture() });

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        { type: 'error', message: 'render failed' },
        true,
      ),
    );
  });
});
