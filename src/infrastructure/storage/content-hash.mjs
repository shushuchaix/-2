import { createHash } from 'node:crypto';

export const contentHash = value => createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Maintenance comparisons ignore object key order, while preserving array order. */
export function canonicalContentHash(value) {
  const stable = input => Array.isArray(input) ? input.map(stable) :
    input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])])) : input;
  return contentHash(stable(value));
}
