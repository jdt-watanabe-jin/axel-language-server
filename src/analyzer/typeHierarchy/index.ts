import * as fs from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import type { AnalysisPosition, AnalyzeDocumentInput, AnalyzedDocument } from '../../types/analysis';
import { cancellationCheckpoint, throwIfCancelled } from '../../util/cancellation';
import { ProjectScope, canonicalPath, fileIdentity, filePath } from '../projectScope';
import { WorkspaceIndex } from '../workspaceIndex';
import { normalizeWorkspaceIndexOptions } from '../workspaceConfig';
import { createTypeTargetContext, resolveTypeTarget, type TypeTargetContext } from '../typeTarget';
import { abstractTypes, collectFunctionTargets, getDeclarations, getTypeDefinitions, navigationTargets, declarationLocation, locationKey, uniqueLocations, type FunctionTargets } from '../navigationTargets';
import type { AnalysisLocation } from '../navigation';
import { classKey, collectTypeHierarchy } from './semantics';
import type { AnalysisTypeHierarchyItem, TypeHierarchyData, TypeHierarchyRecord } from './model';

interface Bundle { abstractTypes: Set<string>; sourceUri: string; functions: FunctionTargets[]; records: TypeHierarchyRecord[]; stamps: Map<string, string> }
interface ActiveContext { bundle: Bundle; context: TypeTargetContext; analysis: AnalyzedDocument; workspace: WorkspaceIndex }
type Progress = (completed: number, total: number) => void;
function changed(): ResponseError<void> { return new ResponseError(LSPErrorCodes.ContentModified, 'Type hierarchy context changed.'); }
function identity(uri: string): string { const file = filePath(uri); return file ? fileIdentity(canonicalPath(file)) : uri; }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** One shared background build; request cancellation never cancels shared indexing. */
export class TypeHierarchyIndex {
  private settings: unknown = {};
  private generation = 0;
  private enabled = false;
  private projectIndexRequested = false;
  private disposed = false;
  private dirty = true;
  private running?: Promise<Bundle[]>;
  private readonly lifetime = new CancellationTokenSource();
  private readonly cache = new Map<string, Bundle>();
  private readonly active = new Map<string, ActiveContext>();
  private readonly loading = new Map<string, Promise<ActiveContext>>();
  private readonly handles = new Map<string, TypeHierarchyData>();
  private readonly issued = new Map<string, string>();
  private readonly progress = new Set<Progress>();
  constructor(private readonly scope: ProjectScope, private readonly opened: () => readonly AnalyzeDocumentInput[],
    private readonly log: (message: string) => void = () => {}) {}

  configure(settings: unknown): void {
    if (JSON.stringify(settings) !== JSON.stringify(this.settings)) {
      this.settings = settings; this.cache.clear(); this.active.clear(); this.invalidate();
    }
  }
  invalidate(uris: readonly string[] = []): void {
    this.generation++; this.dirty = true;
    const dependencies = new Set([...this.cache.values()].flatMap(bundle => [...bundle.stamps.keys()].map(identity)));
    const known = uris.length && uris.every(uri => this.cache.has(identity(uri)) || dependencies.has(identity(uri)));
    for (const [key, bundle] of this.cache) {
      // A new include may resolve a previously missing dependency: all contexts must reconsider it.
      if (!known || uris.some(uri => [...bundle.stamps.keys()].some(dependency => identity(dependency) === identity(uri)))) {
        this.cache.delete(key); this.active.delete(key);
      }
    }
    this.schedule();
  }
  pause(): void { this.enabled = false; this.generation++; this.dirty = true; }
  resume(): void { this.enabled = true; this.schedule(); }
  async dispose(): Promise<void> {
    this.disposed = true; this.enabled = false; this.lifetime.cancel();
    await Promise.allSettled([...this.loading.values(), ...(this.running ? [this.running] : [])]);
    this.cache.clear(); this.active.clear(); this.handles.clear(); this.issued.clear(); this.lifetime.dispose();
  }

