import { createHash } from 'crypto';
import type { Diagnostic } from 'vscode-languageserver/node';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(canonical); }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function diagnosticDigest(items: readonly Diagnostic[]): string {
  const rows = items.map(item => JSON.stringify(canonical(item))).sort();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function median(values: readonly number[]): number {
  if (!values.length || values.some(value => !Number.isFinite(value))) {
    throw new Error('Expected finite measurement samples');
  }
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
