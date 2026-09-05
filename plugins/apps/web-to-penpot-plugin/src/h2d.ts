export type H2DMetadata = {
  dataType: string;
  source?: string;
  h2d?: { v?: number; [key: string]: unknown };
  [key: string]: unknown;
};

export type H2DSnapshot = {
  root: Record<string, unknown>;
  [key: string]: unknown;
};

export type ParsedH2D = { metadata: H2DMetadata; snapshot: H2DSnapshot };

export type H2DParseErrorCode =
  | 'missing-payload'
  | 'invalid-base64'
  | 'invalid-json'
  | 'invalid-metadata'
  | 'unsupported-version'
  | 'invalid-snapshot'
  | 'payload-too-large';

export class H2DParseError extends Error {
  constructor(
    readonly code: H2DParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'H2DParseError';
  }
}

const MAX_HTML_BYTES = 64 * 1024 * 1024;
const markerPattern = (name: string) =>
  new RegExp(`<!--\\(${name}\\)([A-Za-z0-9+/=\\s]+)\\(/${name}\\)-->`);

function decodeUtf8Base64(value: string): string {
  try {
    const binary = atob(value.replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new H2DParseError(
      'invalid-base64',
      'H2D clipboard data is not valid Base64',
    );
  }
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new H2DParseError('invalid-json', `${label} is not valid JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseH2DClipboardHtml(html: string): ParsedH2D {
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) {
    throw new H2DParseError(
      'payload-too-large',
      'Clipboard payload exceeds the 64 MiB limit',
    );
  }

  const metadataMatch = markerPattern('figmeta').exec(html);
  const payloadMatch = markerPattern('figh2d').exec(html);
  if (!metadataMatch?.[1] || !payloadMatch?.[1]) {
    throw new H2DParseError(
      'missing-payload',
      'Clipboard does not contain Copy to Design H2D data',
    );
  }

  const metadata = parseJson<H2DMetadata>(
    decodeUtf8Base64(metadataMatch[1]),
    'H2D metadata',
  );
  if (!isRecord(metadata) || metadata.dataType !== 'h2d') {
    throw new H2DParseError(
      'invalid-metadata',
      'Clipboard metadata is not H2D data',
    );
  }
  const version = metadata.h2d?.v;
  if (version !== 1) {
    throw new H2DParseError(
      'unsupported-version',
      `Unsupported H2D version: ${String(version)}`,
    );
  }

  const snapshot = parseJson<H2DSnapshot>(
    decodeUtf8Base64(payloadMatch[1]),
    'H2D snapshot',
  );
  if (!isRecord(snapshot) || !isRecord(snapshot.root)) {
    throw new H2DParseError(
      'invalid-snapshot',
      'H2D snapshot is missing its root node',
    );
  }
  return { metadata, snapshot };
}