  private schedule(): void {
    if (!this.projectIndexRequested || !this.enabled || !this.dirty || this.running || this.disposed) { return; }
    const running = this.build(); this.running = running;
    void running.catch(error => {
      if (!this.disposed && (error as { code?: number }).code !== LSPErrorCodes.ContentModified) {
        this.log(`Type hierarchy indexing: ${String(error)}`);
      }
    }).finally(() => {
      if (this.running === running) { this.running = undefined; }
      if (this.dirty) { this.schedule(); }
    });
  }
  private async stamp(uri: string): Promise<string> {
    const open = this.opened().find(input => identity(input.uri) === identity(uri));
    if (open) { return `open:${open.version}:${digest(open.text)}`; }
    const file = filePath(uri);
    if (!file) { return 'missing'; }
    try {
      const stat = await fs.stat(file);
      return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { return 'missing'; }
      throw error;
    }
  }
  private async current(bundle: Bundle): Promise<boolean> {
    for (const [uri, stamp] of bundle.stamps) { if (await this.stamp(uri) !== stamp) { return false; } }
    return true;
  }
  private async read(uri: string): Promise<AnalyzeDocumentInput> {
    const open = this.opened().find(input => identity(input.uri) === identity(uri));
    if (open) { return open; }
    const file = filePath(uri);
    if (!file) { throw new Error('Type hierarchy requires a file URI.'); }
    return { uri, version: 0, text: await fs.readFile(file, 'utf8') };
  }
  private async load(uri: string, token: CancellationToken, needContext = false): Promise<Bundle> {
    throwIfCancelled(token);
    const key = identity(uri);
    const cached = this.cache.get(key);
    if (cached && (!needContext || this.active.get(key)?.bundle === cached) && await this.current(cached)) { return cached; }
    let pending = this.loading.get(key);
    if (!pending) {
      pending = this.analyze(uri); this.loading.set(key, pending);
      void pending.catch(() => undefined).finally(() => { if (this.loading.get(key) === pending) { this.loading.delete(key); } });
    }
    return (await waitFor(pending, token)).bundle;
  }
  private async analyze(uri: string): Promise<ActiveContext> {
    const generation = this.generation;
    const stamp = await this.stamp(uri);
    const input = await this.read(uri);
    const workspace = new WorkspaceIndex({ ...normalizeWorkspaceIndexOptions(this.settings), dependencyAnalysisOnly: true,
      openDocumentInput: documentUri => this.opened().find(document => identity(document.uri) === identity(documentUri)) });
    try {
      const analysis = await workspace.analyzeRequestDocument(input, this.lifetime.token);
      const typeInput = workspace.callHierarchyTypeInput(analysis);
      const context = createTypeTargetContext(typeInput);
      if (!context) { throw new Error(`No parsed type context for ${uri}`); }
      const records = collectTypeHierarchy(typeInput, context);
      const stamps = new Map<string, string>();
      for (const document of context.documents) {
        await cancellationCheckpoint(this.lifetime.token);
        stamps.set(document.uri, await this.stamp(document.uri));
      }
      if (stamp !== await this.stamp(uri) || generation !== this.generation) { throw changed(); }
      stamps.set(input.uri, stamp);
      const functions = collectFunctionTargets(context);
      const bundle: Bundle = { sourceUri: input.uri, records, functions, abstractTypes: abstractTypes(records, functions), stamps };
      const value: ActiveContext = { bundle, context, analysis, workspace };
      this.cache.set(identity(uri), bundle);
      this.active.delete(identity(uri)); this.active.set(identity(uri), value);
      while (this.active.size > 8) { this.active.delete(this.active.keys().next().value!); }
      return value;
    } finally { workspace.setAnalysisEnabled(false); }
  }
  private async build(): Promise<Bundle[]> {
    this.dirty = false;
    const generation = this.generation;
    const scopeGeneration = this.scope.revision;
    const token = this.lifetime.token;
    const files = await this.scope.collect(token, this.opened().map(input => input.uri), true);
    const bundles: Bundle[] = [];
    let completed = 0;
    for (const listener of this.progress) { listener(0, files.size); }
    for (const uri of files.keys()) {
      await cancellationCheckpoint(token);
      if (generation !== this.generation || scopeGeneration !== this.scope.revision || !this.enabled) { throw changed(); }
      bundles.push(await this.load(uri, token));
      completed++;
      for (const listener of this.progress) { listener(completed, files.size); }
    }
    if (generation !== this.generation || scopeGeneration !== this.scope.revision || !this.enabled) { throw changed(); }
    const needed = new Set([...files.keys()].map(identity));
    for (const key of this.cache.keys()) {
      if (!needed.has(key) && !this.active.has(key)) { this.cache.delete(key); }
    }
    return bundles;
  }
  private async snapshot(token: CancellationToken, progress?: Progress): Promise<Bundle[]> {
    throwIfCancelled(token);
    // Local prepare/supertypes need only their source context. Start whole-project
    // indexing on the first subtype/implementation search, then retain background updates.
    this.projectIndexRequested = true;
    if (progress) { this.progress.add(progress); }
    try {
      // Reconcile metadata even if a client missed a watched-file notification.
      if (!this.running) { this.dirty = true; this.schedule(); }
      const running = this.running;
      if (!running) { throw changed(); }
      const bundles = await waitFor(running, token);
      if (this.dirty) {
        await cancellationCheckpoint(token);
        if (this.running === running) { this.running = undefined; }
        this.schedule();
        return this.snapshot(token);
      }
      return bundles;
    } finally { if (progress) { this.progress.delete(progress); } }
  }
  private item(record: TypeHierarchyRecord, sourceUri: string): AnalysisTypeHierarchyItem {
    const issuedKey = JSON.stringify([sourceUri, record.key]);
    let session = this.issued.get(issuedKey);
    if (!session || !this.handles.has(session)) {
      session = randomUUID(); this.issued.set(issuedKey, session);
      this.handles.set(session, { version: 1, key: record.key, sourceUri, session });
      while (this.handles.size > 4096) {
        const oldest = this.handles.keys().next().value!;
        const old = this.handles.get(oldest)!;
        this.issued.delete(JSON.stringify([old.sourceUri, old.key])); this.handles.delete(oldest);
      }
    }
    return { key: record.key, name: record.name, qualifiedName: record.qualifiedName, kind: record.kind,
      uri: record.uri, range: record.range, selectionRange: record.selectionRange,
      detail: `${record.qualifiedName} — ${record.uri}${sourceUri !== record.uri ? ` (context: ${sourceUri})` : ''}`,
      data: { ...this.handles.get(session)! } };
  }
  private async target(data: unknown, token: CancellationToken): Promise<{ bundle: Bundle; record: TypeHierarchyRecord } | undefined> {
    if (!data || typeof data !== 'object') { return undefined; }
    const item = data as Partial<TypeHierarchyData>;
    if (item.version !== 1 || typeof item.session !== 'string') { return undefined; }
    const known = this.handles.get(item.session);
    if (!known || known.key !== item.key || known.sourceUri !== item.sourceUri) { return undefined; }
    if (await this.stamp(known.sourceUri) === 'missing') { return undefined; }
    const bundle = await this.load(known.sourceUri, token);
    const record = bundle.records.find(record => record.key === known.key);
    if (!record) { this.handles.delete(item.session); return undefined; }
    return { bundle, record };
  }

