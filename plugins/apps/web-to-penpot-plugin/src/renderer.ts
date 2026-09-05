import type {
  Board,
  Fill,
  Gradient,
  Group,
  ImageData,
  Shape,
  Text,
  TextRange,
  TrackType,
} from '@penpot/plugin-types';
import type {
  Border,
  DesignNode,
  ImportDocument,
  ImportResult,
  ImportWarning,
  Layout,
  Paint,
} from './model.js';

export class ImportCancelledError extends Error {
  constructor() {
    super('Import cancelled');
    this.name = 'ImportCancelledError';
  }
}

export type RenderOptions = {
  isCancelled: () => boolean;
  onProgress: (completed: number, total: number, label: string) => void;
};

type RenderState = {
  document: ImportDocument;
  options: RenderOptions;
  media: Map<string, ImageData>;
  warnings: ImportWarning[];
  fontSubstitutions: Array<{ requested: string; used: string }>;
  layoutFallbacks: string[];
  shapes: Map<string, Shape>;
  created: number;
  rootOffset: { x: number; y: number };
};

function checkCancelled(state: RenderState): void {
  if (state.options.isCancelled()) throw new ImportCancelledError();
}

function angleGradient(paint: Extract<Paint, { type: 'gradient' }>): Gradient {
  const radians = ((paint.angle - 90) * Math.PI) / 180;
  const dx = Math.cos(radians) / 2;
  const dy = Math.sin(radians) / 2;
  return {
    type: paint.gradientType,
    startX: 0.5 - dx,
    startY: 0.5 - dy,
    endX: 0.5 + dx,
    endY: 0.5 + dy,
    width: 1,
    stops: paint.stops,
  };
}

function fills(node: DesignNode, media: Map<string, ImageData>): Fill[] {
  const result = node.style.fills.flatMap((paint): Fill[] => {
    if (paint.type === 'solid')
      return [{ fillColor: paint.color, fillOpacity: paint.opacity }];
    if (paint.type === 'gradient')
      return [{ fillColorGradient: angleGradient(paint) }];
    const image = media.get(paint.assetId);
    return image ? [{ fillImage: image, fillOpacity: paint.opacity }] : [];
  });
  const primaryImage = node.assetId ? media.get(node.assetId) : undefined;
  if (primaryImage) result.push({ fillImage: primaryImage, fillOpacity: 1 });
  return result;
}

function uniformBorder(node: DesignNode): Border | null {
  const borders = ['top', 'right', 'bottom', 'left']
    .map((side) => node.style.borders[side as keyof typeof node.style.borders])
    .filter((item): item is Border => item !== undefined);
  if (borders.length !== 4) return null;
  const first = borders[0];
  return borders.every(
    (item) =>
      item.width === first.width &&
      item.color === first.color &&
      item.opacity === first.opacity &&
      item.style === first.style,
  )
    ? first
    : null;
}

function applyCommon(shape: Shape, node: DesignNode, state: RenderState): void {
  shape.name = node.name;
  shape.x = state.rootOffset.x + node.rect.x;
  shape.y = state.rootOffset.y + node.rect.y;
  shape.resize(Math.max(1, node.rect.width), Math.max(1, node.rect.height));
  shape.opacity = node.style.opacity;
  if (node.style.rotation) shape.rotation = node.style.rotation;
  const modes = new Set([
    'normal',
    'darken',
    'multiply',
    'color-burn',
    'lighten',
    'screen',
    'color-dodge',
    'overlay',
    'soft-light',
    'hard-light',
    'difference',
    'exclusion',
    'hue',
    'saturation',
    'color',
    'luminosity',
  ]);
  if (node.style.blendMode && modes.has(node.style.blendMode)) {
    shape.blendMode = node.style.blendMode as Shape['blendMode'];
  }
  shape.borderRadiusTopLeft = node.style.radius.top;
  shape.borderRadiusTopRight = node.style.radius.right;
  shape.borderRadiusBottomRight = node.style.radius.bottom;
  shape.borderRadiusBottomLeft = node.style.radius.left;
  shape.shadows = node.style.shadows.map((shadow) => ({
    style: shadow.inset ? 'inner-shadow' : 'drop-shadow',
    offsetX: shadow.x,
    offsetY: shadow.y,
    blur: shadow.blur,
    spread: shadow.spread,
    color: { color: shadow.color, opacity: shadow.opacity },
  }));
  const border = uniformBorder(node);
  if (border) {
    shape.strokes = [
      {
        strokeColor: border.color,
        strokeOpacity: border.opacity,
        strokeStyle: border.style,
        strokeWidth: border.width,
        strokeAlignment: 'inner',
      },
    ];
  }
  if (shape.layoutChild) {
    shape.layoutChild.absolute = node.layoutItem.absolute;
    shape.layoutChild.zIndex = node.layoutItem.zIndex;
    shape.layoutChild.horizontalSizing = node.layoutItem.horizontalSizing;
    shape.layoutChild.verticalSizing = node.layoutItem.verticalSizing;
    shape.layoutChild.alignSelf = node.layoutItem.alignSelf;
  }
  if (shape.layoutCell) {
    shape.layoutCell.position = node.layoutItem.areaName
      ? 'area'
      : node.layoutItem.row !== undefined ||
          node.layoutItem.column !== undefined
        ? 'manual'
        : 'auto';
    shape.layoutCell.row = node.layoutItem.row;
    shape.layoutCell.rowSpan = node.layoutItem.rowSpan;
    shape.layoutCell.column = node.layoutItem.column;
    shape.layoutCell.columnSpan = node.layoutItem.columnSpan;
    shape.layoutCell.areaName = node.layoutItem.areaName;
  }
}

