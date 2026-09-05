import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportDocument } from './model.js';
import { ImportCancelledError, renderDocument } from './renderer.js';

interface FakeShape {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  characters: string;
  children: FakeShape[];
  fills: unknown[];
  strokes: unknown[];
  shadows: unknown[];
  opacity: number;
  rotation: number;
  blendMode: string;
  borderRadiusTopLeft: number;
  borderRadiusTopRight: number;
  borderRadiusBottomRight: number;
  borderRadiusBottomLeft: number;
  clipContent: boolean;
  layoutChild: Record<string, unknown>;
  layoutCell: Record<string, unknown>;
  flex?: { remove: ReturnType<typeof vi.fn> };
  grid?: {
    remove: ReturnType<typeof vi.fn>;
    addRow: ReturnType<typeof vi.fn>;
    addColumn: ReturnType<typeof vi.fn>;
  };
  resize(width: number, height: number): void;
  appendChild(child: FakeShape): void;
  remove: ReturnType<typeof vi.fn>;
  addFlexLayout(): Record<string, unknown>;
  addGridLayout(): Record<string, unknown>;
  waitForLayoutUpdate: ReturnType<typeof vi.fn>;
  getRange(start: number, end: number): Record<string, unknown>;
}

function fakeShape(type: string, characters = ''): FakeShape {
  const shape: FakeShape = {
    id: crypto.randomUUID(),
    type,
    name: '',
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    characters,
    children: [] as FakeShape[],
    fills: [] as unknown[],
    strokes: [] as unknown[],
    shadows: [] as unknown[],
    opacity: 1,
    rotation: 0,
    blendMode: 'normal',
    borderRadiusTopLeft: 0,
    borderRadiusTopRight: 0,
    borderRadiusBottomRight: 0,
    borderRadiusBottomLeft: 0,
    clipContent: false,
    layoutChild: {
      absolute: false,
      zIndex: 0,
      horizontalSizing: 'fix',
      verticalSizing: 'fix',
      alignSelf: 'auto',
    },
    layoutCell: {},
    resize(width: number, height: number) {
      this.width = width;
      this.height = height;
    },
    appendChild(child: FakeShape) {
      this.children.push(child);
    },
    remove: vi.fn(async () => undefined),
    addFlexLayout() {
      const layout = { remove: vi.fn() };
      Object.assign(this, { flex: layout });
      return layout;
    },
    addGridLayout() {
      const layout = { addRow: vi.fn(), addColumn: vi.fn(), remove: vi.fn() };
      Object.assign(this, { grid: layout });
      return layout;
    },
    waitForLayoutUpdate: vi.fn(async () => undefined),
    getRange(start: number, end: number) {
      return {
        shape: this,
        characters: this.characters.slice(start, end),
        fills: [],
      };
    },
  };
  return shape;
}

function documentFixture(): ImportDocument {
  const baseStyle = {
    fills: [],
    borders: {
      top: undefined,
      right: undefined,
      bottom: undefined,
      left: undefined,
    },
    radius: { top: 0, right: 0, bottom: 0, left: 0 },
    opacity: 1,
    rotation: 0,
    shadows: [],
    overflowHidden: false,
  };
  const item = {
    absolute: false,
    zIndex: 0,
    horizontalSizing: 'fix' as const,
    verticalSizing: 'fix' as const,
    alignSelf: 'auto' as const,
  };
  return {
    protocol: 'h2d-v1',
    title: 'Test page',
    assets: [],
    warnings: [],
    stats: { nodeCount: 2, assetCount: 0 },
    root: {
      id: 'root',
      name: 'Test page',
      kind: 'container',
      rect: { x: 0, y: 0, width: 300, height: 200 },
      style: baseStyle,
      layoutItem: item,
      children: [
        {
          id: 'text',
          name: 'Greeting',
          kind: 'text',
          rect: { x: 20, y: 30, width: 100, height: 24 },
          style: baseStyle,
          layoutItem: item,
          text: 'Hello',
          textStyle: {
            fontFamily: 'Missing Font',
            fontSize: 16,
            fontWeight: '400',
            fontStyle: 'normal',
            lineHeight: 1.25,
            letterSpacing: 0,
            color: '#112233',
            colorOpacity: 1,
            align: 'left',
            verticalAlign: 'top',
            decoration: null,
            transform: null,
            direction: 'ltr',
          },
          children: [],
        },
      ],
    },
  };
}

function nestedLayoutFixture(): ImportDocument {
  const document = documentFixture();
  const original = document.root.children[0];
  document.stats.nodeCount = 3;
  document.root.children = [
    {
      id: 'layout',
      name: 'Nested flex',
      kind: 'container',
      rect: { x: 10, y: 10, width: 200, height: 80 },
      style: document.root.style,
      layoutItem: document.root.layoutItem,
      layout: {
        mode: 'flex',
        direction: 'row',
        wrap: 'nowrap',
        alignItems: 'start',
        alignContent: 'start',
        justifyContent: 'start',
        rowGap: 0,
        columnGap: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
      },
      children: [
        {
          ...original,
          rect: { x: 20, y: 20, width: 100, height: 24 },
        },
      ],
    },
  ];
  return document;
}