  async navigate(kind: 'declaration' | 'typeDefinition' | 'implementation', uri: string, position: AnalysisPosition, token: CancellationToken): Promise<AnalysisLocation[]> {
    if (!this.opened().some(input => identity(input.uri) === identity(uri))) { return []; }
    const bundle = await this.load(uri, token, true);
    const current = this.active.get(identity(uri));
    if (!current || current.bundle !== bundle) { throw changed(); }
    const input = { analysis: current.analysis, position, workspaceIndex: current.workspace };
    if (kind === 'declaration') { return getDeclarations(input, current.context, bundle.functions); }
    if (kind === 'typeDefinition') { return getTypeDefinitions(input, current.context); }
    const target = resolveTypeTarget(input, current.context);
    const typeKey = target?.classInfo && classKey(target.classInfo);
    const targets = navigationTargets(input);
    const memberKeys = new Set(targets.map(target => locationKey(declarationLocation(target))));
    const sourceFunctions = bundle.functions.filter(record => record.members.some(member => memberKeys.has(locationKey(member))));
    if (!typeKey && !sourceFunctions.length) { return []; }
    // Metadata and conditional context must agree with the source request, just like subtype navigation.
    const generation = this.generation;
    const bundles = await this.snapshot(token);
    if (generation !== this.generation) { throw changed(); }
    const results: AnalysisLocation[] = [];
    const sourceType = typeKey && bundle.records.find(record => record.key === typeKey);
    if (sourceType) {
      const signature = await variant(sourceType, bundle, token);
      for (const candidate of bundles) {
        await cancellationCheckpoint(token);
        const base = candidate.records.find(record => record.key === sourceType.key);
        if (!base || await variant(base, candidate, token) !== signature) { continue; }
        const reachable = new Set([base.key]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const record of candidate.records) {
            if (!reachable.has(record.key) && record.bases.some(key => reachable.has(key))) { reachable.add(record.key); changed = true; }
          }
          await cancellationCheckpoint(token);
        }
        results.push(...candidate.records.filter(record => record.key !== base.key && record.defined && !candidate.abstractTypes.has(record.key) && reachable.has(record.key)
          && this.scope.contains(record.uri)).map(record => ({uri:record.uri,range:record.selectionRange})));
      }
    } else {
      const known = new Set(sourceFunctions.flatMap(record => record.members.map(locationKey)));
      const signatures = new Set(sourceFunctions.map(record => record.signature));
      const owners = bundle.records.filter(record => sourceFunctions.some(fn => fn.owner === record.key));
      const records: FunctionTargets[] = [...bundle.functions];
      for (const candidate of bundles) {
        await cancellationCheckpoint(token);
        let compatible = true;
        for (const owner of owners) {
          const other = candidate.records.find(record => record.key === owner.key);
          if (!other || await variant(other, candidate, token) !== await variant(owner, bundle, token)) { compatible = false; break; }
        }
        if (compatible) { records.push(...candidate.functions.filter(record => signatures.has(record.signature))); }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of records) {
          if (!record.members.some(member => known.has(locationKey(member))) && !record.bases.some(base => known.has(locationKey(base)))) { continue; }
          for (const member of record.members) { const key = locationKey(member); if (!known.has(key)) { known.add(key); changed = true; } }
        }
        await cancellationCheckpoint(token);
      }
      for (const record of records) {
        if (record.members.some(member => known.has(locationKey(member)))) { results.push(...record.definitions.filter(location => this.scope.contains(location.uri))); }
      }
    }
    throwIfCancelled(token);
    if (generation !== this.generation) { throw changed(); }
    return uniqueLocations(results);
  }

  async prepare(uri: string, position: AnalysisPosition, token: CancellationToken): Promise<AnalysisTypeHierarchyItem[] | null> {
    if (!this.opened().some(input => identity(input.uri) === identity(uri))) { return null; }
    const bundle = await this.load(uri, token, true);
    const current = this.active.get(identity(uri));
    if (!current || current.bundle !== bundle) { throw changed(); }
    const target = resolveTypeTarget({ analysis: current.analysis, position, workspaceIndex: current.workspace }, current.context);
    const key = target?.classInfo && classKey(target.classInfo);
    const record = key && bundle.records.find(record => record.key === key);
    return record ? [this.item(record, bundle.sourceUri)] : null;
  }
  async supertypes(data: unknown, token: CancellationToken): Promise<AnalysisTypeHierarchyItem[] | null> {
    const target = await this.target(data, token);
    return target ? ordered(target.record.bases.flatMap(key => {
      const record = target.bundle.records.find(record => record.key === key);
      return record ? [this.item(record, target.bundle.sourceUri)] : [];
    })) : null;
  }
  async subtypes(data: unknown, token: CancellationToken, progress?: Progress): Promise<AnalysisTypeHierarchyItem[] | null> {
    const target = await this.target(data, token);
    if (!target) { return null; }
    const revision = this.generation;
    const bundles = await this.snapshot(token, progress);
    if (revision !== this.generation) { throw changed(); }
    const signature = await variant(target.record, target.bundle, token);
    const results = new Map<string, AnalysisTypeHierarchyItem>();
    for (const bundle of bundles) {
      await cancellationCheckpoint(token);
      const base = bundle.records.find(record => record.key === target.record.key);
      if (!base || await variant(base, bundle, token) !== signature) { continue; }
      for (const record of bundle.records) {
        if (!record.bases.includes(base.key) || !this.scope.contains(record.uri)) { continue; }
        const key = `${record.key}:${await variant(record, bundle, token)}`;
        if (!results.has(key)) { results.set(key, this.item(record, bundle.sourceUri)); }
      }
    }
    return ordered([...results.values()]);
  }
}

