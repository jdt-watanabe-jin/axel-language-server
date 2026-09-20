import type { CancellationToken } from 'vscode-languageserver/node';
import type { WorkspaceSymbolEntry } from './model';
import { cancellationCheckpoint, throwIfCancelled } from '../../util/cancellation';

function score(name: string, query: string): number {
  const value = name.toLowerCase();
  if (!query || value === query) { return 0; }
  if (value.startsWith(query)) { return 1; }
  if (value.includes(query)) { return 2; }
  let index = 0;
  for (const character of value) { if (character === query[index]) { index++; } }
  return index === query.length ? 3 : 4;
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export async function searchWorkspaceSymbols(entries: readonly WorkspaceSymbolEntry[], query: string,
  token: CancellationToken): Promise<WorkspaceSymbolEntry[]> {
  throwIfCancelled(token);
  const normalized = query.trim().toLowerCase();
  const seen = new Set<string>();
  let matches: { entry: WorkspaceSymbolEntry; rank: number }[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (i % 256 === 0) { await cancellationCheckpoint(token); }
    const entry = entries[i];
    const rank = Math.min(score(entry.name, normalized), score(entry.qualifiedName, normalized));
    const key = JSON.stringify([entry.uri, entry.selectionRange, entry.kind]);
    if (rank < 4 && !seen.has(key)) { seen.add(key); matches.push({ entry, rank }); }
  }
  const order = (a: typeof matches[number], b: typeof matches[number]): number => a.rank - b.rank
    || compare(a.entry.qualifiedName.toLowerCase(), b.entry.qualifiedName.toLowerCase())
    || compare(a.entry.qualifiedName, b.entry.qualifiedName) || compare(a.entry.uri, b.entry.uri)
    || a.entry.selectionRange.start.line - b.entry.selectionRange.start.line
    || a.entry.selectionRange.start.character - b.entry.selectionRange.start.character
    || compare(a.entry.kind, b.entry.kind);
  // Bottom-up merge sort yields even when an empty query returns a large project.
  for (let width = 1; width < matches.length; width *= 2) {
    const output: typeof matches = [];
    for (let start = 0; start < matches.length; start += 2 * width) {
      let a = start; let b = Math.min(start + width, matches.length);
      const middle = b; const end = Math.min(start + 2 * width, matches.length);
      while (a < middle || b < end) {
        if (output.length % 256 === 0) { await cancellationCheckpoint(token); }
        output.push(b >= end || (a < middle && order(matches[a], matches[b]) <= 0) ? matches[a++] : matches[b++]);
      }
    }
    matches = output;
  }
  throwIfCancelled(token);
  return matches.map(match => match.entry);
}
