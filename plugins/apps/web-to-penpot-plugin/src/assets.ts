import type { Asset, DesignNode, Paint, Rect } from './model.js';
import { asMap, asString } from './value.js';

export const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_RASTER_SIDE = 4096;

type RasterData = { mimeType: string; data: Uint8Array };

function decodeBase64DataUrl(value: string): Uint8Array | null {
  const match = /^data:[^;,]+;base64,(.*)$/is.exec(value);
  if (!match?.[1]) return null;
  try {
    const binary = atob(match[1]);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function rasterMime(data: Uint8Array): string | null {
  if (
    data.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => data[index] === byte,
    )
  )
    return 'image/png';
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return 'image/jpeg';
  const prefix = String.fromCharCode(...data.slice(0, 12));
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a'))
    return 'image/gif';
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP')
    return 'image/webp';
  if (prefix.slice(4, 12) === 'ftypavif' || prefix.slice(4, 12) === 'ftypavis')
    return 'image/avif';
  return null;
}

export function decodeEmbeddedRaster(entry: unknown): RasterData | null {
  const blob = asMap(asMap(entry).blob);
  const data = decodeBase64DataUrl(asString(blob.base64Blob));
  if (!data || data.byteLength > MAX_ASSET_BYTES) return null;
  const mimeType = rasterMime(data);
  return mimeType ? { mimeType, data } : null;
}

export function decodeRasterDataUrl(value: string): RasterData | null {
  const data = decodeBase64DataUrl(value);
  if (!data || data.byteLength > MAX_ASSET_BYTES) return null;
  const mimeType = rasterMime(data);
  return mimeType ? { mimeType, data } : null;
}

export async function digest(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data.slice().buffer);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<RasterData | null> {
  return new Promise((resolve) =>
    canvas.toBlob(async (blob) => {
      resolve(
        blob
          ? {
              mimeType: 'image/png',
              data: new Uint8Array(await blob.arrayBuffer()),
            }
          : null,
      );
    }, 'image/png'),
  );
}

function loadRaster(
  data: Uint8Array,
  mimeType: string,
): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(
      new Blob([Uint8Array.from(data).buffer], { type: mimeType }),
    );
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

export async function cropThumbnail(
  thumbnail: string,
  rootRect: Rect,
  nodeRect: Rect,
): Promise<RasterData | null> {
  const data = decodeBase64DataUrl(thumbnail);
  const mimeType = data ? rasterMime(data) : null;
  if (!data || !mimeType || typeof document === 'undefined') return null;
  const image = await loadRaster(data, mimeType);
  if (!image) return null;
  const scaleX = image.naturalWidth / rootRect.width;
  const scaleY = image.naturalHeight / rootRect.height;
  const sx = Math.max(0, (nodeRect.x - rootRect.x) * scaleX);
  const sy = Math.max(0, (nodeRect.y - rootRect.y) * scaleY);
  const sw = Math.max(
    1,
    Math.min(image.naturalWidth - sx, nodeRect.width * scaleX),
  );
  const sh = Math.max(
    1,
    Math.min(image.naturalHeight - sy, nodeRect.height * scaleY),
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.min(MAX_RASTER_SIDE, Math.round(sw)));
  canvas.height = Math.max(1, Math.min(MAX_RASTER_SIDE, Math.round(sh)));
  let context: CanvasRenderingContext2D | null;
  try {
    context = canvas.getContext('2d');
  } catch {
    return null;
  }
  if (!context) return null;
  context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvasBlob(canvas);
}

function paintStyle(
  context: CanvasRenderingContext2D,
  paint: Exclude<Paint, { type: 'image' }>,
  width: number,
  height: number,
): string | CanvasGradient {
  if (paint.type === 'solid') return paint.color;
  if (paint.gradientType === 'radial') {
    const result = context.createRadialGradient(
      width / 2,
      height / 2,
      0,
      width / 2,
      height / 2,
      Math.max(width, height) / 2,
    );
    for (const stop of paint.stops)
      result.addColorStop(stop.offset, stop.color);
    return result;
  }
  const radians = ((paint.angle - 90) * Math.PI) / 180;
  const dx = (Math.cos(radians) * width) / 2;
  const dy = (Math.sin(radians) * height) / 2;
  const result = context.createLinearGradient(
    width / 2 - dx,
    height / 2 - dy,
    width / 2 + dx,
    height / 2 + dy,
  );
  for (const stop of paint.stops) result.addColorStop(stop.offset, stop.color);
  return result;
}

export async function rasterizeLeaf(
  node: DesignNode,
  assets: ReadonlyMap<string, Asset>,
  filter: string,
): Promise<RasterData | null> {
  if (typeof document === 'undefined') return null;
  const scale = Math.min(
    1,
    MAX_RASTER_SIDE / Math.max(node.rect.width, node.rect.height),
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(node.rect.width * scale));
  canvas.height = Math.max(1, Math.round(node.rect.height * scale));
  let context: CanvasRenderingContext2D | null;
  try {
    context = canvas.getContext('2d');
  } catch {
    return null;
  }
  if (!context) return null;
  context.scale(scale, scale);
  context.filter = filter;
  for (const paint of node.style.fills) {
    if (paint.type === 'image') {
      const asset = assets.get(paint.assetId);
      if (!asset) continue;
      const image = await loadRaster(asset.data, asset.mimeType);
      if (!image) continue;
      context.globalAlpha = paint.opacity;
      context.drawImage(image, 0, 0, node.rect.width, node.rect.height);
    } else {
      context.globalAlpha = paint.type === 'solid' ? paint.opacity : 1;
      context.fillStyle = paintStyle(
        context,
        paint,
        node.rect.width,
        node.rect.height,
      );
      context.fillRect(0, 0, node.rect.width, node.rect.height);
    }
  }
  if (node.assetId) {
    const asset = assets.get(node.assetId);
    if (asset) {
      const image = await loadRaster(asset.data, asset.mimeType);
      if (image) {
        context.globalAlpha = 1;
        context.drawImage(image, 0, 0, node.rect.width, node.rect.height);
      }
    }
  }
  if (node.text && node.textStyle) {
    context.globalAlpha = node.textStyle.colorOpacity;
    context.fillStyle = node.textStyle.color;
    context.font = `${node.textStyle.fontStyle} ${node.textStyle.fontWeight} ${node.textStyle.fontSize}px ${node.textStyle.fontFamily}`;
    context.textBaseline = 'top';
    context.fillText(node.text, 0, 0, node.rect.width);
  }
  return canvasBlob(canvas);
}
