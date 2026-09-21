import { CancellationToken, CancellationTokenSource, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import * as fs from 'fs/promises';
import { pathToFileURL } from 'url';
import type { AnalyzeDocumentInput } from '../../types/analysis';
import type { WorkspaceSymbolEntry, WorkspaceSymbolSettings } from './model';
import { ProjectScope, canonicalPath, fileIdentity, filePath } from '../projectScope';
import { extractWorkspaceSymbols } from './extract';
import { searchWorkspaceSymbols } from './query';
import { cancellationCheckpoint, isCancellationError, throwIfCancelled } from '../../util/cancellation';

interface CachedSymbols { fingerprint: string; entries: WorkspaceSymbolEntry[] }
type Progress = (completed: number, total: number) => void;
export class WorkspaceSymbolIndex {
  private settings: WorkspaceSymbolSettings = { project: { include: ['**/*'], exclude: [] }, defines: [] };
  private readonly open = new Map<string, AnalyzeDocumentInput>();
  private readonly invalidated = new Set<string>();
  private cache = new Map<string, CachedSymbols>();
  // Completed per-file work survives unrelated edits; only cache is a published snapshot.
  private prepared = new Map<string, CachedSymbols>();
  private revision = 0;
  private started = false;
  private paused = false;
  private pauseGeneration = 0;
  private dirty = false;
  private disposed = false;
  private running?: Promise<void>;
  private source?: CancellationTokenSource;
  private waiters = 0;
  private readonly backgroundOwners = new Set<symbol>();
  private readonly listeners = new Set<Progress>();
  constructor(private readonly logError: (message: string) => void, private readonly projectScope = new ProjectScope(logError)) {}
  configure(settings: WorkspaceSymbolSettings): void {
    if (JSON.stringify(settings) === JSON.stringify(this.settings)) { return; }
    this.projectScope.configure(settings.project);
    this.settings = settings; this.prepared = new Map(); this.changed();
  }
  setRoots(uris: readonly string[]): void {
    this.projectScope.setRoots(uris); this.changed();
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
  async start(progress?: Progress): Promise<void> {
    this.dirty = true;
    await this.resume(progress);
  }
  cancelBackground(): void { this.started = false; this.backgroundOwners.clear(); this.stopIfUnowned(); }
  private stopIfUnowned(): void {
    if (this.backgroundOwners.size === 0 && this.waiters === 0 && this.source) { this.dirty = true; this.source.cancel(); }
  }
  async resume(progress?: Progress): Promise<void> {
    if (progress) { this.listeners.add(progress); }
    const owner = Symbol(); this.backgroundOwners.add(owner);
    this.paused = false; this.started = true; if (this.dirty) { this.schedule(); }
    try { while (this.running) { await this.running; } }
    finally {
      if (progress) { this.listeners.delete(progress); }
      this.backgroundOwners.delete(owner); this.stopIfUnowned();
    }
  }
  pause(): void { this.paused = true; this.started = false; this.backgroundOwners.clear(); this.revision++; this.pauseGeneration++; this.dirty = true; this.source?.cancel(); }
  private changed(): void {
    this.revision++; this.dirty = true;
    if (this.started && this.backgroundOwners.size === 0) { void this.resume(); }
    else { this.schedule(); }
  }
  private schedule(): void {
    if (this.running || this.disposed || this.paused || (this.backgroundOwners.size === 0 && this.waiters === 0)) { return; }
    const source = new CancellationTokenSource(); this.source = source;
    this.running = this.run(source.token).catch(error => {
      if (!this.disposed && !isCancellationError(error)) { this.logError(`Workspace symbol index: ${String(error)}`); }
    }).finally(() => { source.dispose(); if (this.source === source) { this.source = undefined; } this.running = undefined; if (this.dirty && !this.disposed) { this.schedule(); } });
  }
  private async run(token: CancellationToken): Promise<void> {
    while (this.dirty && !this.disposed && !this.paused && (this.backgroundOwners.size > 0 || this.waiters > 0)) {
      await cancellationCheckpoint(token);
      this.dirty = false;
      const revision = this.revision;
      const next = await this.reconcile(token);
      throwIfCancelled(token);
      if (revision === this.revision) { this.cache = next; this.prepared = new Map(next); }
      else { this.dirty = true; }
    }
  }
  private async reconcile(token: CancellationToken): Promise<Map<string, CachedSymbols>> {
    const settings = this.settings;
    const previous = this.prepared; const opened = [...this.open.values()];
    const invalidated = [...this.invalidated]; this.invalidated.clear();
    for (const file of invalidated) {
      const key = fileIdentity(canonicalPath(file));
      if (!previous.get(key)?.fingerprint.startsWith('open:')) { previous.delete(key); }
    }
    const files = await this.projectScope.collect(token, opened.map(input => input.uri));
    const candidates = new Map<string, { file: string; input?: AnalyzeDocumentInput }>();
    for (const file of files.values()) { candidates.set(fileIdentity(file), { file }); }
    for (const input of opened) {
      if (!this.projectScope.contains(input.uri)) { continue; }
      const file = canonicalPath(filePath(input.uri)!);
      const candidate = candidates.get(fileIdentity(file));
      if (candidate) { candidate.input = input; }
    }
    const result = new Map<string, CachedSymbols>();
    let completed = 0;
    for (const listener of this.listeners) { listener(0, candidates.size); }
    for (const [key, candidate] of candidates) {
      await cancellationCheckpoint(token);
      if (settings !== this.settings) { return result; }
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
  async rebuild(token: CancellationToken, progress?: Progress): Promise<void> {
    throwIfCancelled(token);
    this.cache = new Map(); this.prepared = new Map();
    this.revision++; this.dirty = true;
    await this.waitForScan(token, progress);
  }
  private async waitForScan(token: CancellationToken, progress?: Progress): Promise<void> {
    const pauseGeneration = this.pauseGeneration;
    throwIfCancelled(token);
    if (this.disposed) { throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Workspace index disposed.'); }
    if (progress) { this.listeners.add(progress); }
    // A joined scan may have enumerated before this request. Reconcile once more
    // so missed events that predate the request are visible; extraction is reused.
    this.paused = false; this.waiters++;
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
    } finally { subscription?.dispose(); if (progress) { this.listeners.delete(progress); } this.waiters--; this.stopIfUnowned(); }
  }
  async search(query: string, token: CancellationToken, progress?: Progress): Promise<WorkspaceSymbolEntry[]> {
    await this.waitForScan(token, progress);
    const revision = this.revision;
    const entries = [...this.cache.values()].flatMap(item => item.entries);
    const result = await searchWorkspaceSymbols(entries, query, token);
    if (revision !== this.revision) { throw new ResponseError(LSPErrorCodes.ContentModified, 'Workspace changed during symbol search.'); }
    return result;
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.dirty = false; this.source?.cancel();
    await this.running; this.cache.clear(); this.prepared.clear(); this.open.clear(); this.listeners.clear();
  }
}