const variants = new WeakMap<Bundle, { records: Map<string, TypeHierarchyRecord>; signatures: Map<string, string> }>();
async function variant(record: TypeHierarchyRecord, bundle: Bundle, token: CancellationToken): Promise<string> {
  let cached = variants.get(bundle);
  if (!cached) {
    cached = { records: new Map(bundle.records.map(record => [record.key, record])), signatures: new Map() };
    variants.set(bundle, cached);
  }
  const signature = cached.signatures.get(record.key);
  if (signature) { return signature; }
  // Hash the reachable graph once per vertex, not once per inheritance path.
  // This is finite for cycles and linear for repeated diamonds.
  const visited = new Map<string, TypeHierarchyRecord>();
  const pending = [record];
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current.key)) { continue; }
    visited.set(current.key, current);
    if (visited.size % 128 === 0) { await cancellationCheckpoint(token); }
    for (const key of current.bases) { const base = cached.records.get(key); if (base) { pending.push(base); } }
  }
  throwIfCancelled(token);
  const result = digest(JSON.stringify([...visited.values()].sort((a, b) => a.key.localeCompare(b.key))
    .map(value => [value.key, value.shape, [...value.bases].sort()])));
  cached.signatures.set(record.key, result); return result;
}
function ordered(items: AnalysisTypeHierarchyItem[]): AnalysisTypeHierarchyItem[] {
  return items.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName) || a.uri.localeCompare(b.uri)
    || a.selectionRange.start.line - b.selectionRange.start.line || a.selectionRange.start.character - b.selectionRange.start.character
    || a.data.sourceUri.localeCompare(b.data.sourceUri));
}
async function waitFor<T>(promise: Promise<T>, token: CancellationToken): Promise<T> {
  throwIfCancelled(token);
  let subscription: { dispose(): void } | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      subscription = token.onCancellationRequested(() => reject(new ResponseError(LSPErrorCodes.RequestCancelled, 'Request cancelled.')));
    })]);
  } finally { subscription?.dispose(); }
}
