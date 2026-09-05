import { describe, expect, it } from 'vitest';
import { H2DParseError, parseH2DClipboardHtml } from './h2d.js';

function encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function envelope(snapshot: object, version = 1): string {
  const metadata = {
    dataType: 'h2d',
    source: 'copy-to-design',
    h2d: { v: version },
  };
  return `<span data-metadata="<!--(figmeta)${encode(JSON.stringify(metadata))}(/figmeta)-->"></span><span data-h2d="<!--(figh2d)${encode(JSON.stringify(snapshot))}(/figh2d)-->"></span>`;
}

describe('parseH2DClipboardHtml', () => {
  it('decodes an H2D v1 snapshot without losing Unicode', () => {
    const result = parseH2DClipboardHtml(
      envelope({
        root: { nodeType: 1, tag: 'DIV', childNodes: [] },
        title: '你好 Penpot',
      }),
    );

    expect(result.metadata.source).toBe('copy-to-design');
    expect(result.snapshot.title).toBe('你好 Penpot');
  });

  it('rejects unsupported H2D versions', () => {
    expect(() => parseH2DClipboardHtml(envelope({ root: {} }, 2))).toThrowError(
      new H2DParseError('unsupported-version', 'Unsupported H2D version: 2'),
    );
  });

  it('rejects malformed payloads', () => {
    const html =
      '<!--(figmeta)not-base64(/figmeta)--><!--(figh2d)also-bad(/figh2d)-->';
    expect(() => parseH2DClipboardHtml(html)).toThrowError(H2DParseError);
  });

  it('distinguishes valid Base64 containing damaged JSON', () => {
    const metadata = encode(JSON.stringify({ dataType: 'h2d', h2d: { v: 1 } }));
    const html = `<!--(figmeta)${metadata}(/figmeta)--><!--(figh2d)${encode('{broken')}(/figh2d)-->`;

    expect(() => parseH2DClipboardHtml(html)).toThrowError(
      new H2DParseError('invalid-json', 'H2D snapshot is not valid JSON'),
    );
  });

  it('rejects clipboard HTML larger than the configured limit', () => {
    expect(() =>
      parseH2DClipboardHtml('x'.repeat(64 * 1024 * 1024 + 1)),
    ).toThrowError(H2DParseError);
  });

  it('requires a root node', () => {
    expect(() =>
      parseH2DClipboardHtml(envelope({ title: 'missing' })),
    ).toThrowError(
      new H2DParseError(
        'invalid-snapshot',
        'H2D snapshot is missing its root node',
      ),
    );
  });

  it('rejects non-object metadata and root values', () => {
    const invalidMetadata = `<!--(figmeta)${encode('null')}(/figmeta)--><!--(figh2d)${encode(JSON.stringify({ root: {} }))}(/figh2d)-->`;
    expect(() => parseH2DClipboardHtml(invalidMetadata)).toThrowError(
      new H2DParseError(
        'invalid-metadata',
        'Clipboard metadata is not H2D data',
      ),
    );
    expect(() =>
      parseH2DClipboardHtml(envelope({ root: 'not-an-object' })),
    ).toThrowError(H2DParseError);
  });
});