function applyTextStyle(
  target: Text | TextRange,
  style: NonNullable<DesignNode['textStyle']>,
  node: DesignNode,
  state: RenderState,
  range: boolean,
): void {
  const requested = style.fontFamily;
  const exact =
    penpot.fonts.findByName(requested) ??
    penpot.fonts.all.find(
      (font) => font.fontFamily.toLowerCase() === requested.toLowerCase(),
    );
  const genericFallback = /mono/i.test(requested)
    ? penpot.fonts.all.find((font) => /mono/i.test(font.fontFamily))
    : /serif/i.test(requested) && !/sans/i.test(requested)
      ? penpot.fonts.all.find(
          (font) =>
            /serif/i.test(font.fontFamily) && !/sans/i.test(font.fontFamily),
        )
      : penpot.fonts.all.find((font) => /sans|inter/i.test(font.fontFamily));
  const fallback =
    exact ??
    genericFallback ??
    penpot.fonts.findByName('Inter') ??
    penpot.fonts.all[0];
  if (fallback) {
    if (range) fallback.applyToRange(target as TextRange);
    else fallback.applyToText(target as Text);
    if (!exact) {
      const used = fallback.fontFamily;
      if (
        !state.fontSubstitutions.some(
          (item) => item.requested === requested && item.used === used,
        )
      ) {
        state.fontSubstitutions.push({ requested, used });
        state.warnings.push({
          code: 'font-substitution',
          nodeId: node.id,
          message: `Replaced missing font “${requested}” with “${used}”`,
        });
      }
    }
  }
  target.fontSize = String(style.fontSize);
  target.fontWeight = style.fontWeight;
  target.fontStyle = style.fontStyle;
  target.lineHeight = String(style.lineHeight);
  target.letterSpacing = String(style.letterSpacing);
  target.align = style.align;
  target.verticalAlign = style.verticalAlign;
  target.textDecoration = style.decoration;
  target.textTransform = style.transform;
  target.direction = style.direction;
  target.fills = [{ fillColor: style.color, fillOpacity: style.colorOpacity }];
}

function applyText(text: Text, node: DesignNode, state: RenderState): void {
  if (!node.textStyle) return;
  text.growType = 'fixed';
  applyTextStyle(text, node.textStyle, node, state, false);
  for (const run of node.textRuns ?? []) {
    try {
      applyTextStyle(
        text.getRange(run.start, run.end),
        run.style,
        node,
        state,
        true,
      );
    } catch {
      state.warnings.push({
        code: 'invalid-node',
        nodeId: node.id,
        message: `Skipped invalid text range ${run.start}-${run.end} in “${node.name}”`,
      });
    }
  }
}

function createBorderLine(
  parent: Board,
  node: DesignNode,
  side: 'top' | 'right' | 'bottom' | 'left',
  border: Border,
  state: RenderState,
): void {
  const line = penpot.createRectangle();
  const vertical = side === 'left' || side === 'right';
  line.name = `${node.name} – ${side} border`;
  line.resize(
    vertical ? border.width : node.rect.width,
    vertical ? node.rect.height : border.width,
  );
  line.x =
    state.rootOffset.x +
    node.rect.x +
    (side === 'right' ? node.rect.width - border.width : 0);
  line.y =
    state.rootOffset.y +
    node.rect.y +
    (side === 'bottom' ? node.rect.height - border.width : 0);
  line.fills = [{ fillColor: border.color, fillOpacity: border.opacity }];
  parent.appendChild(line);
  if (line.layoutChild) line.layoutChild.absolute = true;
}

