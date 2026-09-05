import {
  cropThumbnail,
  decodeEmbeddedRaster,
  decodeRasterDataUrl,
  digest,
  rasterizeLeaf,
} from './assets.js';
import {
  backgroundReferences,
  cssValue,
  isEllipse,
  parseDesignStyle,
  parseLayout,
  parseLayoutItem,
  parseTextStyle,
  safeCanvasFilter,
} from './css.js';
import type {
  Asset,
  DesignNode,
  ImportDocument,
  ImportWarning,
  Rect,
  TextRun,
} from './model.js';
import { sanitizeSvg } from './sanitize-svg.js';
import { asMap, asNumber, asString, type UnknownMap } from './value.js';

const MAX_NODES = 20_000;
const MAX_DEPTH = 128;

function rect(value: unknown): Rect {
  const source = asMap(value);
  return {
    x: asNumber(source.x),
    y: asNumber(source.y),
    width: Math.max(1, asNumber(source.width, 1)),
    height: Math.max(1, asNumber(source.height, 1)),
  };
}

function runCandidates(source: UnknownMap): unknown[] {
  for (const value of [
    source.textRuns,
    source.textSegments,
    source.styledTextSegments,
    source.ranges,
  ]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeTextRuns(
  source: UnknownMap,
  inheritedStyles: UnknownMap,
  textLength: number,
): TextRun[] {
  let cursor = 0;
  return runCandidates(source).flatMap((value) => {
    const run = asMap(value);
    const characters = asString(run.text ?? run.characters ?? run.value);
    const start = Math.max(
      0,
      Math.min(textLength, asNumber(run.start ?? run.from, cursor)),
    );
    const end = Math.max(
      start,
      Math.min(
        textLength,
        asNumber(run.end ?? run.to, start + characters.length),
      ),
    );
    cursor = end;
    if (end <= start) return [];
    const styles = {
      ...inheritedStyles,
      ...asMap(run.styles),
      ...asMap(run.computedStyles),
      ...asMap(run.style),
    };
    return [{ start, end, style: parseTextStyle(styles) }];
  });
}

async function addAsset(
  decoded: { mimeType: string; data: Uint8Array },
  name: string,
  assets: Asset[],
  assetByHash: Map<string, string>,
): Promise<string> {
  const hash = await digest(decoded.data);
  const previous = assetByHash.get(hash);
  if (previous) return previous;
  const id = `asset-${assets.length + 1}`;
  assetByHash.set(hash, id);
  assets.push({ id, name, ...decoded, hash });
  return id;
}

export async function normalizeSnapshot(
  snapshotValue: unknown,
): Promise<ImportDocument> {
  const snapshot = asMap(snapshotValue);
  const rootValue = asMap(snapshot.root);
  if (Object.keys(rootValue).length === 0)
    throw new Error('H2D snapshot is missing its root node');

  const warnings: ImportWarning[] = [];
  const assets: Asset[] = [];
  const assetBySource = new Map<string, string>();
  const assetByHash = new Map<string, string>();
  for (const [sourceId, entry] of Object.entries(asMap(snapshot.assets))) {
    const decoded = decodeEmbeddedRaster(entry);
    if (!decoded) {
      warnings.push({
        code: 'invalid-node',
        message: `Rejected non-raster or invalid embedded asset ${sourceId}`,
      });
      continue;
    }
    assetBySource.set(
      sourceId,
      await addAsset(
        decoded,
        sourceId.split('/').pop() || 'embedded-image',
        assets,
        assetByHash,
      ),
    );
  }

  const fallbackCandidates: Array<{
    node: DesignNode;
    filter: string;
    requiresSnapshot: boolean;
  }> = [];
  let traversedNodeCount = 0;
  let visibleNodeCount = 0;
  const normalizeNode = async (
    value: unknown,
    depth: number,
    index: number,
  ): Promise<DesignNode | null> => {
    if (depth > MAX_DEPTH)
      throw new Error(`H2D tree exceeds the ${MAX_DEPTH} level limit`);
    traversedNodeCount += 1;
    if (traversedNodeCount > MAX_NODES)
      throw new Error(`H2D tree exceeds the ${MAX_NODES} node limit`);

    const source = asMap(value);
    const styles = { ...asMap(source.styles), ...asMap(source.computedStyles) };
    if (
      ['none', 'hidden', 'collapse'].includes(cssValue(styles, 'display')) ||
      cssValue(styles, 'visibility') === 'hidden'
    )
      return null;

    visibleNodeCount += 1;

    const pseudoElements = asMap(source.pseudoElementNodes);
    const childValues = [
      pseudoElements.before,
      ...(Array.isArray(source.childNodes) ? source.childNodes : []),
      pseudoElements.after,
    ].filter((child) => child !== undefined && child !== null);
    const children: DesignNode[] = [];
    for (let childIndex = 0; childIndex < childValues.length; childIndex += 1) {
      const child = await normalizeNode(
        childValues[childIndex],
        depth + 1,
        childIndex,
      );
      if (child) children.push(child);
    }
    children.sort(
      (left, right) => left.layoutItem.zIndex - right.layoutItem.zIndex,
    );

    const nodeType = asNumber(source.nodeType);
    const tag = asString(source.tag).toUpperCase();
    const id = asString(source.id, `node-${traversedNodeCount}`);
    const nodeRect = rect(source.rect ?? source.sourceRect);
    const text = asString(
      source.textContent ?? source.text ?? source.characters,
    );
    let kind: DesignNode['kind'] = children.length > 0 ? 'container' : 'shape';
    if (
      nodeType === 3 ||
      (children.length === 0 && text && tag !== 'IMG' && tag !== 'SVG')
    )
      kind = 'text';
    if (tag === 'IMG') kind = 'image';
    if (tag === 'SVG') kind = 'svg';
    if (
      tag === 'CIRCLE' ||
      tag === 'ELLIPSE' ||
      (kind === 'shape' && isEllipse(styles, nodeRect.width, nodeRect.height))
    )
      kind = 'ellipse';

    const attributes = asMap(source.attributes);
    const sourceAsset = asString(
      source.placeholderUrl ?? attributes.currentSrc ?? attributes.src,
    );
    let assetId = assetBySource.get(sourceAsset);
    if (!assetId && sourceAsset) {
      const inline = decodeRasterDataUrl(sourceAsset);
      if (inline)
        assetId = await addAsset(
          inline,
          `${id}-inline-image`,
          assets,
          assetByHash,
        );
    }
    if (!assetId && sourceAsset.startsWith('data:')) {
      warnings.push({
        code: 'missing-asset',
        nodeId: id,
        message: `Rejected unsafe or invalid inline asset ${id}`,
      });
    } else if (!assetId && kind === 'image') {
      warnings.push({
        code: 'missing-asset',
        nodeId: id,
        message: `Image ${id} has no embedded offline asset`,
      });
    }

    let svg: string | undefined;
    if (kind === 'svg') {
      const markup = asString(source.svg ?? source.outerHTML ?? attributes.svg);
      if (markup) {
        try {
          svg = sanitizeSvg(markup);
        } catch {
          warnings.push({
            code: 'unsupported-style',
            nodeId: id,
            message: `SVG ${id} could not be sanitized`,
          });
        }
      }
    }

    const unsupportedEffects = [
      cssValue(styles, 'filter'),
      cssValue(styles, 'backdropFilter', 'backdrop-filter'),
      cssValue(styles, 'maskImage', 'mask-image'),
      cssValue(styles, 'clipPath', 'clip-path'),
    ].filter((effect) => effect && effect !== 'none');
    if (unsupportedEffects.length > 0)
      warnings.push({
        code: 'unsupported-style',
        nodeId: id,
        message: `Layer ${id} uses effects that Penpot cannot reproduce exactly: ${unsupportedEffects.join(', ')}`,
      });

    const nodeStyle = parseDesignStyle(styles);
    let missingBackgroundAsset = false;
    for (const reference of backgroundReferences(
      cssValue(styles, 'backgroundImage', 'background-image'),
    )) {
      let backgroundAssetId = assetBySource.get(reference);
      if (!backgroundAssetId) {
        const inline = decodeRasterDataUrl(reference);
        if (inline)
          backgroundAssetId = await addAsset(
            inline,
            `${id}-background-image`,
            assets,
            assetByHash,
          );
      }
      if (backgroundAssetId)
        nodeStyle.fills.push({
          type: 'image',
          assetId: backgroundAssetId,
          opacity: 1,
        });
      else {
        missingBackgroundAsset = true;
        warnings.push({
          code: 'missing-asset',
          nodeId: id,
          message: `Background image for ${id} is not embedded and was not loaded`,
        });
      }
    }
    const textStyle = kind === 'text' ? parseTextStyle(styles) : undefined;
    const layout = children.length > 0 ? parseLayout(styles) : undefined;
    if (layout?.mode === 'grid') {
      for (const child of children) {
        const area = child.layoutItem.areaName
          ? layout.areas[child.layoutItem.areaName]
          : undefined;
        if (!area) continue;
        Object.assign(child.layoutItem, area, { areaName: undefined });
      }
    }
    const normalized: DesignNode = {
      id,
      name: asString(
        attributes['aria-label'] ?? source.name,
        tag || (kind === 'text' ? 'Text' : `Layer ${index + 1}`),
      ),
      kind,
      tag: tag || undefined,
      rect: nodeRect,
      style: nodeStyle,
      layout,
      layoutItem: parseLayoutItem(styles),
      text: kind === 'text' ? text : undefined,
      textStyle,
      textRuns:
        kind === 'text'
          ? normalizeTextRuns(source, styles, text.length)
          : undefined,
      assetId,
      svg,
      children,
      fallback:
        kind === 'image' && !assetId
          ? 'placeholder'
          : kind === 'svg' && !svg
            ? 'placeholder'
            : missingBackgroundAsset && nodeStyle.fills.length === 0
              ? 'placeholder'
              : undefined,
    };
    if (unsupportedEffects.length > 0 && children.length === 0)
      fallbackCandidates.push({
        node: normalized,
        filter: safeCanvasFilter(styles),
        requiresSnapshot: [
          cssValue(styles, 'backdropFilter', 'backdrop-filter'),
          cssValue(styles, 'maskImage', 'mask-image'),
          cssValue(styles, 'clipPath', 'clip-path'),
        ].some((effect) => effect && effect !== 'none'),
      });
    return normalized;
  };

  const root = await normalizeNode(rootValue, 0, 0);
  if (!root) throw new Error('H2D root node is hidden');
  root.kind = 'container';
  root.name = asString(
    snapshot.documentTitle ?? snapshot.title,
    root.name || 'Imported webpage',
  );
  const thumbnail = asString(snapshot.thumbnail);
  for (const { node, filter, requiresSnapshot } of fallbackCandidates) {
    const cropped = await cropThumbnail(thumbnail, root.rect, node.rect);
    const generated =
      cropped ??
      (!requiresSnapshot && filter !== 'none'
        ? await rasterizeLeaf(
            node,
            new Map(assets.map((asset) => [asset.id, asset])),
            filter,
          )
        : null);
    if (!generated) {
      warnings.push({
        code: 'unsupported-style',
        nodeId: node.id,
        message: `No safe offline raster fallback was available for “${node.name}”; kept its editable base appearance`,
      });
      continue;
    }
    node.assetId = await addAsset(
      generated,
      `${node.name}-fallback.png`,
      assets,
      assetByHash,
    );
    node.fallback = 'raster';
  }
  return {
    protocol: 'h2d-v1',
    title: root.name,
    sourceUrl: asString(snapshot.sourceUrl) || undefined,
    root,
    assets,
    warnings,
    stats: { nodeCount: visibleNodeCount, assetCount: assets.length },
  };
}
