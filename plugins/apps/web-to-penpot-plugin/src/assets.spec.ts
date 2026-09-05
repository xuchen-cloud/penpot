import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeEmbeddedRaster, rasterizeLeaf } from './assets.js';
import type { DesignNode } from './model.js';

describe('offline assets', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses file signatures and rejects SVG disguised as a raster image', () => {
    const unsafe = btoa(
      '<svg xmlns="http://www.w3.org/2000/svg"><script /></svg>',
    );
    const pngSignature = 'iVBORw0KGgo=';

    expect(
      decodeEmbeddedRaster({
        blob: {
          type: 'image/png',
          base64Blob: `data:image/png;base64,${unsafe}`,
        },
      }),
    ).toBeNull();
    expect(
      decodeEmbeddedRaster({
        blob: {
          type: 'application/octet-stream',
          base64Blob: `data:application/octet-stream;base64,${pngSignature}`,
        },
      }),
    ).toMatchObject({ mimeType: 'image/png' });
  });

  it('creates a local bitmap fallback without a snapshot thumbnail', async () => {
    const context = {
      scale: vi.fn(),
      filter: 'none',
      globalAlpha: 1,
      fillStyle: '',
      fillRect: vi.fn(),
      fillText: vi.fn(),
      createLinearGradient: vi.fn(),
      createRadialGradient: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback) => callback(new Blob([new Uint8Array([1, 2, 3])])),
    );
    const node: DesignNode = {
      id: 'filtered',
      name: 'Filtered leaf',
      kind: 'shape',
      rect: { x: 0, y: 0, width: 40, height: 20 },
      style: {
        fills: [{ type: 'solid', color: '#112233', opacity: 0.5 }],
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
    };

    const result = await rasterizeLeaf(node, new Map(), 'blur(2px)');

    expect(result).toMatchObject({ mimeType: 'image/png' });
    expect(context.filter).toBe('blur(2px)');
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 40, 20);
  });
});
