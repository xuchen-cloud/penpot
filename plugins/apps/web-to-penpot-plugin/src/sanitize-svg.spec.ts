import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from './sanitize-svg.js';

describe('sanitizeSvg', () => {
  it('removes executable and external SVG content', () => {
    const result = sanitizeSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
        <script>alert(1)</script>
        <foreignObject><div>unsafe</div></foreignObject>
        <image href="https://example.com/a.png" />
        <path onclick="alert(2)" fill="url(https://example.com/fill.svg#x)" d="M0 0h10v10z" />
      </svg>
    `);

    expect(result).not.toContain('script');
    expect(result).not.toContain('foreignObject');
    expect(result).not.toContain('onload');
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('https://');
    expect(result).toContain('<path');
  });

  it('keeps local fragment and embedded image references', () => {
    const result = sanitizeSvg(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="g"><stop offset="1" stop-color="#fff" /></linearGradient></defs>
        <rect fill="url(#g)" width="10" height="10" />
        <image href="data:image/png;base64,AA==" />
      </svg>
    `);

    expect(result).toContain('url(#g)');
    expect(result).toContain('data:image/png;base64,AA==');
  });

  it('removes stylesheet and nested SVG data URL escape paths', () => {
    const nested = btoa('<svg onload="alert(1)"></svg>');
    const result = sanitizeSvg(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>@import url(https://example.invalid/a.css); rect { fill: red }</style>
        <image href="data:image/svg+xml;base64,${nested}" />
        <rect style="background: expression(alert(1))" width="10" height="10" />
        <rect style="background: image-set('https://example.invalid/a.png')" />
        <rect style="background: image-set('data:image/svg+xml;base64,${nested}')" />
      </svg>
    `);

    expect(result).not.toContain('<style');
    expect(result).not.toContain('image/svg+xml');
    expect(result).not.toContain('expression');
    expect(result).not.toContain('image-set');
    expect(result).not.toContain('https://');
  });
});
