import { CancellationToken, CancellationTokenSource, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { AnalyzeDocumentInput } from '../../types/analysis';
import type { WorkspaceSymbolEntry, WorkspaceSymbolSettings } from './model';
import { collectWorkspaceSymbolFiles, excluded, fileIdentity, filePath, insideRoot, isAxelFile } from './files';
import { extractWorkspaceSymbols } from './extract';
import { searchWorkspaceSymbols } from './query';
import { cancellationCheckpoint, throwIfCancelled } from '../../util/cancellation';

interface CachedSymbols { fingerprint: string; entries: WorkspaceSymbolEntry[] }
type Progress = (completed: number, total: number) => void;
export class WorkspaceSymbolIndex {
  private settings: WorkspaceSymbolSettings = { exclude: [], defines: [] };
  private roots: string[] = [];
  private readonly open = new Map<string, AnalyzeDocumentInput>();
  private readonly invalidated = new Set<string>();
  private cache = new Map<string, CachedSymbols>();
  // Completed per-file work survives unrelated edits; only cache is a published snapshot.
  private prepared = new Map<string, CachedSymbols>();
  private revision = 0;
  private started = false;
  private pauseGeneration = 0;
  private dirty = false;
  private disposed = false;
  private running?: Promise<void>;
  private readonly source = new CancellationTokenSource();
  private readonly listeners = new Set<Progress>();
  constructor(private readonly logError: (message: string) => void) {}
  configure(settings: WorkspaceSymbolSettings): void {
    if (JSON.stringify(settings) === JSON.stringify(this.settings)) { return; }
    this.settings = settings; this.prepared = new Map(); this.changed();
  }
  setRoots(uris: readonly string[]): void {
    this.roots = [...new Set(uris.filter(uri => filePath(uri) !== undefined))]; this.changed();
  }
  updateDocument(input: AnalyzeDocumentInput): void {
    const file = filePath(input.uri); if (!file) { return; }
    const key = fileIdentity(file); const previous = this.open.get(key);
    if (previous?.version === input.version && previous.text === input.text) { return; }
    this.open.set(key, input); this.changed();
  }
  closeDocument(uri: string): void {
    const file = filePath(uri); if (file && this.open.delete(fileIdentity(file))) { this.changed(); }
  }
  invalidateFiles(uris: readonly string[]): void {
    if (!uris.length) { return; }
    // Fingerprints handle missed notifications; notified changes also force a read
    // when a filesystem reports coarse timestamps.
    for (const uri of uris) { const file = filePath(uri); if (file) { this.invalidated.add(file); } }
    this.changed();
  }
  start(): void { this.started = true; this.dirty = true; this.schedule(); }
  resume(): void { this.started = true; if (this.dirty) { this.schedule(); } }
  pause(): void { this.started = false; this.revision++; this.pauseGeneration++; }
  private changed(): void { this.revision++; this.dirty = true; if (this.started) { this.schedule(); } }
  private schedule(): void {
    if (this.running || this.disposed || !this.started) { return; }
    this.running = this.run().catch(error => {
      if (!this.disposed) { this.logError(`Workspace symbol index: ${String(error)}`); }
    }).finally(() => { this.running = undefined; if (this.dirty && !this.disposed) { this.schedule(); } });
  }
  private async run(): Promise<void> {
    while (this.dirty && !this.disposed && this.started) {
      await cancellationCheckpoint(this.source.token);
      this.dirty = false;
      const revision = this.revision;
      const next = await this.reconcile();
      if (revision === this.revision) { this.cache = next; this.prepared = new Map(next); }
      else { this.dirty = true; }
    }
  }
  private async reconcile(): Promise<Map<string, CachedSymbols>> {
    const token = this.source.token; const settings = this.settings; const roots = [...this.roots];
    const previous = this.prepared; const opened = [...this.open.values()];
    const invalidated = [...this.invalidated]; this.invalidated.clear();
    for (const file of invalidated) {
      const key = fileIdentity(await realPathOrMissing(file));
      if (!previous.get(key)?.fingerprint.startsWith('open:')) { previous.delete(key); }
    }
    const files = await collectWorkspaceSymbolFiles(roots, settings.exclude, token, this.logError);
    const candidates = new Map<string, { file: string; input?: AnalyzeDocumentInput }>();
    for (const file of files.values()) { candidates.set(fileIdentity(file), { file }); }
    const actualRoots: string[] = [];
    for (const uri of roots) { try { actualRoots.push(await fs.realpath(filePath(uri)!)); } catch { /* logged by enumeration */ } }
    for (const input of opened) {
      const original = filePath(input.uri)!;
      if (!isAxelFile(original)) { continue; }
      const actual = await realPathOrMissing(original);
      const owning = actualRoots.filter(root => insideRoot(actual, root));
      if (roots.length && !owning.length) { continue; }
      const bases = roots.length ? owning : [path.dirname(actual)];
      if (bases.every(root => excluded(path.relative(root, actual), settings.exclude))) { continue; }
      if (await hasLink(original, roots.map(uri => filePath(uri)!))) { continue; }
      candidates.set(fileIdentity(actual), { file: actual, input });
    }
    const result = new Map<string, CachedSymbols>();
    let completed = 0;
    for (const listener of this.listeners) { listener(0, candidates.size); }
    for (const [key, candidate] of candidates) {
      await cancellationCheckpoint(token);
      if (settings !== this.settings || !this.started) { return result; }
      try {
        const stat = candidate.input ? undefined : await fs.stat(candidate.file);
        const fingerprint = candidate.input ? `open:${candidate.input.uri}:${candidate.input.version}:${candidate.input.text}`
          : `${stat!.mtimeMs}:${stat!.ctimeMs}:${stat!.size}`;
        const cached = previous.get(key);
        if (cached?.fingerprint === fingerprint) { result.set(key, cached); }
        else {
          const input = candidate.input ?? { uri: pathToFileURL(candidate.file).toString(), version: 0,
            text: await fs.readFile(candidate.file, 'utf8') };
          const entries = await extractWorkspaceSymbols({ ...input, tool: settings.tool,
            targetPlatform: settings.targetPlatform, internalFeatures: settings.internalFeatures,
            preprocessorSymbols: settings.defines.map(define => {
              const delimiter = define.indexOf('=');
              return delimiter < 0 ? { name: define, value: '1' } : { name: define.slice(0, delimiter), value: define.slice(delimiter + 1) };
            }) }, token);
          const record = { fingerprint, entries };
          previous.set(key, record);
          result.set(key, record);
        }
      } catch (error) {
        previous.delete(key);
        throwIfCancelled(token); this.logError(`Workspace symbol file ${candidate.file}: ${String(error)}`);
      }
      completed++;
      for (const listener of this.listeners) { listener(completed, candidates.size); }
    }
    return result;
  }
  async search(query: string, token: CancellationToken, progress?: Progress): Promise<WorkspaceSymbolEntry[]> {
    const pauseGeneration = this.pauseGeneration;
    throwIfCancelled(token);
    if (this.disposed) { throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Workspace index disposed.'); }
    if (progress) { this.listeners.add(progress); }
    // A joined scan may have enumerated before this request. Reconcile once more
    // so missed events that predate the request are visible; extraction is reused.
    this.started = true;
    this.dirty = true;
    this.schedule();
    let subscription: { dispose(): void } | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        subscription = token.onCancellationRequested(() => reject(new ResponseError(LSPErrorCodes.RequestCancelled, 'Request cancelled.')));
      });
      while (this.running) { await Promise.race([this.running, cancelled]); }
      throwIfCancelled(token);
      if (pauseGeneration !== this.pauseGeneration) { throw new ResponseError(LSPErrorCodes.ContentModified, 'Configuration changed during symbol search.'); }
      const revision = this.revision;
      const entries = [...this.cache.values()].flatMap(item => item.entries);
      const result = await searchWorkspaceSymbols(entries, query, token);
      if (revision !== this.revision) { throw new ResponseError(LSPErrorCodes.ContentModified, 'Workspace changed during symbol search.'); }
      return result;
    } finally { subscription?.dispose(); if (progress) { this.listeners.delete(progress); } }
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.dirty = false; this.source.cancel();
    await this.running; this.source.dispose(); this.cache.clear(); this.prepared.clear(); this.open.clear(); this.listeners.clear();
  }
}

async function realPathOrMissing(file: string): Promise<string> {
  try { return await fs.realpath(file); }
  catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(await realPathOrMissing(parent), path.basename(file));
  }
}
async function hasLink(file: string, roots: readonly string[]): Promise<boolean> {
  const boundary = roots.filter(root => insideRoot(file, root)).sort((a, b) => b.length - a.length)[0];
  let current = file;
  while (current !== boundary) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) { return true; } } catch { /* unsaved or deleted file */ }
    const parent = path.dirname(current);
    if (parent === current || (!boundary && current !== file)) { break; }
    current = parent;
  }
  return false;
}
