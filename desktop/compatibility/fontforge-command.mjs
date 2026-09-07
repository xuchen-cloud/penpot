export function fontForgeStringLiteral(value) {
  return `'${value.replaceAll("\\", "/").replaceAll("'", "\\'")}'`;
}