function installFakePenpot() {
  const roots: FakeShape[] = [];
  const begin = vi.fn(() => Symbol('undo'));
  const finish = vi.fn();
  const inter = {
    fontFamily: 'Inter',
    applyToText: vi.fn(),
    applyToRange: vi.fn(),
  };
  const context = {
    createBoard: vi.fn(() => {
      const shape = fakeShape('board');
      roots.push(shape);
      return shape;
    }),
    createRectangle: vi.fn(() => fakeShape('rect')),
    createEllipse: vi.fn(() => fakeShape('ellipse')),
    createText: vi.fn((text: string) => fakeShape('text', text)),
    createShapeFromSvgWithImages: vi.fn(async (): Promise<FakeShape | null> =>
      fakeShape('group'),
    ),
    uploadMediaData: vi.fn(async () => ({ id: 'media' })),
    waitForLayoutUpdate: vi.fn(async () => undefined),
    history: { undoBlockBegin: begin, undoBlockFinish: finish },
    viewport: { center: { x: 500, y: 400 }, zoomIntoView: vi.fn() },
    fonts: {
      all: [inter],
      findByName: vi.fn((name: string) => (name === 'Inter' ? inter : null)),
    },
    selection: [],
  };
  Object.defineProperty(globalThis, 'penpot', {
    configurable: true,
    value: context,
  });
  return { context, roots, begin, finish };
}

