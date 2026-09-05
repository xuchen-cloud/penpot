import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSnapshot } from './normalize.js';

describe('normalizeSnapshot', () => {
  afterEach(() => vi.restoreAllMocks());
  it('preserves text, hierarchy and flex layout semantics', async () => {
    const document = await normalizeSnapshot({
      documentTitle: 'Account card',
      sourceUrl: 'https://example.invalid/account',
      root: {
        nodeType: 1,
        id: 'root',
        tag: 'DIV',
        rect: { x: 10, y: 20, width: 320, height: 80 },
        styles: {
          display: 'flex',
          flexDirection: 'row',
          gap: '12px',
          padding: '8px 16px',
          backgroundColor: 'rgb(255, 255, 255)',
        },
        childNodes: [
          {
            nodeType: 3,
            id: 'label',
            textContent: 'Hello',
            rect: { x: 26, y: 28, width: 50, height: 20 },
            styles: {
              color: 'rgb(10, 20, 30)',
              fontSize: '16px',
              lineHeight: '24px',
              flexGrow: '1',
            },
          },
        ],
      },
      assets: {},
    });

    expect(document.title).toBe('Account card');
    expect(document.root.kind).toBe('container');
    expect(document.root.layout).toMatchObject({
      mode: 'flex',
      direction: 'row',
      columnGap: 12,
      padding: { top: 8, right: 16, bottom: 8, left: 16 },
    });
    expect(document.root.children[0]).toMatchObject({
      kind: 'text',
      text: 'Hello',
      textStyle: { lineHeight: 1.5 },
      layoutItem: { grow: true },
    });
  });

  it('deduplicates embedded assets and refuses remote-only images', async () => {
    const png = 'data:application/octet-stream;base64,iVBORw0KGgo=';
    const document = await normalizeSnapshot({
      root: {
        nodeType: 1,
        tag: 'DIV',
        rect: { x: 0, y: 0, width: 300, height: 100 },
        childNodes: [
          {
            nodeType: 1,
            id: 'a',
            tag: 'IMG',
            rect: { x: 0, y: 0, width: 50, height: 50 },
            attributes: { src: 'asset:a' },
            childNodes: [],
          },
          {
            nodeType: 1,
            id: 'b',
            tag: 'IMG',
            rect: { x: 60, y: 0, width: 50, height: 50 },
            attributes: { src: 'asset:b' },
            childNodes: [],
          },
          {
            nodeType: 1,
            id: 'remote',
            tag: 'IMG',
            rect: { x: 120, y: 0, width: 50, height: 50 },
            attributes: { src: 'https://example.invalid/image.png' },
            childNodes: [],
          },
        ],
      },
      assets: {
        'asset:a': { blob: { type: 'image/png', base64Blob: png } },
        'asset:b': { blob: { type: 'image/png', base64Blob: png } },
      },
    });

    expect(document.assets).toHaveLength(1);
    expect(document.assets[0].mimeType).toBe('image/png');
    expect(document.root.children[0].assetId).toBe(
      document.root.children[1].assetId,
    );
    expect(document.root.children[2].assetId).toBeUndefined();
    expect(
      document.warnings.some((warning) => warning.code === 'missing-asset'),
    ).toBe(true);
  });

  it('imports inline raster backgrounds and reports remote backgrounds', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const document = await normalizeSnapshot({
      root: {
        nodeType: 1,
        tag: 'DIV',
        rect: { x: 0, y: 0, width: 100, height: 100 },
        childNodes: [
          {
            nodeType: 1,
            id: 'inline',
            tag: 'DIV',
            rect: { x: 0, y: 0, width: 40, height: 40 },
            styles: { backgroundImage: `url("${png}")` },
          },
          {
            nodeType: 1,
            id: 'remote',
            tag: 'DIV',
            rect: { x: 50, y: 0, width: 40, height: 40 },
            styles: {
              backgroundImage: 'url("https://example.invalid/image.png")',
            },
          },
        ],
      },
    });

    expect(document.assets).toHaveLength(1);
    expect(document.root.children[0].style.fills).toEqual([
      expect.objectContaining({ type: 'image' }),
    ]);
    expect(document.root.children[1].fallback).toBe('placeholder');
    expect(document.warnings).toContainEqual(
      expect.objectContaining({ code: 'missing-asset', nodeId: 'remote' }),
    );
  });

  it('includes pseudo-elements in their visual order and reports unsupported effects', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const document = await normalizeSnapshot({
      root: {
        nodeType: 1,
        tag: 'DIV',
        rect: { x: 0, y: 0, width: 100, height: 40 },
        pseudoElementNodes: {
          before: {
            nodeType: 3,
            id: 'before',
            text: 'Before',
            rect: { x: 0, y: 0, width: 40, height: 20 },
            styles: { filter: 'blur(2px)' },
          },
          after: {
            nodeType: 3,
            id: 'after',
            text: 'After',
            rect: { x: 60, y: 0, width: 40, height: 20 },
          },
        },
        childNodes: [
          {
            nodeType: 3,
            id: 'middle',
            text: 'Middle',
            rect: { x: 40, y: 0, width: 20, height: 20 },
          },
        ],
      },
      assets: {},
    });

    expect(document.root.children.map((node) => node.text)).toEqual([
      'Before',
      'Middle',
      'After',
    ]);
    expect(document.warnings).toContainEqual(
      expect.objectContaining({ code: 'unsupported-style', nodeId: 'before' }),
    );
  });

  it('maps grid tracks and child spans', async () => {
    const document = await normalizeSnapshot({
      root: {
        nodeType: 1,
        tag: 'DIV',
        rect: { x: 0, y: 0, width: 600, height: 300 },
        styles: {
          display: 'grid',
          gridTemplateColumns: '120px 1fr 25%',
          gridTemplateRows: 'auto 80px',
          gridTemplateAreas: '"header header header" "main main side"',
          columnGap: '16px',
          rowGap: '8px',
        },
        childNodes: [
          {
            nodeType: 1,
            id: 'cell',
            tag: 'DIV',
            rect: { x: 136, y: 0, width: 300, height: 80 },
            styles: {
              gridColumnStart: '2',
              gridColumnEnd: 'span 2',
              gridRowStart: '1',
              gridRowEnd: '2',
            },
            childNodes: [],
          },
          {
            nodeType: 1,
            id: 'area-cell',
            tag: 'DIV',
            rect: { x: 0, y: 80, width: 420, height: 80 },
            styles: { gridArea: 'main' },
            childNodes: [],
          },
        ],
      },
      assets: {},
    });

    expect(document.root.layout).toMatchObject({
      mode: 'grid',
      columns: [
        { type: 'fixed', value: 120 },
        { type: 'flex', value: 1 },
        { type: 'percent', value: 25 },
      ],
      rows: [{ type: 'auto' }, { type: 'fixed', value: 80 }],
    });
    expect(document.root.children[0].layoutItem).toMatchObject({
      column: 1,
      columnSpan: 2,
      row: 0,
      rowSpan: 1,
    });
    expect(document.root.children[1].layoutItem).toMatchObject({
      column: 0,
      columnSpan: 2,
      row: 1,
      rowSpan: 1,
      areaName: undefined,
    });
  });

  it('keeps an element with descendant text as a container', async () => {
    const document = await normalizeSnapshot({
      root: {
        nodeType: 1,
        tag: 'DIV',
        textContent: 'Nested label',
        rect: { x: 0, y: 0, width: 200, height: 40 },
        childNodes: [
          {
            nodeType: 1,
            tag: 'SPAN',
            textContent: 'Nested label',
            rect: { x: 0, y: 0, width: 100, height: 20 },
          },
        ],
      },
    });

    expect(document.root.kind).toBe('container');
    expect(document.root.children).toHaveLength(1);
    expect(document.root.children[0]).toMatchObject({
      kind: 'text',
      text: 'Nested label',
    });
  });

  it('normalizes text ranges and circular leaves', async () => {
    const document = await normalizeSnapshot({
      root: {
        nodeType: 1,
        tag: 'DIV',
        rect: { x: 0, y: 0, width: 200, height: 100 },
        childNodes: [
          {
            nodeType: 3,
            text: 'Hello world',
            rect: { x: 0, y: 0, width: 120, height: 20 },
            styles: { color: '#000000', fontSize: '16px' },
            textRuns: [
              {
                start: 6,
                end: 11,
                styles: { color: '#ff0000', fontWeight: '700' },
              },
            ],
          },
          {
            nodeType: 1,
            tag: 'DIV',
            rect: { x: 0, y: 30, width: 40, height: 40 },
            styles: { borderRadius: '50%' },
          },
        ],
      },
    });

    expect(document.root.children[0].textRuns).toEqual([
      expect.objectContaining({
        start: 6,
        end: 11,
        style: expect.objectContaining({ color: '#ff0000', fontWeight: '700' }),
      }),
    ]);
    expect(document.root.children[1].kind).toBe('ellipse');
  });

  it('rejects embedded SVG even when its declared type claims PNG', async () => {
    const svg = btoa(
      '<svg xmlns="http://www.w3.org/2000/svg"><script /></svg>',
    );
    const document = await normalizeSnapshot({
      root: {
        nodeType: 1,
        tag: 'IMG',
        rect: { x: 0, y: 0, width: 10, height: 10 },
        attributes: { src: 'asset:unsafe' },
      },
      assets: {
        'asset:unsafe': {
          blob: {
            type: 'image/png',
            base64Blob: `data:image/png;base64,${svg}`,
          },
        },
      },
    });

    expect(document.assets).toHaveLength(0);
    expect(document.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-node' }),
        expect.objectContaining({ code: 'missing-asset' }),
      ]),
    );
  });

  it('enforces the nesting depth limit', async () => {
    let node: Record<string, unknown> = {
      nodeType: 1,
      tag: 'DIV',
      rect: { x: 0, y: 0, width: 1, height: 1 },
    };
    for (let index = 0; index < 130; index += 1) {
      node = {
        nodeType: 1,
        tag: 'DIV',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        childNodes: [node],
      };
    }

    await expect(normalizeSnapshot({ root: node })).rejects.toThrow(
      'level limit',
    );
  });

  it('enforces the total node limit', async () => {
    const child = {
      nodeType: 1,
      tag: 'DIV',
      rect: { x: 0, y: 0, width: 1, height: 1 },
    };
    const root = {
      ...child,
      childNodes: Array.from({ length: 20_001 }, () => child),
    };

    await expect(normalizeSnapshot({ root })).rejects.toThrow('node limit');
  });

  it('orders siblings by z-index while preserving ties', async () => {
    const child = (id: string, zIndex: string) => ({
      nodeType: 1,
      id,
      tag: 'DIV',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      styles: { zIndex },
    });
    const document = await normalizeSnapshot({
      root: {
        nodeType: 1,
        tag: 'DIV',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        childNodes: [
          child('front', '2'),
          child('back-a', '0'),
          child('back-b', '0'),
        ],
      },
    });

    expect(document.root.children.map((node) => node.id)).toEqual([
      'back-a',
      'back-b',
      'front',
    ]);
  });
});
