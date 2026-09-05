export type UnknownMap = Record<string, unknown>;

export function asMap(value: unknown): UnknownMap {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownMap)
    : {};
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseFloat(asString(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}
