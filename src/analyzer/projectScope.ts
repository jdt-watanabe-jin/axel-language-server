import type { CancellationToken } from 'vscode-languageserver/node';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { cancellationCheckpoint, throwIfCancelled } from '../util/cancellation';

export interface ProjectSettings { include: string[]; exclude: string[] }
export function validProjectPattern(pattern: unknown): pattern is string {
  return typeof pattern === 'string' && pattern.length > 0 && !/^[!/]|[:\\{}[\]]/.test(pattern)
    && !pattern.split('/').some(part => !part || part === '.' || part === '..');
}
export function normalizeProjectSettings(value: unknown): ProjectSettings {
  const project = (value as { project?: Partial<ProjectSettings> } | undefined)?.project;
  return { include: [...new Set(project?.include ?? ['**/*'])], exclude: [...new Set(project?.exclude ?? [])] };
}
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


export function canonicalPath(file: string): string {
  try { return fs.realpathSync.native(file); } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(canonicalPath(parent), path.basename(file));
  }
}
function hasLink(file: string, roots: readonly string[]): boolean {
  const boundary = roots.filter(root => insideRoot(file, root)).sort((a, b) => b.length - a.length)[0];
  for (let current = file; !boundary || fileIdentity(current) !== fileIdentity(boundary);) {
    try { if (fs.lstatSync(current).isSymbolicLink()) { return true; } } catch { /* unsaved file */ }
    const parent = path.dirname(current);
    if (parent === current || (!boundary && current !== file)) { break; }
    current = parent;
  }
  return false;
}
/** Shared ownership and enumeration; dependencies are intentionally outside this boundary. */
export class ProjectScope {
  private roots: string[] = [];
  private settings: ProjectSettings = { include: ['**/*'], exclude: [] };
  private open = new Set<string>();
  private generation = 0;
  get revision(): number { return this.generation; }
  constructor(private readonly logError: (message: string) => void = () => {}) {}
  invalidate(): void { this.generation++; }
  setRoots(uris: readonly string[]): void {
    const roots = [...new Set(uris.map(filePath).filter((file): file is string => file !== undefined).map(canonicalPath))];
    if (JSON.stringify(roots) !== JSON.stringify(this.roots)) { this.roots = roots; this.invalidate(); }
  }
  configure(settings: ProjectSettings): void {
    const next = { include: [...settings.include], exclude: [...settings.exclude] };
    if (JSON.stringify(next) !== JSON.stringify(this.settings)) { this.settings = next; this.invalidate(); }
  }
  setOpenUris(uris: readonly string[]): void {
    this.open = new Set(uris.map(filePath).filter((file): file is string => file !== undefined).map(file => fileIdentity(canonicalPath(file))));
  }
  /** previousUri preserves open-document eligibility for a proposed folderless rename. */
  contains(uri: string, previousUri?: string): boolean {
    const original = filePath(uri);
    if (!original || !isAxelFile(original) || hasLink(original, this.roots)) { return false; }
    const file = canonicalPath(original);
    const previous = previousUri && filePath(previousUri);
    const opened = this.open.has(fileIdentity(file)) || !!(previous && this.open.has(fileIdentity(canonicalPath(previous))));
    const bases = this.roots.length ? this.roots.filter(root => insideRoot(file, root))
      : opened ? [path.dirname(file)] : [];
    return bases.some(root => {
      const relative = path.relative(root, file);
      return !excluded(relative, this.settings.exclude) && this.settings.include.some(pattern => excluded(relative, [pattern]));
    });
  }
  async collect(token: CancellationToken, openUris: readonly string[] = [], strict = false): Promise<Map<string, string>> {
    throwIfCancelled(token);
    this.setOpenUris(openUris);
    const files = new Map<string, string>();
    const report = (message: string) => { if (strict) { throw new Error(message); } this.logError(message); };
    for (const root of this.roots) {
      const pending = [root];
      while (pending.length) {
        await cancellationCheckpoint(token);
        const directory = pending.pop()!;
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
        catch (error) { throwIfCancelled(token); report(`Project directory ${directory}: ${String(error)}`); continue; }
        for (const entry of entries) {
          throwIfCancelled(token);
          const file = path.join(directory, entry.name);
          if (entry.isSymbolicLink() || excluded(path.relative(root, file), this.settings.exclude)) { continue; }
          if (entry.isDirectory()) { pending.push(file); }
          else if (entry.isFile() && this.contains(fileUri(file))) { files.set(fileUri(file), file); }
        }
      }
    }
    for (const uri of openUris) {
      throwIfCancelled(token);
      if (this.contains(uri)) { const file = canonicalPath(filePath(uri)!); files.set(fileUri(file), file); }
    }
    return files;
  }
}
