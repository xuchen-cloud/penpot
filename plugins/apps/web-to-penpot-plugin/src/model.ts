export type Rect = { x: number; y: number; width: number; height: number };

export type Box = { top: number; right: number; bottom: number; left: number };

export type Track = {
  type: 'fixed' | 'flex' | 'percent' | 'auto';
  value?: number;
};

export type Layout =
  | {
      mode: 'flex';
      direction: 'row' | 'row-reverse' | 'column' | 'column-reverse';
      wrap: 'wrap' | 'nowrap';
      alignItems: 'start' | 'end' | 'center' | 'stretch';
      alignContent:
        | 'start'
        | 'end'
        | 'center'
        | 'space-between'
        | 'space-around'
        | 'space-evenly'
        | 'stretch';
      justifyContent:
        | 'start'
        | 'end'
        | 'center'
        | 'space-between'
        | 'space-around'
        | 'space-evenly'
        | 'stretch';
      rowGap: number;
      columnGap: number;
      padding: Box;
    }
  | {
      mode: 'grid';
      columns: Track[];
      rows: Track[];
      areas: Record<
        string,
        { row: number; rowSpan: number; column: number; columnSpan: number }
      >;
      alignItems: 'start' | 'end' | 'center' | 'stretch';
      justifyItems: 'start' | 'end' | 'center' | 'stretch';
      rowGap: number;
      columnGap: number;
      padding: Box;
    };

export type LayoutItem = {
  absolute: boolean;
  grow?: boolean;
  zIndex: number;
  horizontalSizing: 'auto' | 'fill' | 'fix';
  verticalSizing: 'auto' | 'fill' | 'fix';
  alignSelf: 'auto' | 'start' | 'center' | 'end' | 'stretch';
  row?: number;
  rowSpan?: number;
  column?: number;
  columnSpan?: number;
  areaName?: string;
};

export type ColorStop = { color: string; opacity: number; offset: number };

export type Paint =
  | { type: 'solid'; color: string; opacity: number }
  | {
      type: 'gradient';
      gradientType: 'linear' | 'radial';
      angle: number;
      stops: ColorStop[];
    }
  | { type: 'image'; assetId: string; opacity: number };

export type Border = {
  width: number;
  color: string;
  opacity: number;
  style: 'solid' | 'dashed' | 'dotted';
};

export type Shadow = {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  opacity: number;
};

export type DesignStyle = {
  fills: Paint[];
  borders: Partial<Record<'top' | 'right' | 'bottom' | 'left', Border>>;
  radius: Box;
  opacity: number;
  rotation: number;
  blendMode?: string;
  shadows: Shadow[];
  overflowHidden: boolean;
};

export type TextStyle = {
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontStyle: 'normal' | 'italic';
  lineHeight: number;
  letterSpacing: number;
  color: string;
  colorOpacity: number;
  align: 'left' | 'center' | 'right' | 'justify';
  verticalAlign: 'top' | 'center' | 'bottom';
  decoration: 'underline' | 'line-through' | null;
  transform: 'uppercase' | 'capitalize' | 'lowercase' | null;
  direction: 'ltr' | 'rtl' | null;
};

export type TextRun = {
  start: number;
  end: number;
  style: TextStyle;
};

export type DesignNode = {
  id: string;
  name: string;
  kind: 'container' | 'text' | 'image' | 'svg' | 'ellipse' | 'shape';
  tag?: string;
  rect: Rect;
  style: DesignStyle;
  layout?: Layout;
  layoutItem: LayoutItem;
  text?: string;
  textStyle?: TextStyle;
  textRuns?: TextRun[];
  assetId?: string;
  svg?: string;
  children: DesignNode[];
  fallback?: 'placeholder' | 'svg' | 'raster';
};

export type Asset = {
  id: string;
  name: string;
  mimeType: string;
  data: Uint8Array;
  hash: string;
};

export type ImportWarning = {
  code:
    | 'missing-asset'
    | 'unsupported-style'
    | 'font-substitution'
    | 'layout-fallback'
    | 'invalid-node';
  nodeId?: string;
  message: string;
};

export type ImportDocument = {
  protocol: 'h2d-v1';
  title: string;
  sourceUrl?: string;
  root: DesignNode;
  assets: Asset[];
  warnings: ImportWarning[];
  stats: { nodeCount: number; assetCount: number };
};

export type ImportResult = {
  title: string;
  createdNodes: number;
  durationMs: number;
  warnings: ImportWarning[];
  fontSubstitutions: Array<{ requested: string; used: string }>;
  layoutFallbacks: string[];
};

export type UiToPluginMessage =
  | { type: 'ui-ready' }
  | { type: 'import'; document: ImportDocument }
  | { type: 'cancel' };

export type PluginToUiMessage =
  | { type: 'ready'; penpotVersion: string; supported: boolean }
  | { type: 'progress'; completed: number; total: number; label: string }
  | { type: 'complete'; result: ImportResult }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };
