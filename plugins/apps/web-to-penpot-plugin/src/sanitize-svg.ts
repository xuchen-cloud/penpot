const BLOCKED_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'style',
  'link',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
]);

function isSafeReference(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === '' ||
    trimmed.startsWith('#') ||
    /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(trimmed)
  );
}

export function sanitizeSvg(svg: string): string {
  if (/<!doctype|<!entity/i.test(svg)) throw new Error('Invalid SVG');
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (
    document.querySelector('parsererror') ||
    document.documentElement.localName !== 'svg'
  ) {
    throw new Error('Invalid SVG');
  }

  for (const element of Array.from(document.querySelectorAll('*'))) {
    if (BLOCKED_ELEMENTS.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'href' || name === 'xlink:href') {
        if (!isSafeReference(value)) element.removeAttribute(attribute.name);
        continue;
      }
      if (/javascript\s*:|@import|expression\s*\(/i.test(value)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (/\b(?:https?|file|ftp|blob|data):|\/\//i.test(value)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (/url\s*\(/i.test(value)) {
        const unsafe = Array.from(
          value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi),
        ).some((match) => !isSafeReference(match[1] ?? ''));
        if (unsafe) element.removeAttribute(attribute.name);
      }
    }
  }

  document.documentElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(document.documentElement);
}