function applyUnevenBorders(
  parent: Board,
  node: DesignNode,
  state: RenderState,
): void {
  if (uniformBorder(node)) return;
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const value = node.style.borders[side];
    if (value) createBorderLine(parent, node, side, value, state);
  }
}

function configureLayout(board: Board, node: DesignNode): void {
  const source = node.layout;
  if (!source) return;
  if (source.mode === 'flex') {
    const layout = board.addFlexLayout();
    layout.dir = source.direction;
    layout.wrap = source.wrap;
    layout.alignItems = source.alignItems;
    layout.alignContent = source.alignContent;
    layout.justifyContent = source.justifyContent;
    layout.rowGap = source.rowGap;
    layout.columnGap = source.columnGap;
    layout.paddingType = 'multiple';
    layout.topPadding = source.padding.top;
    layout.rightPadding = source.padding.right;
    layout.bottomPadding = source.padding.bottom;
    layout.leftPadding = source.padding.left;
    layout.horizontalSizing = 'fix';
    layout.verticalSizing = 'fix';
  } else {
    const layout = board.addGridLayout();
    layout.alignItems = source.alignItems;
    layout.justifyItems = source.justifyItems;
    layout.rowGap = source.rowGap;
    layout.columnGap = source.columnGap;
    layout.paddingType = 'multiple';
    layout.topPadding = source.padding.top;
    layout.rightPadding = source.padding.right;
    layout.bottomPadding = source.padding.bottom;
    layout.leftPadding = source.padding.left;
    layout.horizontalSizing = 'fix';
    layout.verticalSizing = 'fix';
    for (const track of source.rows)
      layout.addRow(track.type as TrackType, track.value);
    for (const track of source.columns)
      layout.addColumn(track.type as TrackType, track.value);
  }
}

async function createNode(
  node: DesignNode,
  parent: Board | Group,
  state: RenderState,
  parentLayout?: Layout,
): Promise<Shape> {
  checkCancelled(state);
  let shape: Shape;
  let creationFallback = false;
  const hasUnevenBorder =
    uniformBorder(node) === null &&
    Object.values(node.style.borders).some((border) => border !== undefined);
  if (node.kind === 'text' && node.text?.trim() && node.fallback !== 'raster') {
    const text = penpot.createText(node.text);
    shape = text ?? penpot.createRectangle();
    creationFallback = text === null;
  } else if (node.kind === 'svg' && node.svg) {
    const svg = await penpot.createShapeFromSvgWithImages(node.svg);
    shape = svg ?? penpot.createRectangle();
    creationFallback = svg === null;
  } else if (node.kind === 'ellipse') {
    shape = penpot.createEllipse();
  } else if (node.kind === 'container' || hasUnevenBorder) {
    shape = penpot.createBoard();
  } else {
    shape = penpot.createRectangle();
  }
  if (creationFallback)
    state.warnings.push({
      code: 'invalid-node',
      nodeId: node.id,
      message: `Penpot could not create “${node.name}”; inserted a placeholder`,
    });
  parent.appendChild(shape);
  state.shapes.set(node.id, shape);
  applyCommon(shape, node, state);
  if (
    shape.layoutChild &&
    node.layoutItem.grow &&
    parentLayout?.mode === 'flex'
  ) {
    if (parentLayout.direction.startsWith('row'))
      shape.layoutChild.horizontalSizing = 'fill';
    else shape.layoutChild.verticalSizing = 'fill';
  }
  if (shape.type === 'text') applyText(shape, node, state);
  if (shape.type === 'board') {
    shape.clipContent = node.style.overflowHidden;
    shape.fills = fills(node, state.media);
    configureLayout(shape, node);
  } else if (shape.type !== 'group' && shape.type !== 'text') {
    shape.fills = fills(node, state.media);
  }
  if (
    shape.type !== 'group' &&
    shape.type !== 'text' &&
    (node.fallback === 'placeholder' ||
      creationFallback ||
      (node.assetId !== undefined && !state.media.has(node.assetId)))
  ) {
    shape.fills = [{ fillColor: '#E5E7EB', fillOpacity: 1 }];
    shape.strokes = [
      { strokeColor: '#9CA3AF', strokeStyle: 'dashed', strokeWidth: 1 },
    ];
  }
  state.created += 1;
  state.options.onProgress(
    state.created,
    state.document.stats.nodeCount,
    node.name,
  );
  if (shape.type === 'board') {
    for (const child of node.children)
      await createNode(child, shape, state, node.layout);
    applyUnevenBorders(shape, node, state);
  }
  if (state.created % 50 === 0)
    await new Promise((resolve) => setTimeout(resolve, 0));
  return shape;
}