describe('renderDocument', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates editable hierarchy as one undo block and reports font substitution', async () => {
    const { context, roots, begin, finish } = installFakePenpot();
    const result = await renderDocument(documentFixture(), {
      isCancelled: () => false,
      onProgress: vi.fn(),
    });

    expect(roots[0].children).toHaveLength(1);
    expect(roots[0].children[0]).toMatchObject({
      type: 'text',
      characters: 'Hello',
      fills: [{ fillColor: '#112233', fillOpacity: 1 }],
    });
    expect(context.selection).toEqual([roots[0]]);
    expect(begin).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
    expect(result.fontSubstitutions).toEqual([
      { requested: 'Missing Font', used: 'Inter' },
    ]);
  });

  it('removes partial content and closes the undo block when cancelled', async () => {
    const { roots, finish } = installFakePenpot();

    await expect(
      renderDocument(documentFixture(), {
        isCancelled: () => true,
        onProgress: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(ImportCancelledError);

    expect(roots[0].remove).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });

  it('creates ellipse layers and applies styles to text ranges', async () => {
    const { context } = installFakePenpot();
    const document = documentFixture();
    document.stats.nodeCount = 3;
    document.root.children[0].textRuns = [
      {
        start: 1,
        end: 4,
        style: {
          ...document.root.children[0].textStyle!,
          color: '#FF0000',
          fontWeight: '700',
        },
      },
    ];
    document.root.children.push({
      id: 'ellipse',
      name: 'Avatar',
      kind: 'ellipse',
      rect: { x: 140, y: 20, width: 40, height: 40 },
      style: document.root.style,
      layoutItem: document.root.layoutItem,
      children: [],
    });

    await renderDocument(document, {
      isCancelled: () => false,
      onProgress: vi.fn(),
    });

    expect(context.createEllipse).toHaveBeenCalledOnce();
    expect(context.fonts.all[0].applyToRange).toHaveBeenCalledOnce();
  });

  it('uploads embedded media and uses a placeholder when upload fails', async () => {
    const { context, roots } = installFakePenpot();
    const document = documentFixture();
    document.assets = [
      {
        id: 'asset-1',
        name: 'photo.png',
        mimeType: 'image/png',
        data: new Uint8Array([1, 2, 3]),
        hash: 'hash',
      },
    ];
    document.root.children[0] = {
      ...document.root.children[0],
      kind: 'image',
      text: undefined,
      textStyle: undefined,
      assetId: 'asset-1',
    };
    context.uploadMediaData.mockRejectedValueOnce(new Error('bad image'));

    const result = await renderDocument(document, {
      isCancelled: () => false,
      onProgress: vi.fn(),
    });

    expect(context.uploadMediaData).toHaveBeenCalledWith(
      'photo.png',
      document.assets[0].data,
      'image/png',
    );
    expect(roots[0].children[0].type).toBe('rect');
    expect(roots[0].children[0].fills).toEqual([
      { fillColor: '#E5E7EB', fillOpacity: 1 },
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing-asset' }),
      ]),
    );
  });

  it('reports a placeholder when Penpot rejects an SVG shape', async () => {
    const { context, roots } = installFakePenpot();
    const document = documentFixture();
    document.root.children[0] = {
      ...document.root.children[0],
      kind: 'svg',
      text: undefined,
      textStyle: undefined,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>',
    };
    context.createShapeFromSvgWithImages.mockResolvedValueOnce(null);

    const result = await renderDocument(document, {
      isCancelled: () => false,
      onProgress: vi.fn(),
    });

    expect(roots[0].children[0].fills).toEqual([
      { fillColor: '#E5E7EB', fillOpacity: 1 },
    ]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'invalid-node', nodeId: 'text' }),
    );
  });

  it('validates a nested layout even when its parent has no layout', async () => {
    const { roots } = installFakePenpot();

    await renderDocument(nestedLayoutFixture(), {
      isCancelled: () => false,
      onProgress: vi.fn(),
    });

    expect(roots[0].children[0].waitForLayoutUpdate).toHaveBeenCalledOnce();
  });

  it('maps flex growth to the parent main axis', async () => {
    const { roots } = installFakePenpot();
    const document = nestedLayoutFixture();
    const layoutNode = document.root.children[0];
    if (layoutNode.layout?.mode !== 'flex') throw new Error('Expected flex');
    layoutNode.layout.direction = 'column';
    layoutNode.children[0].layoutItem.grow = true;

    await renderDocument(document, {
      isCancelled: () => false,
      onProgress: vi.fn(),
    });

    expect(roots[1].children[0].layoutChild.verticalSizing).toBe('fill');
    expect(roots[1].children[0].layoutChild.horizontalSizing).toBe('fix');
  });

  it('falls back only the layout whose child geometry drifts', async () => {
    const { context, roots } = installFakePenpot();
    context.createBoard.mockImplementation(() => {
      const shape = fakeShape('board');
      roots.push(shape);
      if (roots.length === 2) {
        shape.waitForLayoutUpdate.mockImplementationOnce(async () => {
          shape.children[0].x += 20;
        });
      }
      return shape;
    });

    const result = await renderDocument(nestedLayoutFixture(), {
      isCancelled: () => false,
      onProgress: vi.fn(),
    });

    expect(roots[1].flex?.remove).toHaveBeenCalledOnce();
    expect(result.layoutFallbacks).toEqual(['Nested flex']);
    expect(roots[1].children[0].x).toBe(500 - 150 + 20);
  });

  it('cancels and removes the root when cancellation arrives during layout wait', async () => {
    const { context, roots } = installFakePenpot();
    let cancelled = false;
    context.createBoard.mockImplementation(() => {
      const shape = fakeShape('board');
      roots.push(shape);
      if (roots.length === 2) {
        shape.waitForLayoutUpdate.mockImplementationOnce(async () => {
          cancelled = true;
        });
      }
      return shape;
    });

    await expect(
      renderDocument(nestedLayoutFixture(), {
        isCancelled: () => cancelled,
        onProgress: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(ImportCancelledError);
    expect(roots[0].remove).toHaveBeenCalledOnce();
  });

  it('configures grid tracks and renders sanitized SVG and uneven borders', async () => {
    const { context, roots } = installFakePenpot();
    const document = documentFixture();
    document.stats.nodeCount = 3;
    document.root.layout = {
      mode: 'grid',
      columns: [
        { type: 'fixed', value: 100 },
        { type: 'flex', value: 1 },
      ],
      rows: [{ type: 'auto' }],
      areas: {},
      alignItems: 'stretch',
      justifyItems: 'start',
      rowGap: 4,
      columnGap: 8,
      padding: { top: 1, right: 2, bottom: 3, left: 4 },
    };
    document.root.children = [
      {
        ...document.root.children[0],
        id: 'svg',
        kind: 'svg',
        text: undefined,
        textStyle: undefined,
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>',
        layoutItem: {
          ...document.root.layoutItem,
          row: 0,
          column: 1,
          columnSpan: 1,
        },
      },
      {
        id: 'bordered',
        name: 'Bordered',
        kind: 'shape',
        rect: { x: 150, y: 30, width: 100, height: 40 },
        style: {
          ...document.root.style,
          borders: {
            top: {
              width: 2,
              color: '#FF0000',
              opacity: 1,
              style: 'solid',
            },
          },
        },
        layoutItem: document.root.layoutItem,
        children: [],
      },
    ];

    await renderDocument(document, {
      isCancelled: () => false,
      onProgress: vi.fn(),
    });

    expect(context.createShapeFromSvgWithImages).toHaveBeenCalledWith(
      document.root.children[0].svg,
    );
    expect(roots[0].grid?.addColumn).toHaveBeenNthCalledWith(1, 'fixed', 100);
    expect(roots[0].grid?.addColumn).toHaveBeenNthCalledWith(2, 'flex', 1);
    expect(roots[0].grid?.addRow).toHaveBeenCalledWith('auto', undefined);
    expect(roots[0].children[0].layoutCell).toMatchObject({
      position: 'manual',
      row: 0,
      column: 1,
    });
    expect(
      roots[0].children[1].children.some((child) =>
        child.name.endsWith('top border'),
      ),
    ).toBe(true);
  });
});
