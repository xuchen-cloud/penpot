import type {
  Border,
  Box,
  DesignStyle,
  Layout,
  LayoutItem,
  Paint,
  Shadow,
  TextStyle,
  Track,
} from './model.js';
import { asNumber, asString, type UnknownMap } from './value.js';

const transparent = new Set([
  '',
  'transparent',
  'rgba(0, 0, 0, 0)',
  'rgba(0,0,0,0)',
]);

export function cssValue(
  styles: UnknownMap,
  camel: string,
  kebab?: string,
): string {
  return asString(styles[camel] ?? styles[kebab ?? camel]);
}

function pixels(value: unknown, fallback = 0): number {
  if (
    value === undefined ||
    value === null ||
    value === 'normal' ||
    value === 'auto'
  )
    return fallback;
  return asNumber(value, fallback);
}

function splitCssList(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  for (const character of value) {
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    if (character === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function tokenizeCss(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  for (const character of value.trim()) {
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(character) && depth === 0) {
      if (current) result.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (current) result.push(current);
  return result;
}

function box(value: string, styles: UnknownMap, prefix: string): Box {
  const tokens = tokenizeCss(value).map((token) => pixels(token));
  const expanded =
    tokens.length === 1
      ? [tokens[0], tokens[0], tokens[0], tokens[0]]
      : tokens.length === 2
        ? [tokens[0], tokens[1], tokens[0], tokens[1]]
        : tokens.length === 3
          ? [tokens[0], tokens[1], tokens[2], tokens[1]]
          : tokens.length >= 4
            ? tokens.slice(0, 4)
            : [0, 0, 0, 0];
  return {
    top: pixels(styles[`${prefix}Top`], expanded[0]),
    right: pixels(styles[`${prefix}Right`], expanded[1]),
    bottom: pixels(styles[`${prefix}Bottom`], expanded[2]),
    left: pixels(styles[`${prefix}Left`], expanded[3]),
  };
}

function color(value: string): { color: string; opacity: number } | null {
  const input = value.trim().toLowerCase();
  if (transparent.has(input)) return null;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(input);
  if (hex?.[1]) {
    const raw = hex[1];
    const expanded =
      raw.length <= 4
        ? raw
            .split('')
            .map((part) => `${part}${part}`)
            .join('')
        : raw;
    return {
      color: `#${expanded.slice(0, 6)}`,
      opacity:
        expanded.length === 8
          ? Number.parseInt(expanded.slice(6, 8), 16) / 255
          : 1,
    };
  }
  const rgb =
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
      input,
    );
  if (!rgb) return null;
  const toHex = (component: string) =>
    Math.max(0, Math.min(255, Math.round(Number(component))))
      .toString(16)
      .padStart(2, '0');
  const alpha = rgb[4]?.endsWith('%')
    ? asNumber(rgb[4]) / 100
    : asNumber(rgb[4], 1);
  return {
    color: `#${toHex(rgb[1])}${toHex(rgb[2])}${toHex(rgb[3])}`,
    opacity: Math.max(0, Math.min(1, alpha)),
  };
}

function gradient(value: string): Paint | null {
  const match = /^(linear|radial)-gradient\((.*)\)$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const parts = splitCssList(match[2]);
  let angle = 180;
  if (/deg$/i.test(parts[0] ?? '')) angle = asNumber(parts.shift(), 180);
  const stops = parts
    .map((part, index) => {
      const parsed = /^(.*?)(?:\s+([\d.]+)%?)?$/.exec(part.trim());
      const parsedColor = color(parsed?.[1] ?? '');
      if (!parsedColor) return null;
      return {
        ...parsedColor,
        offset: parsed?.[2]
          ? asNumber(parsed[2]) / 100
          : index / Math.max(1, parts.length - 1),
      };
    })
    .filter(
      (stop): stop is { color: string; opacity: number; offset: number } =>
        stop !== null,
    );
  return stops.length < 2
    ? null
    : {
        type: 'gradient',
        gradientType: match[1].toLowerCase() === 'radial' ? 'radial' : 'linear',
        angle,
        stops,
      };
}

function shadows(value: string): Shadow[] {
  if (!value || value === 'none') return [];
  return splitCssList(value).flatMap((part) => {
    const parsedColor = color(
      part.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i)?.[0] ?? '',
    );
    const values = part.match(/-?[\d.]+px/g)?.map(asNumber) ?? [];
    return !parsedColor || values.length < 2
      ? []
      : [
          {
            inset: /\binset\b/i.test(part),
            x: values[0] ?? 0,
            y: values[1] ?? 0,
            blur: values[2] ?? 0,
            spread: values[3] ?? 0,
            ...parsedColor,
          },
        ];
  });
}

function border(
  styles: UnknownMap,
  side: 'Top' | 'Right' | 'Bottom' | 'Left',
): Border | undefined {
  const width = pixels(styles[`border${side}Width`]);
  const borderStyle = asString(styles[`border${side}Style`]).toLowerCase();
  const parsedColor = color(asString(styles[`border${side}Color`]));
  return width <= 0 || borderStyle === 'none' || !parsedColor
    ? undefined
    : {
        width,
        style:
          borderStyle === 'dashed' || borderStyle === 'dotted'
            ? borderStyle
            : 'solid',
        ...parsedColor,
      };
}

function rotation(styles: UnknownMap): number {
  const rotate = cssValue(styles, 'rotate');
  if (rotate.endsWith('deg')) return asNumber(rotate);
  const matrix = /^matrix\(([^)]+)\)$/.exec(cssValue(styles, 'transform'));
  if (!matrix?.[1]) return 0;
  const values = matrix[1].split(',').map(asNumber);
  return (
    Math.round(
      (Math.atan2(values[1] ?? 0, values[0] ?? 1) * 180 * 1000) / Math.PI,
    ) / 1000
  );
}

export function parseDesignStyle(styles: UnknownMap): DesignStyle {
  const fills: Paint[] = [];
  const background = color(
    cssValue(styles, 'backgroundColor', 'background-color'),
  );
  if (background) fills.push({ type: 'solid', ...background });
  for (const layer of splitCssList(
    cssValue(styles, 'backgroundImage', 'background-image'),
  )) {
    const parsed = gradient(layer);
    if (parsed) fills.push(parsed);
  }
  return {
    fills,
    borders: {
      top: border(styles, 'Top'),
      right: border(styles, 'Right'),
      bottom: border(styles, 'Bottom'),
      left: border(styles, 'Left'),
    },
    radius: {
      top: pixels(styles.borderTopLeftRadius ?? styles.borderRadius),
      right: pixels(styles.borderTopRightRadius ?? styles.borderRadius),
      bottom: pixels(styles.borderBottomRightRadius ?? styles.borderRadius),
      left: pixels(styles.borderBottomLeftRadius ?? styles.borderRadius),
    },
    opacity: Math.max(0, Math.min(1, asNumber(styles.opacity, 1))),
    rotation: rotation(styles),
    blendMode: cssValue(styles, 'mixBlendMode', 'mix-blend-mode') || undefined,
    shadows: shadows(cssValue(styles, 'boxShadow', 'box-shadow')),
    overflowHidden: ['hidden', 'clip'].includes(
      cssValue(styles, 'overflow').toLowerCase(),
    ),
  };
}

function alignment(value: string): 'start' | 'end' | 'center' | 'stretch' {
  if (value === 'flex-end' || value === 'end') return 'end';
  if (value === 'center') return 'center';
  return value === 'stretch' ? 'stretch' : 'start';
}

function contentAlignment(
  value: string,
):
  | 'start'
  | 'end'
  | 'center'
  | 'space-between'
  | 'space-around'
  | 'space-evenly'
  | 'stretch' {
  if (
    [
      'space-between',
      'space-around',
      'space-evenly',
      'center',
      'stretch',
    ].includes(value)
  )
    return value as
      'space-between' | 'space-around' | 'space-evenly' | 'center' | 'stretch';
  return value === 'flex-end' || value === 'end' ? 'end' : 'start';
}

function tracks(value: string): Track[] {
  if (!value || value === 'none') return [];
  return tokenizeCss(value).map((token) => {
    if (token === 'auto' || token.startsWith('minmax('))
      return { type: 'auto' };
    if (token.endsWith('fr'))
      return { type: 'flex', value: asNumber(token, 1) };
    if (token.endsWith('%')) return { type: 'percent', value: asNumber(token) };
    return { type: 'fixed', value: pixels(token) };
  });
}

function gridAreas(
  value: string,
): Record<
  string,
  { row: number; rowSpan: number; column: number; columnSpan: number }
> {
  const rows = Array.from(value.matchAll(/["']([^"']*)["']/g)).map((match) =>
    (match[1] ?? '').trim().split(/\s+/),
  );
  const width = rows[0]?.length ?? 0;
  if (!width || rows.some((row) => row.length !== width)) return {};
  const cells = new Map<string, Array<{ row: number; column: number }>>();
  rows.forEach((row, rowIndex) =>
    row.forEach((name, columnIndex) => {
      if (name === '.') return;
      const positions = cells.get(name) ?? [];
      positions.push({ row: rowIndex, column: columnIndex });
      cells.set(name, positions);
    }),
  );
  const result: Record<
    string,
    { row: number; rowSpan: number; column: number; columnSpan: number }
  > = {};
  for (const [name, positions] of cells) {
    const row = Math.min(...positions.map((position) => position.row));
    const rowEnd = Math.max(...positions.map((position) => position.row));
    const column = Math.min(...positions.map((position) => position.column));
    const columnEnd = Math.max(...positions.map((position) => position.column));
    const rectangular = rows
      .slice(row, rowEnd + 1)
      .every((areaRow) =>
        areaRow.slice(column, columnEnd + 1).every((cell) => cell === name),
      );
    if (rectangular)
      result[name] = {
        row,
        rowSpan: rowEnd - row + 1,
        column,
        columnSpan: columnEnd - column + 1,
      };
  }
  return result;
}

export function parseLayout(styles: UnknownMap): Layout | undefined {
  const display = cssValue(styles, 'display').toLowerCase();
  const padding = box(cssValue(styles, 'padding'), styles, 'padding');
  if (display === 'flex' || display === 'inline-flex') {
    const gap = pixels(styles.gap);
    const direction = asString(styles.flexDirection);
    return {
      mode: 'flex',
      direction: (['row', 'row-reverse', 'column', 'column-reverse'].includes(
        direction,
      )
        ? direction
        : 'row') as 'row' | 'row-reverse' | 'column' | 'column-reverse',
      wrap: asString(styles.flexWrap) === 'wrap' ? 'wrap' : 'nowrap',
      alignItems: alignment(asString(styles.alignItems)),
      alignContent: contentAlignment(asString(styles.alignContent)),
      justifyContent: contentAlignment(asString(styles.justifyContent)),
      rowGap: pixels(styles.rowGap, gap),
      columnGap: pixels(styles.columnGap, gap),
      padding,
    };
  }
  if (display !== 'grid' && display !== 'inline-grid') return undefined;
  return {
    mode: 'grid',
    columns: tracks(asString(styles.gridTemplateColumns)),
    rows: tracks(asString(styles.gridTemplateRows)),
    areas: gridAreas(asString(styles.gridTemplateAreas)),
    alignItems: alignment(asString(styles.alignItems)),
    justifyItems: alignment(asString(styles.justifyItems)),
    rowGap: pixels(styles.rowGap ?? styles.gap),
    columnGap: pixels(styles.columnGap ?? styles.gap),
    padding,
  };
}

function gridLine(value: unknown): number | undefined {
  const parsed = Number.parseInt(asString(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : undefined;
}

function gridSpan(value: unknown): number | undefined {
  const match = /^span\s+(\d+)$/i.exec(asString(value).trim());
  const parsed = Number.parseInt(match?.[1] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function gridAreaName(value: unknown): string | undefined {
  const area = asString(value).trim();
  return /^[a-z_][a-z0-9_-]*$/i.test(area) && area.toLowerCase() !== 'auto'
    ? area
    : undefined;
}

export function parseLayoutItem(styles: UnknownMap): LayoutItem {
  const position = cssValue(styles, 'position').toLowerCase();
  const column = gridLine(styles.gridColumnStart);
  const columnEnd = gridLine(styles.gridColumnEnd);
  const explicitColumnSpan = gridSpan(styles.gridColumnEnd);
  const row = gridLine(styles.gridRowStart);
  const rowEnd = gridLine(styles.gridRowEnd);
  const explicitRowSpan = gridSpan(styles.gridRowEnd);
  return {
    absolute: ['absolute', 'fixed', 'sticky'].includes(position),
    grow: asNumber(styles.flexGrow) > 0,
    zIndex: asNumber(styles.zIndex),
    horizontalSizing: asString(styles.width) === 'auto' ? 'auto' : 'fix',
    verticalSizing: asString(styles.height) === 'auto' ? 'auto' : 'fix',
    alignSelf:
      asString(styles.alignSelf) === 'auto'
        ? 'auto'
        : alignment(asString(styles.alignSelf)),
    column,
    columnSpan:
      explicitColumnSpan ??
      (column !== undefined && columnEnd !== undefined
        ? Math.max(1, columnEnd - column)
        : undefined),
    row,
    rowSpan:
      explicitRowSpan ??
      (row !== undefined && rowEnd !== undefined
        ? Math.max(1, rowEnd - row)
        : undefined),
    areaName: gridAreaName(styles.gridArea),
  };
}

export function parseTextStyle(styles: UnknownMap): TextStyle {
  const parsedColor = color(cssValue(styles, 'color')) ?? {
    color: '#000000',
    opacity: 1,
  };
  const fontSize = pixels(styles.fontSize, 16);
  const rawLineHeight = asString(styles.lineHeight).trim().toLowerCase();
  const lineHeight = rawLineHeight.endsWith('%')
    ? asNumber(rawLineHeight, 120) / 100
    : rawLineHeight.endsWith('px')
      ? pixels(rawLineHeight, fontSize * 1.2) / fontSize
      : rawLineHeight.endsWith('em')
        ? asNumber(rawLineHeight, 1.2)
        : rawLineHeight && rawLineHeight !== 'normal'
          ? asNumber(rawLineHeight, 1.2)
          : 1.2;
  const alignValue = asString(styles.textAlign).toLowerCase();
  const decoration = asString(styles.textDecorationLine).toLowerCase();
  const transform = asString(styles.textTransform).toLowerCase();
  const verticalAlign = asString(styles.verticalAlign).toLowerCase();
  return {
    fontFamily:
      asString(styles.fontFamily, 'sans-serif')
        .split(',')[0]
        ?.trim()
        .replace(/^['"]|['"]$/g, '') || 'sans-serif',
    fontSize,
    fontWeight: asString(styles.fontWeight, '400'),
    fontStyle: asString(styles.fontStyle) === 'italic' ? 'italic' : 'normal',
    lineHeight,
    letterSpacing: pixels(styles.letterSpacing),
    ...parsedColor,
    colorOpacity: parsedColor.opacity,
    align: ['center', 'right', 'justify'].includes(alignValue)
      ? (alignValue as 'center' | 'right' | 'justify')
      : 'left',
    verticalAlign: ['middle', 'center'].includes(verticalAlign)
      ? 'center'
      : ['bottom', 'text-bottom'].includes(verticalAlign)
        ? 'bottom'
        : 'top',
    decoration: decoration.includes('line-through')
      ? 'line-through'
      : decoration.includes('underline')
        ? 'underline'
        : null,
    transform: ['uppercase', 'capitalize', 'lowercase'].includes(transform)
      ? (transform as 'uppercase' | 'capitalize' | 'lowercase')
      : null,
    direction:
      asString(styles.direction) === 'rtl'
        ? 'rtl'
        : asString(styles.direction) === 'ltr'
          ? 'ltr'
          : null,
  };
}

export function backgroundReferences(value: string): string[] {
  return Array.from(
    value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi),
  )
    .map((match) => asString(match[1] ?? match[2] ?? match[3]).trim())
    .filter(Boolean);
}

export function isEllipse(
  styles: UnknownMap,
  width: number,
  height: number,
): boolean {
  const radius = asString(styles.borderRadius);
  return (
    Math.abs(width - height) <= Math.max(1, Math.max(width, height) * 0.01) &&
    /(?:^|\s)50%(?:\s|$)/.test(radius)
  );
}

export function safeCanvasFilter(styles: UnknownMap): string {
  const value = cssValue(styles, 'filter');
  return /^(?:\s*(?:blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia)\([^()]+\)\s*)+$/i.test(
    value,
  )
    ? value
    : 'none';
}