async function uploadAssets(state: RenderState): Promise<void> {
  for (const asset of state.document.assets) {
    checkCancelled(state);
    try {
      const media = await penpot.uploadMediaData(
        asset.name,
        asset.data,
        asset.mimeType,
      );
      state.media.set(asset.id, media);
    } catch {
      state.warnings.push({
        code: 'missing-asset',
        message: `Could not upload embedded asset ${asset.name}`,
      });
    }
  }
}

function outsideTolerance(
  actual: number,
  expected: number,
  size: number,
): boolean {
  return Math.abs(actual - expected) > Math.max(2, Math.abs(size) * 0.01);
}

function geometryMismatch(
  shape: Shape,
  node: DesignNode,
  state: RenderState,
): boolean {
  return (
    outsideTolerance(
      shape.x,
      state.rootOffset.x + node.rect.x,
      node.rect.width,
    ) ||
    outsideTolerance(
      shape.y,
      state.rootOffset.y + node.rect.y,
      node.rect.height,
    ) ||
    outsideTolerance(shape.width, node.rect.width, node.rect.width) ||
    outsideTolerance(shape.height, node.rect.height, node.rect.height)
  );
}

async function validateLayouts(
  node: DesignNode,
  state: RenderState,
): Promise<void> {
  const shape = state.shapes.get(node.id);
  if (node.layout && shape?.type === 'board') {
    await shape.waitForLayoutUpdate(30_000);
    checkCancelled(state);
    const mismatch =
      geometryMismatch(shape, node, state) ||
      node.children.some((child) => {
        const rendered = state.shapes.get(child.id);
        return !rendered || geometryMismatch(rendered, child, state);
      });
    if (mismatch) {
      shape.flex?.remove();
      shape.grid?.remove();
      state.layoutFallbacks.push(node.name);
      state.warnings.push({
        code: 'layout-fallback',
        nodeId: node.id,
        message: `Converted “${node.name}” to absolute layout after geometry validation`,
      });
      for (const child of node.children) {
        const rendered = state.shapes.get(child.id);
        if (!rendered) continue;
        rendered.x = state.rootOffset.x + child.rect.x;
        rendered.y = state.rootOffset.y + child.rect.y;
        rendered.resize(child.rect.width, child.rect.height);
      }
    }
  }
  for (const child of node.children) await validateLayouts(child, state);
}

export async function renderDocument(
  document: ImportDocument,
  options: RenderOptions,
): Promise<ImportResult> {
  const started = performance.now();
  const block = penpot.history.undoBlockBegin();
  let root: Board | null = null;
  const state: RenderState = {
    document,
    options,
    media: new Map(),
    warnings: [...document.warnings],
    fontSubstitutions: [],
    layoutFallbacks: [],
    shapes: new Map(),
    created: 0,
    rootOffset: {
      x:
        penpot.viewport.center.x -
        document.root.rect.width / 2 -
        document.root.rect.x,
      y:
        penpot.viewport.center.y -
        document.root.rect.height / 2 -
        document.root.rect.y,
    },
  };
  try {
    root = penpot.createBoard();
    state.shapes.set(document.root.id, root);
    await uploadAssets(state);
    checkCancelled(state);
    applyCommon(root, document.root, state);
    root.name = document.title;
    root.clipContent = document.root.style.overflowHidden;
    root.fills = fills(document.root, state.media);
    configureLayout(root, document.root);
    state.created = 1;
    state.options.onProgress(1, document.stats.nodeCount, document.title);
    for (const child of document.root.children)
      await createNode(child, root, state, document.root.layout);
    applyUnevenBorders(root, document.root, state);
    await validateLayouts(document.root, state);
    checkCancelled(state);
    penpot.selection = [root];
    penpot.viewport.zoomIntoView([root]);
    return {
      title: document.title,
      createdNodes: state.created,
      durationMs: Math.round(performance.now() - started),
      warnings: state.warnings,
      fontSubstitutions: state.fontSubstitutions,
      layoutFallbacks: state.layoutFallbacks,
    };
  } catch (error) {
    if (root) await root.remove();
    throw error;
  } finally {
    penpot.history.undoBlockFinish(block);
  }
}
