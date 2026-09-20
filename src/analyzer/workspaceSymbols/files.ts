import type { CancellationToken } from 'vscode-languageserver/node';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { cancellationCheckpoint, throwIfCancelled } from '../../util/cancellation';

export function filePath(uri: string): string | undefined {
  try { return new URL(uri).protocol === 'file:' ? fileURLToPath(uri) : undefined; } catch { return undefined; }
}
export function fileIdentity(file: string): string {
  const normalized = path.resolve(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
export function fileUri(file: string): string { return pathToFileURL(fileIdentity(file)).toString(); }
export function insideRoot(file: string, root: string): boolean {
  const relative = path.relative(fileIdentity(root), fileIdentity(file));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function glob(pattern: string): RegExp {
  const segments = pattern.split('/');
  const expression = segments.map((segment, i) => {
    if (segment === '**') { return i === segments.length - 1 ? '.*' : '(?:[^/]+/)*'; }
    return segment.split('').map(c => c === '*' ? '[^/]*' : c === '?' ? '[^/]'
      : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + (i < segments.length - 1 ? '/' : '');
  }).join('');
  return new RegExp(`^${expression}$`, process.platform === 'win32' ? 'i' : '');
}
export function excluded(relative: string, patterns: readonly string[]): boolean {
  const value = relative.replace(/\\/g, '/');
  if (value.split('/').some(part => process.platform === 'win32' ? part.toLowerCase() === '.git' : part === '.git')) { return true; }
  const parts = value.split('/');
  const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
  return patterns.some(pattern => {
    const expression = glob(pattern);
    return ancestors.some(candidate => expression.test(candidate) || expression.test(`${candidate}/`));
  });
}
export function isAxelFile(file: string): boolean { return /\.(axl|h|hh)$/i.test(file); }

export async function collectWorkspaceSymbolFiles(roots: readonly string[], exclude: readonly string[],
  token: CancellationToken, logError: (message: string) => void): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const uri of roots) {
    const root = filePath(uri);
    if (!root) { continue; }
    let actual: string;
    try { actual = await fs.realpath(root); } catch (error) { logError(`Workspace symbol root ${root}: ${String(error)}`); continue; }
    const pending = [actual];
    while (pending.length) {
      await cancellationCheckpoint(token);
      const directory = pending.pop()!;
      try {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          throwIfCancelled(token);
          const file = path.join(directory, entry.name);
          if (entry.isSymbolicLink() || excluded(path.relative(actual, file), exclude)) { continue; }
          if (entry.isDirectory()) { pending.push(file); }
          else if (entry.isFile() && isAxelFile(file)) { files.set(fileUri(file), file); }
        }
      } catch (error) { throwIfCancelled(token); logError(`Workspace symbol directory ${directory}: ${String(error)}`); }
    }
  }
  return files;
}
