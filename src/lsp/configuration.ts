import { normalizeProjectSettings, validProjectPattern } from '../analyzer/projectScope';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import { throwIfCancelled } from '../util/cancellation';
import { TARGET_PLATFORMS } from '../analyzer/targetPlatform';
import { normalizeWorkspaceIndexOptions } from '../analyzer/workspaceConfig';
import { normalizeInlayHintsSettings } from './inlayHints';

export type Settings = Record<string, unknown>;

/** Stable effective values: unknown keys and explicitly written defaults are immaterial. */
export function configurationKeys(settings: Settings) {
  const options = normalizeWorkspaceIndexOptions(settings);
  const analysis = { ...options, sxmHome: options.sxmHome ?? '', defines: options.defines ?? [],
    tool: options.tool ?? 'axel', targetPlatform: options.targetPlatform ?? 'windows-x64',
    internalFeatures: options.internalFeatures ?? 'enabled', maxNumberOfProblems: options.maxNumberOfProblems ?? null };
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return {
    analysis: canonical(analysis),
    features: canonical({ workspaceSymbols: settings.workspaceSymbols ?? 'Just My Code', hover: settings.hover ?? 'default', autocomplete: settings.autocomplete ?? 'default',
      errorSquiggles: settings.errorSquiggles ?? 'enabledIfIncludesResolve', inlayHints: normalizeInlayHintsSettings(settings),
      codeLens: { enabled: (settings.codeLens as Settings | undefined)?.enabled === true } }),
    symbols: canonical({ project: normalizeProjectSettings(settings),
      defines: analysis.defines, tool: analysis.tool, targetPlatform: analysis.targetPlatform, internalFeatures: analysis.internalFeatures }),
    files: canonical({ includeRoots: analysis.includeRoots, project: normalizeProjectSettings(settings),
      updateIncludesOnRename: (settings.fileOperations as Settings | undefined)?.updateIncludesOnRename ?? true })
  };
}

function object(value: unknown): value is Settings {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the complete snapshot before any consumer sees it. */
export function validateSettings(value: unknown): Settings {
  if (!object(value)) { throw new Error('axel configuration must be an object.'); }
  const fail = (key: string): never => { throw new Error(`Invalid AXEL setting: ${key}`); };
  for (const key of ['includeRoots', 'forcedIncludeRoots', 'forcedIncludeFiles', 'defines']) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(item => typeof item === 'string'))) { fail(key); }
  }
  if (value.sxmHome !== undefined && typeof value.sxmHome !== 'string') { fail('sxmHome'); }
  if (value.maxNumberOfProblems !== undefined && (typeof value.maxNumberOfProblems !== 'number'
    || !Number.isFinite(value.maxNumberOfProblems) || value.maxNumberOfProblems <= 0)) { fail('maxNumberOfProblems'); }
  if (object(value.workspaceSymbols) && Object.prototype.hasOwnProperty.call(value.workspaceSymbols, 'exclude')) { fail('workspaceSymbols.exclude (removed; use project.exclude)'); }
  const enums: Record<string, string[]> = {
    tool: ['axel', 'ismo', 'asca', 'spicechart'], targetPlatform: Object.keys(TARGET_PLATFORMS),
    internalFeatures: ['enabled', 'disabled'], hover: ['default', 'disabled'], autocomplete: ['default', 'disabled'],
    errorSquiggles: ['enabled', 'disabled', 'enabledIfIncludesResolve'], workspaceSymbols: ['All', 'Just My Code']
  };
  for (const [key, choices] of Object.entries(enums)) {
    if (value[key] !== undefined && !choices.includes(value[key] as string)) { fail(key); }
  }
  for (const key of ['fileOperations']) {
    const group = value[key];
    if (group === undefined) { continue; }
    if (!object(group)) { fail(key); }
    const settings = group as Settings;
    if (Object.prototype.hasOwnProperty.call(settings, 'exclude')) { fail(`${key}.exclude (removed; use project.exclude)`); }
    if (key === 'fileOperations' && settings.updateIncludesOnRename !== undefined && typeof settings.updateIncludesOnRename !== 'boolean') {
      fail('fileOperations.updateIncludesOnRename');
    }
  }
  if (value.project !== undefined) {
    if (!object(value.project)) { fail('project'); }
    for (const key of ['include', 'exclude']) {
      const patterns = (value.project as Settings)[key];
      if (patterns !== undefined && (!Array.isArray(patterns) || !patterns.every(validProjectPattern))) { fail(`project.${key}`); }
    }
  }
  if (value.codeLens !== undefined) {
    if (!object(value.codeLens)) { fail('codeLens'); }
    const enabled = (value.codeLens as Settings).enabled;
    if (enabled !== undefined && typeof enabled !== 'boolean') { fail('codeLens.enabled'); }
  }
  if (value.inlayHints !== undefined) {
    if (!object(value.inlayHints)) { fail('inlayHints'); }
    const names = (value.inlayHints as Settings).parameterNames;
    if (names !== undefined) {
      if (!object(names)) { fail('inlayHints.parameterNames'); }
      for (const key of ['enabled', 'suppressWhenArgumentContainsName']) {
        if ((names as Settings)[key] !== undefined && typeof (names as Settings)[key] !== 'boolean') { fail(`inlayHints.parameterNames.${key}`); }
      }
    }
  }
  // Copy so callers cannot mutate the accepted snapshot after validation.
  return JSON.parse(JSON.stringify(value)) as Settings;
}

export class ConfigurationManager {
  settings: Settings = {};
  isReady = false;
  private generation = 0;
  private running?: Promise<void>;
  private disposed = false;
  private failure = 'AXEL configuration has not been acquired.';
  private resume!: () => void;
  private readonly started = new Promise<void>(resolve => { this.resume = resolve; });
  private source?: CancellationTokenSource;
  constructor(private readonly fetch: (token: CancellationToken) => Promise<unknown>,
    private readonly apply: (settings: Settings) => void, private readonly invalidate: () => void,
    private readonly reportError: (message: string) => void, private readonly timeoutMs = 5_000,
    private readonly settled: (changed: boolean) => void = () => {}) {}

  start(): void { this.refresh(); this.resume(); }
  refresh(): void {
    if (this.disposed) { return; }
    this.generation++;
    const previouslyReady = this.isReady;
    this.isReady = false;
    this.invalidate();
    if (!this.running) {
      this.running = this.acquire(previouslyReady).finally(() => { this.running = undefined; });
    }
  }
  private async acquire(previouslyReady: boolean): Promise<void> {
    while (!this.disposed) {
      const generation = this.generation;
      let timer: NodeJS.Timeout | undefined;
      const source = new CancellationTokenSource(); this.source = source;
      try {
        const result = await Promise.race([this.fetch(source.token), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { source.cancel(); reject(new Error('AXEL configuration request timed out.')); }, this.timeoutMs);
        })]);
        if (this.disposed) { return; }
        if (generation !== this.generation) { continue; }
        const next = validateSettings(result);
        const changed = !previouslyReady || JSON.stringify(configurationKeys(next)) !== JSON.stringify(configurationKeys(this.settings));
        if (changed) {
          this.settings = next;
          this.apply(next);
        }
        this.isReady = true;
        this.settled(changed);
        return;
      } catch (error) {
        if (this.disposed) { return; }
        if (generation !== this.generation) { continue; }
        this.failure = `AXEL configuration unavailable: ${error instanceof Error ? error.message : String(error)}`;
        this.reportError(this.failure);
        return;
      } finally { clearTimeout(timer); source.dispose(); }
    }
  }
  async ready(token: CancellationToken): Promise<void> {
    throwIfCancelled(token);
    let subscription: { dispose(): void } | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      subscription = token.onCancellationRequested(() => reject(new ResponseError(LSPErrorCodes.RequestCancelled, 'Request cancelled.')));
    });
    try {
      await Promise.race([this.started, cancelled]);
      while (this.running) { await Promise.race([this.running, cancelled]); }
      throwIfCancelled(token);
      if (!this.isReady || this.disposed) { throw new ResponseError(LSPErrorCodes.RequestFailed, this.failure); }
    } finally { subscription?.dispose(); }
  }
  dispose(): void { this.disposed = true; this.isReady = false; this.source?.cancel(); this.resume(); }
}
