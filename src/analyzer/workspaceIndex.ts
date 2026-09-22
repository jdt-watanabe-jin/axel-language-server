import { rebindAnalysis } from './analysisIdentity';
import type { DocumentLinkCandidate } from './documentLinks';
import { collectSemanticTokens } from './semanticTokens';
import type { ProjectScope } from './projectScope';
import type { FoldingRangeCandidate } from './foldingRanges';
import { CancellationToken, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import { throwIfCancelled } from '../util/cancellation';
import { createCallResolver } from './typeChecking/callResolution';
import { runAnalysisSteps, runAnalysisStepsAsync, scopedAnalysisSteps, readAnalysisFile, statAnalysisFile, type AnalysisStep } from '../util/analysisSteps';
import { bindDocumentation } from './documentation/index';
import { resolveLoginPath } from './loginPath';
import { buildLoginScopeSteps, type LoginScopeSnapshot } from './loginScope';
import type { DocumentationBindings } from './documentation/model';
import { affectedBySyntaxRecovery } from './syntaxRecovery';
import { normalizeTargetPlatform } from './targetPlatform';
import { descendants, field } from './typeChecking/syntax';
import { collectTypeDiagnosticsSteps, type TypeDiagnosticsInput } from './typeChecking/diagnostics';
import { loadBuiltinCatalog, type BuiltinCatalog } from './typeChecking/builtinCatalog';
import * as fs from 'fs';
import { containsSourcePosition, isSystemMacroName, normalizeInternalFeatures, normalizeTool } from './systemMacros';
import { message } from '../i18n/messages';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type {
  AnalysisDeclaration,
  AnalysisDiagnostic,
  AnalysisGuiClass,
  AnalysisMacroDefinition,
  AnalysisPosition,
  AnalysisPreprocessorSymbol,
  AnalysisRange,
  AnalysisResolvedInclude,
  AnalysisResolvedScriptExecution,
  AnalyzeDocumentInput,
  AnalyzedDocument
} from '../types/analysis';
import { DocumentAnalyzer } from './documentAnalyzer';
import { WorkspaceDerivedCache } from './workspaceDerivedCache';
import { collectForcedIncludeFiles, type ForcedIncludeOptions } from './forcedIncludes';
import { isIncludeFile, resolveInclude, resolveScriptExecution, type IncludeResolution } from './includeResolver';
import type { WorkspaceDeclarationLookup } from './resolution';
import { collectSemanticDiagnostics } from './semanticDiagnostics';
import { normalizeWorkspaceIndexOptions } from './workspaceConfig';
import { collectIncludeResolutionStatus, type IncludeResolutionStatus } from './includeDiagnostics';
import { measureDurationMs, NullLogger, type AnalysisLogger } from '../util/logger';

export interface WorkspaceIndexOptions extends ForcedIncludeOptions {
  sxmHome?: string;
  openDocumentInput?: (uri: string) => AnalyzeDocumentInput | undefined;
  inheritIncludeContext?: boolean;
  dependencyAnalysisOnly?: boolean;
  tool?: string;
  targetPlatform?: string;
  internalFeatures?: string;
  includeRoots?: string[];
  defines?: string[];
  analyzer?: DocumentAnalyzer;
  maxNumberOfProblems?: number;
  logger?: AnalysisLogger;
}

interface IndexedDocument {
  text?: string;
  analysis: AnalyzedDocument;
  filePath?: string;
  version?: number;
  mtimeMs?: number;
  workspaceDiagnosticsComplete?: boolean;
  workspaceIndexComplete?: boolean;
}

export class WorkspaceIndex {
  private projectScope?: ProjectScope;
  public setProjectScope(scope: ProjectScope): void { this.projectScope = scope; this.requestRevision++; }
  private requestAnalysisActive = false;
  private requestRevision = 0;
  private requestTail: Promise<unknown> = Promise.resolve();
  private sxmHome: string;
  private loginSnapshot?: LoginScopeSnapshot;
  private loginGeneration = 0;
  private readonly reusedDependencyOpens = new Map<string, string>();
  private readonly openInputs = new Map<string, AnalyzeDocumentInput>();
  private readonly openDocumentInput?: (uri: string) => AnalyzeDocumentInput | undefined;
  private readonly inheritIncludeContext: boolean;
  private readonly dependencyAnalysisOnly: boolean;
  private readonly includeContexts = new Map<string, Pick<AnalyzeDocumentInput, 'macroDefinitions' | 'preprocessorSymbols'>>();
  private readonly semanticResultCache = new Map<string, {analysis:AnalyzedDocument; declarations:AnalysisDeclaration[]; tokens:ReturnType<typeof collectSemanticTokens>}>();
  private readonly typeInputCache = new Map<string, TypeDiagnosticsInput>();
  private readonly callResolutionCache = new Map<string, { documents: AnalyzedDocument[]; catalog: BuiltinCatalog; resolve: ReturnType<typeof createCallResolver> }>();
  private readonly documentationCache = new Map<string, { documents: AnalyzedDocument[]; bindings: DocumentationBindings }>();
  private readonly visibleDeclarationsCache = new Map<string, AnalysisDeclaration[]>();
  private readonly cachedVisibleDeclarationsCache = new Map<string, AnalysisDeclaration[]>();
  private readonly definiteVisibleUrisCache = new Map<string, string[]>();
  private readonly derivedCache = new WorkspaceDerivedCache([
    this.documentationCache, this.callResolutionCache, this.typeInputCache, this.semanticResultCache,
    this.visibleDeclarationsCache, this.cachedVisibleDeclarationsCache, this.definiteVisibleUrisCache
  ]);
  private readonly analyzer: DocumentAnalyzer;
  private readonly outlineAnalyzer = new DocumentAnalyzer();
  private includeRoots: string[];
  private forcedIncludeRoots: string[];
  private forcedIncludeFiles: string[];
  private builtinCatalogCache: BuiltinCatalog | undefined;
  private defines: string[];
  private tool: string;
  private targetPlatform: string;
  private internalFeatures: string;
  private maxNumberOfProblems: number | undefined;
  private readonly logger: AnalysisLogger;
  private readonly documents = new Map<string, IndexedDocument>();
  private readonly diagnosticIncludeDependencies = new Map<string, Set<string>>();
  private readonly includeCandidateDependencies = new Map<string, Set<string>>();
  private readonly includeGraph = new Map<string, Set<string>>();
  private readonly definiteIncludeGraph = new Map<string, Set<string>>();
  private readonly reverseIncludeGraph = new Map<string, Set<string>>();
  private includeResolutionCache: Map<string, IncludeResolution> | undefined;
  private forcedIncludeFileCache: string[] | undefined;
  private indexingForcedIncludes = false;
  private forcedIncludesIndexed = false;
  private readonly pendingBackgroundDocuments = new Map<string, string>();
  private backgroundIndexingScheduled = false;
  private backgroundScheduleGeneration = 0;
  private backgroundActivity = false;
  private readonly backgroundActivityListeners = new Set<(active: boolean) => void>();
  private backgroundGeneration = 0;
  private pendingLoginIndexing = false;
  private backgroundStepping = false;
  private backgroundChanged = false;
  private activeBackground: { uri: string; filePath: string; generation: number; rollback: () => void; login?: boolean; resolutions: Map<string, IncludeResolution>; steps: Generator<AnalysisStep, void, void> } | undefined;
  private readonly backgroundWaiters: (() => void)[] = [];
  private readonly backgroundCompleteListeners: ((changed: boolean) => void)[] = [];

  public constructor(options: WorkspaceIndexOptions = {}, forcedIncludesSource?: WorkspaceIndex) {
    this.sxmHome = options.sxmHome ?? '';
    this.openDocumentInput = options.openDocumentInput;
    this.inheritIncludeContext = options.inheritIncludeContext ?? false;
    this.dependencyAnalysisOnly = options.dependencyAnalysisOnly ?? false;
    this.logger = options.logger ?? NullLogger;
    this.analyzer = options.analyzer ?? new DocumentAnalyzer(undefined, this.logger);
    this.includeRoots = normalizePaths(options.includeRoots ?? []);
    this.forcedIncludeRoots = normalizePaths(options.forcedIncludeRoots ?? []);
    this.forcedIncludeFiles = normalizePaths(options.forcedIncludeFiles ?? []);
    this.defines = options.defines ?? [];
    this.internalFeatures = normalizeInternalFeatures(options.internalFeatures);
    this.tool = normalizeTool(options.tool);
    this.targetPlatform = normalizeTargetPlatform(options.targetPlatform);
    this.logSystemMacroConfiguration(options);
    this.maxNumberOfProblems = options.maxNumberOfProblems;
    if (forcedIncludesSource?.forcedIncludesIndexed) { this.reuseForcedIncludes(forcedIncludesSource); }
  }

  /** Clone index containers; only completed immutable analysis generations are shared. */
  private reuseForcedIncludes(source: WorkspaceIndex): void {
    const pending = [...source.knownForcedIncludeUris()];
    const visited = new Set<string>();
    while (pending.length) {
      const uri = pending.pop()!;
      if (visited.has(uri)) { continue; }
      visited.add(uri);
      const document = source.documents.get(uri);
      if (!document) { continue; }
      this.setIndexedDocument(uri, { ...document });
      const includes = new Set(source.includeGraph.get(uri));
      this.replaceIncludeEdges(uri, includes, new Set(source.definiteIncludeGraph.get(uri)));
      pending.push(...includes);
    }
    this.forcedIncludeFileCache = [...source.getForcedIncludeFiles()];
    this.forcedIncludesIndexed = true;
  }
  public configure(options: unknown): void {
    this.requestRevision++;
    this.logSystemMacroConfiguration(options);
    const merged = normalizeWorkspaceIndexOptions(options);

    this.sxmHome = merged.sxmHome ?? '';
    this.loginGeneration++;
    this.loginSnapshot = undefined;
    this.includeRoots = normalizePaths(merged.includeRoots ?? []);
    this.forcedIncludeRoots = normalizePaths(merged.forcedIncludeRoots ?? []);
    this.forcedIncludeFiles = normalizePaths(merged.forcedIncludeFiles ?? []);
    this.defines = merged.defines ?? [];
    this.internalFeatures = normalizeInternalFeatures(merged.internalFeatures);
    this.tool = normalizeTool(merged.tool);
    this.targetPlatform = normalizeTargetPlatform(merged.targetPlatform);
    this.maxNumberOfProblems = merged.maxNumberOfProblems;
    this.forcedIncludeFileCache = undefined;
    this.clearCachedAnalysis();
  }

  /** Invalidate all derived state while retaining authoritative open document inputs. */
  public async rebuildAnalysis(token: CancellationToken): Promise<void> {
    throwIfCancelled(token);
    this.requestRevision++;
    this.loginGeneration++; this.loginSnapshot = undefined;
    this.forcedIncludeFileCache = undefined;
    this.clearCachedAnalysis();
  }

  public analyzeDocument(input: AnalyzeDocumentInput): AnalyzedDocument {
    return this.indexOpenDocument(input);
  }

  private analysisEnabled = true;
  public setAnalysisEnabled(enabled: boolean): void {
    this.analysisEnabled = enabled;
    if (!enabled) { this.setBackgroundActivity(false); }
    if (enabled && (this.activeBackground || this.pendingLoginIndexing || this.pendingBackgroundDocuments.size)) { this.scheduleBackgroundIndexing(); }
  }

  /** Requests share caches, but yield between tree passes and dependency I/O. */
  public async analyzeRequestDocument(input: AnalyzeDocumentInput, token: CancellationToken, diagnostics = true): Promise<AnalyzedDocument> {
    throwIfCancelled(token);
    this.updateOpenDocument(input);
    return this.analyzeCooperatively(input, token, () => this.requestDocumentSteps(input, diagnostics));
  }

  private *requestDocumentSteps(input: AnalyzeDocumentInput, diagnostics: boolean): Generator<AnalysisStep, AnalyzedDocument, void> {
    // Reference search spans other open files too. Restore their foreground indexes after an invalidation.
    for (const open of this.openInputs.values()) {
      if (open.uri !== input.uri && this.documents.get(open.uri)?.version !== open.version) {
        yield* this.foregroundDocumentSteps(open);
      }
    }
    return yield* this.indexOpenDocumentSteps(input, this.indexingForcedIncludes, new Map(), diagnostics);
  }

  public async analyzeForegroundDocumentAsync(input: AnalyzeDocumentInput, token: CancellationToken): Promise<AnalyzedDocument> {
    throwIfCancelled(token);
    this.updateOpenDocument(input);
    return this.analyzeCooperatively(input, token, () => this.foregroundDocumentSteps(input));
  }

  private async analyzeCooperatively(input: AnalyzeDocumentInput, token: CancellationToken,
    steps: () => Generator<AnalysisStep, AnalyzedDocument, void>): Promise<AnalyzedDocument> {
    const queuedRevision = this.requestRevision;
    const previous = this.requestTail;
    let release!: () => void;
    this.requestTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      throwIfCancelled(token);
      if (queuedRevision !== this.requestRevision) {
        throw new ResponseError(LSPErrorCodes.ContentModified, 'Workspace changed while analysis was queued.');
      }
      this.interruptBackgroundAnalysis();
      this.rememberOpenInput(input);
      const generation = this.requestRevision;
      const rollback = this.analysisRollback(generation);
      this.requestAnalysisActive = true;
      const resolutions = new Map<string, IncludeResolution>();
      try {
        return await runAnalysisStepsAsync(steps(), token, () => {
          if (generation !== this.requestRevision) {
            throw new ResponseError(LSPErrorCodes.ContentModified, 'Workspace changed during analysis.');
          }
        }, work => this.withIncludeResolutionCache(work, resolutions));
      } catch (error) {
        rollback();
        throw error;
      } finally { this.requestAnalysisActive = false; }
    } finally { release(); }
  }

  /** Roll back provisional writes without dropping unrelated, valid reference-search documents. */
  private analysisRollback(revision: number, reschedule = true): () => void {
    const documents = new Map([...this.documents].map(([uri, document]) => [uri, { ...document }]));
    const edges = new Map(this.includeGraph);
    const definiteEdges = new Map(this.definiteIncludeGraph);
    const contexts = new Map(this.includeContexts);
    const diagnosticDependencies = new Map(this.diagnosticIncludeDependencies);
    const candidateDependencies = new Map([...this.includeCandidateDependencies].map(([uri, candidates]) => [uri, new Set(candidates)]));
    const forcedIndexed = this.forcedIncludesIndexed;
    return () => {
      const unchanged = revision === this.requestRevision;
      // A traversal can already have rewritten dependency edges, so identity is not enough
      // to prove a snapshot survived an external invalidation. Rebuild after any revision change.
      const valid = unchanged ? [...documents] : [];
      const pending = new Map(this.pendingBackgroundDocuments);
      const active = this.activeBackground;
      const loginPending = this.pendingLoginIndexing || active?.login === true;
      if (active && !active.login) { pending.set(active.uri, active.filePath); }
      const reusedOpens = new Map(this.reusedDependencyOpens);
      this.clearCachedAnalysis();
      if (unchanged) {
        for (const [uri, text] of reusedOpens) {
          if (documents.has(uri)) { this.reusedDependencyOpens.set(uri, text); }
        }
      }
      for (const [uri, document] of valid) {
        this.setIndexedDocument(uri, document);
        this.replaceIncludeEdges(uri, edges.get(uri) ?? new Set(), definiteEdges.get(uri) ?? new Set());
        const context = contexts.get(uri);
        if (context) { this.includeContexts.set(uri, context); }
        const dependencies = diagnosticDependencies.get(uri);
        if (dependencies) { this.diagnosticIncludeDependencies.set(uri, dependencies); }
        const candidates = candidateDependencies.get(uri);
        if (candidates) { this.includeCandidateDependencies.set(uri, candidates); }
      }
      this.forcedIncludesIndexed = unchanged && forcedIndexed;
      if (!reschedule) { return; }
      for (const [uri, filePath] of pending) { this.enqueueBackgroundDocument(uri, filePath); }
      for (const open of this.openInputs.values()) {
        if (!this.documents.has(open.uri)) { this.enqueueBackgroundDocument(open.uri, filePathFromUri(open.uri) ?? open.uri); }
      }
      if (loginPending) { this.pendingLoginIndexing = true; this.scheduleBackgroundIndexing(); }
    };
  }

  /** An unchanged editor view of an already indexed dependency is not a source edit. */
  public tryReuseOpenDocument(input: AnalyzeDocumentInput): boolean {
    if (this.openInputs.has(fileIdentity(input.uri)) || this.inheritIncludeContext
      || input.macroDefinitions || input.preprocessorSymbols || input.knownGuiClasses || input.knownGuiClassNames
      || input.uncertainNames || (input.tool !== undefined && input.tool !== this.tool)
      || (input.targetPlatform !== undefined && input.targetPlatform !== this.targetPlatform)
      || (input.internalFeatures !== undefined && input.internalFeatures !== this.internalFeatures)) { return false; }
    const identity = documentUriIdentity(input.uri);
    const entry = [...this.documents].find(([uri, document]) => documentUriIdentity(uri) === identity
      && document.workspaceIndexComplete && document.text === input.text);
    if (!entry) { return false; }
    const [uri, cached] = entry;
    if (this.includeContexts.has(uri)) { return false; }
    // Add an editor URI view without replacing the dependency generation used by callers.
    const analysis = rebindAnalysis(cached.analysis, input.uri, input.version);
    this.documents.set(input.uri, { ...cached, analysis, version: input.version });
    if (uri !== input.uri) {
      this.replaceIncludeEdges(input.uri, new Set(this.includeGraph.get(uri)), new Set(this.definiteIncludeGraph.get(uri)));
    }
    this.openInputs.set(fileIdentity(input.uri), input);
    this.reusedDependencyOpens.set(input.uri, input.text);
    return true;
  }

  /** Keep a borrowed dependency snapshot when closing an unedited, unchanged disk file. */
  public tryCloseUnchangedDocument(uri: string): boolean {
    const text = this.reusedDependencyOpens.get(uri);
    const input = this.openInputs.get(fileIdentity(uri));
    const cached = this.documents.get(uri);
    if (text === undefined || input?.text !== text || !cached) { return false; }
    const filename = filePathFromUri(uri);
    try { if (!filename || fs.readFileSync(filename, 'utf8') !== text) { return false; } }
    catch { return false; }
    this.openInputs.delete(fileIdentity(uri));
    this.reusedDependencyOpens.delete(uri);
    this.documents.set(uri, { ...cached, version: undefined });
    return true;
  }

  public updateOpenDocument(input: AnalyzeDocumentInput): void {
    if (this.tryReuseOpenDocument(input)) { return; }
    const previous = this.openInputs.get(fileIdentity(input.uri));
    if (previous?.version !== input.version || previous.text !== input.text) {
      this.reusedDependencyOpens.delete(input.uri);
      this.invalidateUri(input.uri);
      this.rememberOpenInput(input);
    }
  }

  public analyzeForegroundDocument(input: AnalyzeDocumentInput): AnalyzedDocument {
    this.interruptBackgroundAnalysis();
    this.updateOpenDocument(input);
    return measureDurationMs(this.logger, 'workspace.foreground', { uri: input.uri, version: input.version },
      () => runAnalysisSteps(this.foregroundDocumentSteps(input)));
  }

  private *foregroundDocumentSteps(input: AnalyzeDocumentInput): Generator<AnalysisStep, AnalyzedDocument, void> {
    yield;
    const cached = this.documents.get(input.uri);
    if (cached?.version === input.version) {
      return cached.analysis;
    }

    const analysis = yield* this.analyzer.analyzeDocumentSteps({ ...input, tool: this.tool, internalFeatures: this.internalFeatures, targetPlatform: this.targetPlatform });
    this.setIndexedDocument(input.uri, {
      analysis,
      text: input.text,
      version: input.version,
      filePath: filePathFromUri(input.uri),
      workspaceDiagnosticsComplete: false
    });
    this.enqueueKnownForcedIncludeFiles();
    this.replaceResolvedIncludeEdgesAndEnqueue(analysis);
    return analysis;
  }

  public analyzeDiagnosticDocument(input: AnalyzeDocumentInput): AnalyzedDocument {
    return this.withIncludeResolutionCache(() => {
      const foregroundAnalysis = this.analyzeForegroundDocument(input);
      if (this.backgroundIndexingScheduled || this.pendingBackgroundDocuments.size > 0) {
        if (this.documents.get(input.uri)?.workspaceDiagnosticsComplete) { return foregroundAnalysis; }
        // Missing direct includes are already known without waiting for header parsing.
        return {...foregroundAnalysis, diagnostics: limitDiagnostics([
          ...this.unresolvedIncludeDiagnostics(foregroundAnalysis, true),
          ...foregroundAnalysis.diagnostics
        ], this.maxNumberOfProblems)};
      }

      return this.indexOpenDocument(input);
    });
  }

  public getIncludeResolutionStatus(analysis: AnalyzedDocument): IncludeResolutionStatus {
    const status = collectIncludeResolutionStatus(analysis, this.includeRoots,
      Array.from(new Set([...this.forcedIncludeFiles, ...this.getForcedIncludeFiles()])),
      uri => this.documents.get(uri)?.analysis);
    status.diagnostics = limitDiagnostics(status.diagnostics, this.maxNumberOfProblems);
    this.diagnosticIncludeDependencies.set(analysis.uri, status.dependencyUris);
    return status;
  }

  public getSemanticTokens(analysis:AnalyzedDocument):ReturnType<typeof collectSemanticTokens> {
    // Use only already-indexed declarations, just like semanticTokenWorkspaceIndex.
    const declarations=this.listCachedVisibleDeclarations(analysis.uri);
    const cached=this.semanticResultCache.get(analysis.uri);
    if(cached?.analysis===analysis && cached.declarations.length===declarations.length
      && declarations.every((declaration,i)=>cached.declarations[i]===declaration))return cached.tokens;
    const tokens=collectSemanticTokens(analysis,{
      listVisibleDeclarations:()=>declarations,
      findVisibleDeclarations:(_uri,name)=>declarations.filter(declaration=>declaration.name===name)
    });
    this.semanticResultCache.set(analysis.uri,{analysis,declarations,tokens});
    return tokens;
  }

  public semanticTokenWorkspaceIndex(_sourceUri: string): WorkspaceDeclarationLookup {
    return {
      findVisibleDeclarations: (uri, name) => this.listCachedVisibleDeclarations(uri)
        .filter((declaration) => declaration.name === name),
      listVisibleDeclarations: (uri) => this.listCachedVisibleDeclarations(uri)
    };
  }

  public waitForBackgroundIndexing(): Promise<void> {
    if (!this.backgroundIndexingScheduled && this.pendingBackgroundDocuments.size === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.backgroundWaiters.push(resolve);
    });
  }

  public onBackgroundIndexingActivity(listener: (active: boolean) => void): () => void {
    this.backgroundActivityListeners.add(listener);
    if (this.backgroundActivity) { listener(true); }
    return () => { this.backgroundActivityListeners.delete(listener); };
  }

  private setBackgroundActivity(active: boolean): void {
    if (this.backgroundActivity === active) { return; }
    this.backgroundActivity = active;
    for (const listener of this.backgroundActivityListeners) { listener(active); }
  }

  public cancelBackgroundIndexing(): void {
    this.backgroundScheduleGeneration++;
    this.backgroundGeneration++;
    const active = this.activeBackground;
    this.activeBackground = undefined;
    if (active && !this.backgroundStepping) { active.steps.return(); active.rollback(); }
    this.pendingBackgroundDocuments.clear(); this.pendingLoginIndexing = false;
    this.backgroundIndexingScheduled = false;
    this.setBackgroundActivity(false);
    for (const waiter of this.backgroundWaiters.splice(0)) { waiter(); }
  }

  public onBackgroundIndexingComplete(listener: (changed: boolean) => void): void {
    this.backgroundCompleteListeners.push(listener);
  }

  public *getDocumentSymbolsSteps(input: AnalyzeDocumentInput): Generator<AnalysisStep, import('../types/analysis').AnalysisSymbol[], void> {
    return yield* this.outlineAnalyzer.getDocumentSymbolsSteps({ ...input, tool: this.tool,
      targetPlatform: this.targetPlatform, internalFeatures: this.internalFeatures,
      preprocessorSymbols: defaultPreprocessorSymbols(this.defines).filter(symbol => !isSystemMacroName(symbol.name)) });
  }

  public *getDocumentLinksSteps(input: AnalyzeDocumentInput): Generator<AnalysisStep, DocumentLinkCandidate[], void> {
    return yield* this.outlineAnalyzer.getDocumentLinksSteps(input);
  }

  /** Resolve only the selected path; do not index or parse its target. */
  public resolveDocumentLink(sourceUri: string, candidate: DocumentLinkCandidate): string | undefined {
    const includingFilePath = filePathFromUri(sourceUri);
    if (!includingFilePath) { return undefined; }
    const resolution = candidate.kind === 'script'
      ? resolveScriptExecution({ includingFilePath, scriptPath: candidate.path, includeRoots: this.includeRoots })
      : resolveInclude({ includingFilePath,
          includeText: includeTextForResolution(candidate.path, candidate.includeKind ?? 'expression'), includeRoots: this.includeRoots });
    return resolution.status === 'resolved' ? resolution.uri : undefined;
  }

  public *getSelectionRangesSteps(input: AnalyzeDocumentInput, positions: readonly import('../types/analysis').AnalysisPosition[]): Generator<AnalysisStep, import('./selectionRanges').AnalysisSelectionRange[], void> {
    return yield* this.outlineAnalyzer.getSelectionRangesSteps(input, positions);
  }

  public *getFoldingRangesSteps(input: AnalyzeDocumentInput): Generator<AnalysisStep, FoldingRangeCandidate[], void> {
    return yield* this.analyzer.getFoldingRangesSteps(input);
  }

  public indexOpenDocument(input: AnalyzeDocumentInput): AnalyzedDocument {
    this.interruptBackgroundAnalysis();
    return this.withIncludeResolutionCache(() => runAnalysisSteps(this.indexOpenDocumentSteps(input)));
  }

  private *indexOpenDocumentSteps(input: AnalyzeDocumentInput, forced = this.indexingForcedIncludes,
    pendingInputs = new Map<string, AnalyzeDocumentInput>(), diagnostics = true): Generator<AnalysisStep, AnalyzedDocument, void> {
    yield;
    this.rememberOpenInput(input);
    const cached = this.documents.get(input.uri);
    if (cached?.version === input.version && cached.workspaceDiagnosticsComplete === true) {
      return cached.analysis;
    }

    if (cached?.version === input.version && cached.workspaceIndexComplete) {
      if (!diagnostics) { return cached.analysis; }
      const analysis = yield* this.withWorkspaceDiagnosticsSteps(cached.analysis);
      this.documents.set(input.uri, { ...cached, analysis, workspaceDiagnosticsComplete: true });
      return analysis;
    }

    const initialAnalysis = cached?.version === input.version ? cached.analysis
      : yield* this.analyzer.analyzeDocumentSteps({ ...input, tool: this.tool, internalFeatures: this.internalFeatures, targetPlatform: this.targetPlatform }, true, true);
    this.setIndexedDocument(input.uri, {
      analysis: initialAnalysis,
      text: input.text,
      version: input.version,
      filePath: filePathFromUri(input.uri),
      workspaceDiagnosticsComplete: false
    });
    pendingInputs.set(input.uri, input);
    try {
      yield* this.indexResolvedIncludesSteps(initialAnalysis, new Set([input.uri]), forced, pendingInputs);
    } finally {
      pendingInputs.delete(input.uri);
    }
    const contextual = yield* this.reanalyzeWithVisibleContextSteps(input, initialAnalysis, forced, pendingInputs);
    const analysis = diagnostics ? yield* scopedAnalysisSteps(this.withWorkspaceDiagnosticsSteps(contextual), work => {
      const previous = this.indexingForcedIncludes;
      this.indexingForcedIncludes = forced;
      try { return work(); } finally { this.indexingForcedIncludes = previous; }
    }) : contextual;
    this.setIndexedDocument(input.uri, {
      ...(this.documents.get(input.uri) ?? {}),
      analysis,
      text: input.text,
      workspaceIndexComplete: true,
      workspaceDiagnosticsComplete: diagnostics
    });
    this.analyzer.releaseSyntax(analysis.uri);
    return analysis;
  }

  public indexDiskDocument(filePath: string): AnalyzedDocument {
    this.interruptBackgroundAnalysis();
    return this.withIncludeResolutionCache(() => {
      const indexed = this.indexDiskDocumentInternal(path.normalize(filePath), new Set());
      const cached = this.documents.get(indexed.uri);
      if (cached?.workspaceDiagnosticsComplete) { return indexed; }
      const analysis = this.withWorkspaceDiagnostics(indexed);
      if (cached) { this.setIndexedDocument(indexed.uri, { ...cached, analysis, workspaceDiagnosticsComplete: true }); }
      return analysis;
    });
  }

  public indexForcedIncludes(): void {
    this.interruptBackgroundAnalysis();
    return this.withIncludeResolutionCache(() => {
      if (this.indexingForcedIncludes) {
        return;
      }

      this.indexingForcedIncludes = true;
      try {
        for (const filePath of this.getForcedIncludeFiles()) {
          this.indexDiskDocumentInternal(filePath, new Set());
        }
        this.forcedIncludesIndexed = true;
      } finally {
        this.indexingForcedIncludes = false;
      }
    });
  }

  private ensureForcedIncludesIndexed(): void {
    if (!this.forcedIncludesIndexed && !this.indexingForcedIncludes) {
      this.indexForcedIncludes();
    }
  }

  public findDeclarations(name: string): AnalysisDeclaration[] {
    const declarations: AnalysisDeclaration[] = [];
    for (const document of this.documents.values()) {
      declarations.push(...document.analysis.declarations.filter((declaration) => declaration.name === name));
    }

    return declarations;
  }

  public findVisibleDeclarations(sourceUri: string, name: string): AnalysisDeclaration[] {
    this.ensureForcedIncludesIndexed();
    const ordinary = this.collectDefiniteVisibleUris(sourceUri)
      .flatMap((uri) => this.documents.get(uri)?.analysis.declarations ?? [])
      .filter((declaration) => declaration.name === name)
      .sort(compareDeclarations);
    return uniqueDeclarations([...ordinary, ...this.visibleLoginDeclarations(sourceUri).filter(d => d.name === name)]);
  }

  public findVisibleMacroDefinitions(sourceUri: string, name: string): AnalysisMacroDefinition[] {
    this.ensureForcedIncludesIndexed();
    return this.collectPositionAwareMacroDefinitions(sourceUri)
      .filter((macro) => macro.name === name);
  }

  public findBestVisibleMacroDefinition(
    sourceUri: string,
    name: string,
    position?: AnalysisPosition
  ): AnalysisMacroDefinition | undefined {
    return this.findVisibleMacroDefinitions(sourceUri, name)
      .filter((macro) => position === undefined
        || macro.visibilityStart === undefined
        || comparePositions(macro.visibilityStart, position) <= 0)
      .at(-1);
  }

  public listVisibleDeclarations(sourceUri: string): AnalysisDeclaration[] {
    this.ensureForcedIncludesIndexed();
    // Preparing startup scope can publish new globals and invalidate derived values.
    this.loginScope(sourceUri);
    const cached = this.visibleDeclarationsCache.get(sourceUri);
    if (cached) { return cached.slice(); }
    const declarations = [
      ...(this.documents.get(sourceUri)?.analysis.declarations ?? []),
      ...this.collectDefiniteVisibleUris(sourceUri)
        .flatMap((uri) => this.documents.get(uri)?.analysis.declarations ?? [])
    ];
    const result = uniqueDeclarations([...declarations.sort(compareDeclarations), ...this.visibleLoginDeclarations(sourceUri)]);
    this.visibleDeclarationsCache.set(sourceUri, result);
    return result.slice();
  }

  private visibleLoginDeclarations(sourceUri: string, cachedOnly = false): AnalysisDeclaration[] {
    const snapshot = cachedOnly ? this.loginSnapshot : this.loginScope(sourceUri);
    if (!snapshot || fileIdentity(snapshot.entryUri) === fileIdentity(sourceUri)) { return []; }
    const ordinaryClasses = new Set([sourceUri, ...this.collectDefiniteVisibleUris(sourceUri)]
      .flatMap(uri => this.documents.get(uri)?.analysis.declarations ?? [])
      .filter(declaration => declaration.kind === 'class').map(declaration => declaration.name));
    return snapshot.declarations.filter(declaration => !ordinaryClasses.has(declaration.containerName ?? '')
      && !(declaration.kind === 'class' && ordinaryClasses.has(declaration.name)));
  }

  private loginScope(sourceUri: string): LoginScopeSnapshot | undefined {
    return runAnalysisSteps(this.loginScopeSteps(sourceUri));
  }

  private *loginScopeSteps(sourceUri: string): Generator<AnalysisStep, LoginScopeSnapshot | undefined, void> {
    if (this.indexingForcedIncludes) { return undefined; }
    const entry = resolveLoginPath(this.sxmHome, this.tool);
    if (!entry || fileIdentity(pathToFileURL(entry).toString()) === fileIdentity(sourceUri)) { return undefined; }
    if (this.loginSnapshot) { return this.loginSnapshot; }
    if (!this.forcedIncludesIndexed) { yield* this.forcedIncludeSteps(); }
    this.loginSnapshot = yield* buildLoginScopeSteps(entry, { includeRoots: this.includeRoots,
      forcedIncludeFiles: this.forcedIncludeFiles, forcedIncludeRoots: this.forcedIncludeRoots,
      tool: this.tool, targetPlatform: this.targetPlatform, internalFeatures: this.internalFeatures,
      defines: this.defines, logger: this.logger, openDocumentInput: uri => this.openInputs.get(fileIdentity(uri)) }, this);
    this.derivedCache.invalidate();
    if (this.backgroundStepping) { this.backgroundChanged = true; }
    return this.loginSnapshot;
  }

  private rememberOpenInput(input: AnalyzeDocumentInput): void {
    const previous = this.openInputs.get(fileIdentity(input.uri));
    if (previous?.version !== input.version || previous.text !== input.text) {
      if (this.loginSnapshot?.dependencyUris.some(uri => fileIdentity(uri) === fileIdentity(input.uri))) {
        this.loginGeneration++;
        this.loginSnapshot = undefined;
        this.clearCachedAnalysis();
      }
      this.backgroundGeneration++;
      this.openInputs.set(fileIdentity(input.uri), input);
    }
  }

  public getLoginDependencies(cachedOnly = false): { generation: number; uris: string[] } {
    if (!cachedOnly) {
      this.interruptBackgroundAnalysis();
      return { generation: this.loginGeneration, uris: this.loginScope('')?.dependencyUris ?? [] };
    }
    const entry = resolveLoginPath(this.sxmHome, this.tool);
    if (!this.loginSnapshot && entry && !this.activeBackground?.login) {
      this.pendingLoginIndexing = true;
      this.scheduleBackgroundIndexing();
    }
    return { generation: this.loginGeneration,
      uris: this.loginSnapshot?.dependencyUris ?? (entry ? [pathToFileURL(entry).toString()] : []) };
  }

  private *backgroundLoginSteps(): Generator<AnalysisStep, void, void> {
    yield* this.loginScopeSteps('');
  }

  public callHierarchyTypeInput(analysis: AnalyzedDocument): TypeDiagnosticsInput {
    this.ensureForcedIncludesIndexed();
    const loginScope = this.loginScope(analysis.uri);
    const ordinaryDocuments = [analysis, ...this.collectDefiniteVisibleUris(analysis.uri).flatMap(uri => {
      const document = this.documents.get(uri)?.analysis;
      return document ? [document] : [];
    })];
    const catalog = this.builtinCatalogCache ??= loadBuiltinCatalog(this.forcedIncludeFiles);
    const cached = this.typeInputCache.get(analysis.uri);
    if (cached?.analysis === analysis && cached.catalog === catalog && cached.loginScope === loginScope
      && cached.documents?.length === ordinaryDocuments.length && ordinaryDocuments.every((document, i) => cached.documents![i] === document)) {
      return cached;
    }
    const macros = this.collectPositionAwareMacroDefinitions(analysis.uri, true);
    const result: TypeDiagnosticsInput = {analysis, documents: ordinaryDocuments, loginScope, catalog, resolveMacro: (name, node) => {
      const macro = macros.filter(macro => macro.name === name
        && (!macro.visibilityStart || comparePositions(macro.visibilityStart, node.range.start) <= 0)).at(-1);
      return macro && !('_typeUndef' in macro) ? macro : undefined;
    }};
    this.typeInputCache.set(analysis.uri, result);
    return result;
  }

  public resolveCallDeclarations(analysis: AnalyzedDocument, position: AnalysisPosition, allowPartialArguments = false): AnalysisDeclaration[] | undefined {
    if (!analysis.typeSnapshot) { return undefined; }
    const input = this.callHierarchyTypeInput(analysis);
    const documents = [...input.documents ?? [], ...input.loginScope?.documents ?? []];
    const catalog = input.catalog!;
    const cached = this.callResolutionCache.get(analysis.uri);
    if (cached && cached.catalog === catalog && cached.documents.length === documents.length
      && documents.every((document, i) => document === cached.documents[i])) { return cached.resolve(position, allowPartialArguments); }
    const resolve = createCallResolver(input);
    this.callResolutionCache.set(analysis.uri, {documents, catalog, resolve});
    return resolve(position, allowPartialArguments);
  }

  public documentationBindings(sourceUri: string): DocumentationBindings {
    this.ensureForcedIncludesIndexed();
    const source = this.documents.get(sourceUri)?.analysis;
    if (!source) { return new Map(); }
    const documents = [sourceUri, ...this.collectDefiniteVisibleUris(sourceUri)]
      .map(uri => this.documents.get(uri)?.analysis)
      .filter((doc): doc is AnalyzedDocument => doc !== undefined);
    documents.push(...this.loginScope(sourceUri)?.documents ?? []);
    const cached = this.documentationCache.get(sourceUri);
    if (cached && cached.documents.length === documents.length && documents.every((doc, i) => doc === cached.documents[i])) {
      return cached.bindings;
    }
    const bindings = bindDocumentation(source, documents, this.listVisibleDeclarations(sourceUri));
    this.documentationCache.set(sourceUri, { documents, bindings });
    return bindings;
  }

  public listVisibleDocuments(sourceUri: string): AnalyzedDocument[] {
    this.ensureForcedIncludesIndexed();
    const ordinary = [sourceUri, ...this.collectVisibleUris(sourceUri)]
      .map((uri) => this.documents.get(uri)?.analysis)
      .filter((analysis): analysis is AnalyzedDocument => analysis !== undefined);
    return [...ordinary, ...(this.loginScope(sourceUri)?.documents ?? [])];
  }

  public listReferenceSearchDocuments(sourceUri: string): AnalyzedDocument[] {
    this.ensureForcedIncludesIndexed();
    const visible = new Set([sourceUri, ...this.collectVisibleUris(sourceUri)].map(documentUriIdentity));
    const candidates = [...Array.from(this.documents.values())
      .filter(document => !this.projectScope || visible.has(documentUriIdentity(document.analysis.uri)) || this.projectScope.contains(document.analysis.uri))
      .map((document) => document.analysis),
      ...(this.loginScope(sourceUri)?.documents ?? [])];
    const documents = new Map<string, AnalyzedDocument>();
    for (const analysis of candidates) {
      const identity = documentUriIdentity(analysis.uri);
      const previous = documents.get(identity);
      // One physical document must contribute each reference/edit only once.
      if (!previous || analysis.uri === sourceUri || (previous.uri !== sourceUri
        && this.openInputs.get(fileIdentity(analysis.uri))?.uri === analysis.uri)) {
        documents.set(identity, analysis);
      }
    }
    return [...documents.values()];
  }

  public findIncludePathCompletions(sourceUri: string, prefix: string, includeKind: 'quote' | 'angle'): string[] {
    const includingFilePath = filePathFromUri(sourceUri);
    const localRoot = includingFilePath === undefined ? [] : [path.dirname(includingFilePath)];
    const roots = [
      ...(includeKind === 'quote' || this.includeRoots.length === 0 ? localRoot : []),
      ...this.includeRoots
    ];
    return includePathCompletions(roots, prefix);
  }

  public findScriptExecutionPathCompletions(sourceUri: string, prefix: string): string[] {
    const includingFilePath = filePathFromUri(sourceUri);
    const localRoot = includingFilePath === undefined ? [] : [path.dirname(includingFilePath)];
    return pathCompletions([...localRoot, ...this.includeRoots], prefix, /\.(?:axl)$/i, true);
  }

  public resolveIncludeAtPosition(
    sourceUri: string,
    position: AnalysisPosition
  ): AnalysisResolvedInclude | undefined {
    const analysis = this.documents.get(sourceUri)?.analysis;
    const includingFilePath = filePathFromUri(sourceUri);
    if (analysis === undefined || includingFilePath === undefined) {
      return undefined;
    }

    const include = analysis.includes.find((candidate) => containsPosition(candidate.range, position));
    if (include === undefined) {
      return undefined;
    }

    const resolution = this.resolveInclude({
      includingFilePath,
      includeText: includeTextForResolution(include.includePath, include.kind),
      includeRoots: this.includeRoots
    });
    if (resolution.status !== 'resolved') {
      return undefined;
    }

    return {
      includePath: include.includePath,
      filePath: resolution.filePath,
      uri: resolution.uri,
      range: include.range
    };
  }

  public resolveScriptExecutionAtPosition(
    sourceUri: string,
    position: AnalysisPosition
  ): AnalysisResolvedScriptExecution | undefined {
    const analysis = this.documents.get(sourceUri)?.analysis;
    const includingFilePath = filePathFromUri(sourceUri);
    if (analysis === undefined || includingFilePath === undefined) {
      return undefined;
    }

    const execution = analysis.scriptExecutions.find((candidate) => containsPosition(candidate.range, position));
    if (execution === undefined) {
      return undefined;
    }

    const resolution = resolveScriptExecution({
      includingFilePath,
      scriptPath: execution.scriptPath,
      includeRoots: this.includeRoots
    });
    if (resolution.status !== 'resolved') {
      return undefined;
    }

    return {
      scriptPath: execution.scriptPath,
      filePath: resolution.filePath,
      uri: resolution.uri,
      range: execution.range
    };
  }

  public findGuiClass(sourceUri: string, name: string): AnalysisGuiClass | undefined {
    return this.findVisibleGuiClasses(sourceUri, name)[0];
  }

  public findVisibleGuiClasses(sourceUri: string, name: string): AnalysisGuiClass[] {
    this.ensureForcedIncludesIndexed();
    return this.collectVisibleGuiClassEntries(sourceUri)
      .filter((entry) => entry.guiClass.name === name)
      .sort(compareGuiClassEntries)
      .map((entry) => entry.guiClass);
  }

  public isKnownGuiClass(sourceUri: string, name: string): boolean {
    return this.findGuiClass(sourceUri, name) !== undefined;
  }

  public getAnalyzedDocument(uri: string): AnalyzedDocument | undefined {
    return this.documents.get(uri)?.analysis;
  }

  public deleteDocument(uri: string): void {
    this.outlineAnalyzer.clear(uri);
    this.openInputs.delete(fileIdentity(uri));
    this.invalidateUri(uri);
    this.diagnosticIncludeDependencies.delete(uri);
    this.includeCandidateDependencies.delete(uri);
    this.deleteIndexedDocument(uri);
    this.replaceIncludeEdges(uri, new Set());
    this.analyzer.clear(uri);
  }

  public invalidateFile(filePath: string): void {
    const uri = pathToFileURL(path.normalize(filePath)).toString();
    this.invalidateUri(uri);
  }

  /** Include deleted directory descendants and missing dependency candidates without stat. */
  public invalidatePaths(uris: readonly string[]): void {
    const candidates = new Set([...this.documents.keys(), ...this.reverseIncludeGraph.keys(),
      ...this.loginSnapshot?.dependencyUris ?? [], ...this.knownForcedIncludeUris(),
      ...[...this.diagnosticIncludeDependencies.values(), ...this.includeCandidateDependencies.values()].flatMap(values => [...values])]);
    const roots = uris.filter(uri => uri.startsWith('file:')).map(uri => fileIdentity(uri));
    const inside = (file: string, root: string) => {
      const relative = path.relative(root, file);
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    if (this.forcedIncludeRoots.some(root => roots.some(changed => {
      const key = fileIdentity(pathToFileURL(root).toString());
      return inside(changed, key) || inside(key, changed);
    }))) {
      this.requestRevision++;
      this.forcedIncludeFileCache = undefined;
      this.loginGeneration++;
      this.loginSnapshot = undefined;
      this.clearCachedAnalysis();
      return;
    }
    for (const candidate of candidates) {
      const key = fileIdentity(candidate);
      if (roots.some(root => { const relative = path.relative(root, key); return relative === ''
        || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); })) { this.invalidateUri(candidate); }
    }
    for (const uri of uris) { this.invalidateUri(uri); }
    this.forcedIncludeFileCache = undefined;
  }

  public invalidateUri(uri: string): void {
    this.requestRevision++;
    this.backgroundGeneration++;
    if (this.loginSnapshot && (uri.endsWith('.analysis.json')
      || this.loginSnapshot.dependencyUris.some(dependency => fileIdentity(dependency) === fileIdentity(uri)))) {
      this.loginGeneration++;
      this.loginSnapshot = undefined;
      this.clearInvalidatedAnalysis();
      return;
    }
    const identity = documentUriIdentity(uri);
    const aliases = new Set([uri, ...[...this.documents.keys()].filter(candidate => documentUriIdentity(candidate) === identity)]);
    for (const alias of aliases) { this.reusedDependencyOpens.delete(alias); }
    const catalogSource = [...aliases].some(alias => this.builtinCatalogCache?.declarationUris.has(alias));
    // Invalid manifests publish no dependency URIs. A file event may repair a
    // previously missing declaration that is not reachable through includes.
    const catalogNeedsRetry = !!this.builtinCatalogCache?.issues?.length;
    const dependents = new Set([...aliases].flatMap(alias => [...this.collectDependents(alias)]));
    if (uri.endsWith('.analysis.json') || catalogSource || catalogNeedsRetry || this.knownForcedIncludeUris().some(forced => dependents.has(forced))) {
      this.loginGeneration++;
      this.loginSnapshot = undefined;
      this.clearInvalidatedAnalysis();
      return;
    }
    // Missing include candidates have no resolved graph edge. Track them so
    // creating a header also invalidates documents waiting for that header.
    for (const [sourceUri, dependencies] of [...this.diagnosticIncludeDependencies, ...this.includeCandidateDependencies]) {
      if (dependencies.has(uri)) {
        for (const dependentUri of this.collectDependents(sourceUri)) { dependents.add(dependentUri); }
      }
    }
    // A newly created, previously missing forced dependency has no resolved edge yet.
    if (this.knownForcedIncludeUris().some(forced => dependents.has(forced))) {
      this.loginGeneration++;
      this.loginSnapshot = undefined;
      this.clearInvalidatedAnalysis();
      return;
    }
    this.invalidateDerivedFor(dependents);
    for (const dependentUri of dependents) {
      this.deleteIndexedDocument(dependentUri);
      this.analyzer.clear(dependentUri);
    }
  }

  private indexDiskDocumentInternal(filePath: string, visitedUris: Set<string>): AnalyzedDocument {
    return runAnalysisSteps(this.indexDiskDocumentStepsInternal(filePath, visitedUris));
  }

  /** Internal cooperative entry point used by the separate startup index. */
  public *indexDiskDocumentSteps(filePath: string): Generator<AnalysisStep, AnalyzedDocument, void> {
    const steps = this.indexDiskDocumentStepsInternal(path.normalize(filePath), new Set());
    const resolutions = new Map<string, IncludeResolution>();
    try {
      let next = this.withIncludeResolutionCache(() => steps.next(), resolutions);
      while (!next.done) {
        try { yield next.value; }
        catch (error) { next = this.withIncludeResolutionCache(() => steps.throw(error), resolutions); continue; }
        next = this.withIncludeResolutionCache(() => steps.next(), resolutions);
      }
      return yield* this.withWorkspaceDiagnosticsSteps(next.value);
    } finally { steps.return(undefined as never); }
  }

  private *indexDiskDocumentStepsInternal(filePath: string, visitedUris: Set<string>, forced = this.indexingForcedIncludes,
    pendingInputs = new Map<string, AnalyzeDocumentInput>()): Generator<AnalysisStep, AnalyzedDocument, void> {
    yield;
    const normalizedPath = path.normalize(filePath);
    const uri = pathToFileURL(normalizedPath).toString();
    const open = this.openDocumentInput?.(uri) ?? this.openInputs.get(fileIdentity(uri));
    if (open && !pendingInputs.has(uri)) {
      return yield* this.indexOpenDocumentSteps({ ...open, uri, ...this.includeContexts.get(uri) }, forced, pendingInputs);
    }
    const stat = yield* statAnalysisFile(normalizedPath);
    const cached = this.documents.get(uri);

    if (cached?.mtimeMs === stat.mtimeMs && cached.workspaceIndexComplete === true) {
      yield* this.indexResolvedIncludesSteps(cached.analysis, new Set([...visitedUris, uri]), forced, pendingInputs);
      return cached.analysis;
    }

    if (visitedUris.has(uri)) {
      const existing = this.documents.get(uri);
      if (existing !== undefined) {
        return existing.analysis;
      }
    }

    const text = yield* readAnalysisFile(normalizedPath);
    const input = { uri, version: 0, text, ...this.includeContexts.get(uri) };
    const initialAnalysis = yield* this.analyzer.analyzeDocumentSteps({ ...input, tool: this.tool, internalFeatures: this.internalFeatures, targetPlatform: this.targetPlatform }, true, true);
    this.setIndexedDocument(uri, {
      analysis: initialAnalysis,
      text,
      filePath: normalizedPath,
      mtimeMs: stat.mtimeMs,
      workspaceDiagnosticsComplete: false
    });
    yield* this.indexResolvedIncludesSteps(initialAnalysis, new Set([...visitedUris, uri]), forced, pendingInputs);
    const analysis = yield* this.reanalyzeWithVisibleContextSteps(input, initialAnalysis, forced, pendingInputs);
    this.setIndexedDocument(uri, {
      analysis,
      text,
      filePath: normalizedPath,
      mtimeMs: stat.mtimeMs,
      workspaceIndexComplete: true,
      workspaceDiagnosticsComplete: false
    });
    this.analyzer.releaseSyntax(analysis.uri);
    return analysis;
  }

  private withWorkspaceDiagnostics(analysis: AnalyzedDocument): AnalyzedDocument {
    return runAnalysisSteps(this.withWorkspaceDiagnosticsSteps(analysis));
  }

  private *withWorkspaceDiagnosticsSteps(analysis: AnalyzedDocument): Generator<AnalysisStep, AnalyzedDocument, void> {
    if (this.dependencyAnalysisOnly) { return analysis; }
    const macros = this.collectPositionAwareMacroDefinitions(analysis.uri, true);
    const macrosByName = new Map<string, AnalysisMacroDefinition[]>();
    for (const macro of macros) {
      const entries = macrosByName.get(macro.name) ?? [];
      entries.push(macro); macrosByName.set(macro.name, entries);
    }
    return {
      ...analysis,
      diagnostics: limitDiagnostics([
        ...this.unresolvedIncludeDiagnostics(analysis),
        ...analysis.diagnostics,
        ...(yield* collectTypeDiagnosticsSteps({analysis,
          loginScope: this.loginScope(analysis.uri),
          resolveMacro: (name,node) => {
            const macro = macrosByName.get(name)?.filter(macro => !macro.visibilityStart || comparePositions(macro.visibilityStart,node.range.start)<=0).at(-1);
            return macro && !('_typeUndef' in macro) ? macro : undefined;
          },
          documents: this.collectDefiniteVisibleUris(analysis.uri).flatMap(uri => {
            const visible = this.documents.get(uri)?.analysis;
            return visible ? [visible] : [];
          }), catalog: this.builtinCatalogCache ??= loadBuiltinCatalog(this.forcedIncludeFiles)}))
          .filter(diagnostic => !affectedBySyntaxRecovery(analysis.syntaxRecovery, diagnostic.range)),
        ...this.unresolvedScriptExecutionDiagnostics(analysis),
        ...collectSemanticDiagnostics({
          analysis,
          workspaceIndex: this
        })
      ], this.maxNumberOfProblems)
    };
  }

  private unresolvedIncludeDiagnostics(analysis: AnalyzedDocument, unconditionalOnly = false): AnalysisDiagnostic[] {
    const includingFilePath = filePathFromUri(analysis.uri);
    if (includingFilePath === undefined) {
      return [];
    }

    return analysis.includes
      .filter(include => !unconditionalOnly || !include.conditional)
      .map((include) => ({
        include,
        resolution: this.resolveInclude({
          includingFilePath,
          includeText: includeTextForResolution(include.includePath, include.kind),
          includeRoots: this.includeRoots
        })
      }))
      .filter((item) => item.resolution.status === 'unresolved' && item.resolution.reason === 'not-found')
      .map((item) => ({
        severity: 'error',
        source: 'axel',
        ...message("Include file not found: '{0}'.", item.include.includePath),
        range: item.include.range
      }));
  }

  private unresolvedScriptExecutionDiagnostics(analysis: AnalyzedDocument): AnalysisDiagnostic[] {
    const includingFilePath = filePathFromUri(analysis.uri);
    if (includingFilePath === undefined) {
      return [];
    }

    return analysis.scriptExecutions
      .map((execution) => ({
        execution,
        resolution: resolveScriptExecution({
          includingFilePath,
          scriptPath: execution.scriptPath,
          includeRoots: this.includeRoots
        })
      }))
      .filter((item) => item.resolution.status === 'unresolved' && item.resolution.reason === 'not-found')
      .map((item) => ({
        severity: 'error',
        source: 'axel',
        ...message("AXEL execution file not found: '{0}'.", item.execution.scriptPath),
        range: item.execution.range
      }));
  }

  private *forcedIncludeSteps(pendingInputs = new Map<string, AnalyzeDocumentInput>()): Generator<AnalysisStep, void, void> {
    for (const filePath of this.getForcedIncludeFiles()) {
      yield* scopedAnalysisSteps(this.indexDiskDocumentStepsInternal(filePath, new Set(), true, pendingInputs), work => {
        const previous = this.indexingForcedIncludes;
        this.indexingForcedIncludes = true;
        try { return work(); } finally { this.indexingForcedIncludes = previous; }
      });
    }
    this.forcedIncludesIndexed = true;
  }

  private *reanalyzeWithVisibleContextSteps(
    input: AnalyzeDocumentInput, initialAnalysis: AnalyzedDocument, forced = this.indexingForcedIncludes,
    pendingInputs = new Map<string, AnalyzeDocumentInput>()
  ): Generator<AnalysisStep, AnalyzedDocument, void> {
    if (!forced && !this.forcedIncludesIndexed) { yield* this.forcedIncludeSteps(pendingInputs); }
    yield* this.loginScopeSteps(input.uri);
    yield;

    const knownGuiClasses = this.collectVisibleGuiClassEntries(input.uri)
      .sort(compareGuiClassEntries)
      .map((entry) => ({
        name: entry.guiClass.name,
        kind: entry.guiClass.kind
      }));
    const preprocessorSymbols = [...input.preprocessorSymbols ?? [], ...this.collectVisiblePreprocessorSymbols(input.uri)];
    const uncertainNames = this.collectVisibleUncertainNames(input.uri);
    const macroDefinitions = [...input.macroDefinitions ?? [], ...this.collectPositionAwareMacroDefinitions(input.uri)]
      .filter((macro) => documentUriIdentity(macro.uri) !== documentUriIdentity(input.uri));
    if (knownGuiClasses.length === 0 && preprocessorSymbols.length === 0 && macroDefinitions.length === 0 && uncertainNames.length === 0) {
      return initialAnalysis.typeSnapshot ? initialAnalysis : yield* this.analyzer.analyzeDocumentSteps({
        ...input,tool:this.tool,internalFeatures:this.internalFeatures,targetPlatform:this.targetPlatform
      });
    }

    const analysis = yield* this.analyzer.analyzeDocumentSteps({
      ...input,
      tool: this.tool, internalFeatures: this.internalFeatures, targetPlatform: this.targetPlatform,
      knownGuiClasses,
      preprocessorSymbols,
      uncertainNames,
      macroDefinitions
    });
    this.setIndexedDocument(input.uri, {
      ...(this.documents.get(input.uri) ?? {}),
      analysis,
      workspaceDiagnosticsComplete: false
    });
    yield* this.indexResolvedIncludesSteps(analysis, new Set([input.uri]), forced, pendingInputs);
    return analysis;
  }

  private *indexResolvedIncludesSteps(analysis: AnalyzedDocument, visitedUris: Set<string>, forced = this.indexingForcedIncludes,
    pendingInputs = new Map<string, AnalyzeDocumentInput>()): Generator<AnalysisStep, void, void> {
    const includingFilePath = filePathFromUri(analysis.uri);
    if (includingFilePath === undefined) {
      return;
    }

    const resolvedUris = new Set<string>();
    const definiteUris = new Set<string>();
    for (const include of analysis.includes) {
      const resolution = this.resolveInclude({
        includingFilePath,
        includeText: includeTextForResolution(include.includePath, include.kind),
        includeRoots: this.includeRoots
      });
      if (resolution.status !== 'resolved') {
        continue;
      }

      resolvedUris.add(resolution.uri);
      if (!this.isUncertainRange(analysis, include.range)) { definiteUris.add(resolution.uri); }
      if (!visitedUris.has(resolution.uri)) {
        // Forced headers have an independent global context; callers must not invalidate it.
        if (this.inheritIncludeContext && !forced
          && !this.knownForcedIncludeUris().includes(resolution.uri)) {
          const visible = new Map<string, AnalysisMacroDefinition>();
          for (const macro of [...this.includeContexts.get(analysis.uri)?.macroDefinitions ?? [],
            ...this.collectPositionAwareMacroDefinitions(analysis.uri, true)]) {
            if (macro.visibilityStart && comparePositions(macro.visibilityStart, include.range.start) > 0) { continue; }
            if ('_typeUndef' in macro) { visible.delete(macro.name); } else { visible.set(macro.name, { ...macro, visibilityStart: undefined }); }
          }
          const context = { macroDefinitions: [...visible.values()], preprocessorSymbols: [...visible.values()].map(macro =>
            ({ name: macro.name, value: macro.parameters ? undefined : macro.replacementText })) };
          if (JSON.stringify(context) !== JSON.stringify(this.includeContexts.get(resolution.uri))) {
            this.deleteIndexedDocument(resolution.uri);
            this.includeContexts.set(resolution.uri, context);
          }
        }
        yield* this.indexDiskDocumentStepsInternal(resolution.filePath, new Set([...visitedUris, resolution.uri]), forced, pendingInputs);
      } else {
        // A cyclic include needs the open document's declarations, including unsaved edits.
        const pending = pendingInputs.get(resolution.uri);
        const indexed = this.documents.get(resolution.uri);
        if (pending && indexed && !indexed.analysis.typeSnapshot) {
          const analysis = yield* this.analyzer.analyzeDocumentSteps({
            ...pending, tool: this.tool, internalFeatures: this.internalFeatures, targetPlatform: this.targetPlatform
          });
          this.setIndexedDocument(resolution.uri, { ...indexed, analysis });
        }
      }
    }

    this.replaceIncludeEdges(analysis.uri, resolvedUris, definiteUris);
  }

  private replaceResolvedIncludeEdgesAndEnqueue(analysis: AnalyzedDocument): void {
    const includingFilePath = filePathFromUri(analysis.uri);
    if (includingFilePath === undefined) {
      this.replaceIncludeEdges(analysis.uri, new Set());
      return;
    }

    const resolvedUris = new Set<string>();
    const definiteUris = new Set<string>();
    for (const include of analysis.includes) {
      const resolution = this.resolveInclude({
        includingFilePath,
        includeText: includeTextForResolution(include.includePath, include.kind),
        includeRoots: this.includeRoots
      });
      if (resolution.status !== 'resolved') {
        continue;
      }

      resolvedUris.add(resolution.uri);
      if (!this.isUncertainRange(analysis, include.range)) { definiteUris.add(resolution.uri); }
      if (!this.documents.has(resolution.uri)) {
        this.enqueueBackgroundDocument(resolution.uri, resolution.filePath);
      }
    }

    this.replaceIncludeEdges(analysis.uri, resolvedUris, definiteUris);
  }

  private enqueueBackgroundDocument(uri: string, filePath: string): void {
    if (this.pendingBackgroundDocuments.has(uri)) {
      return;
    }

    this.pendingBackgroundDocuments.set(uri, filePath);
    this.scheduleBackgroundIndexing();
  }

  private scheduleBackgroundIndexing(): void {
    if (this.backgroundIndexingScheduled || !this.analysisEnabled) {
      return;
    }

    this.backgroundIndexingScheduled = true;
    const generation = this.backgroundScheduleGeneration;
    this.setBackgroundActivity(true);
    setImmediate(() => this.processNextBackgroundDocument(generation));
  }

  private interruptBackgroundAnalysis(): void {
    if (this.activeBackground && !this.backgroundStepping) {
      const active = this.activeBackground;
      const pending = new Map(this.pendingBackgroundDocuments);
      const loginPending = this.pendingLoginIndexing || active.login === true;
      this.activeBackground = undefined; active.steps.return(); active.rollback();
      for (const [uri, file] of pending) { this.pendingBackgroundDocuments.set(uri, file); }
      if (!active.login) { this.pendingBackgroundDocuments.set(active.uri, active.filePath); }
      this.pendingLoginIndexing = loginPending;
    }
  }

  private processNextBackgroundDocument(generation: number): void {
    if (generation !== this.backgroundScheduleGeneration) { return; }
    if (!this.analysisEnabled) { this.backgroundIndexingScheduled = false; this.setBackgroundActivity(false); return; }
    if (this.requestAnalysisActive) {
      setTimeout(() => this.processNextBackgroundDocument(generation), 5);
      return;
    }
    if (this.activeBackground && this.activeBackground.generation !== this.backgroundGeneration) {
      // Roll back before taking the replacement job's snapshot: an obsolete
      // provisional document must never become its committed starting state.
      this.interruptBackgroundAnalysis();
    }
    if (!this.activeBackground && this.pendingLoginIndexing) {
      this.pendingLoginIndexing = false;
      const entry = resolveLoginPath(this.sxmHome, this.tool);
      if (entry) { this.activeBackground = { uri: pathToFileURL(entry).toString(), filePath: entry,
        generation: this.backgroundGeneration, rollback: this.analysisRollback(this.requestRevision, false), login: true, resolutions: new Map(), steps: this.backgroundLoginSteps() }; }
    }
    if (!this.activeBackground) {
      const next = this.pendingBackgroundDocuments.entries().next();
      if (!next.done) {
        const [uri, filePath] = next.value;
        this.pendingBackgroundDocuments.delete(uri);
        this.activeBackground = { uri, filePath, generation: this.backgroundGeneration, rollback: this.analysisRollback(this.requestRevision, false), resolutions: new Map(),
          steps: this.indexSingleBackgroundDiskDocumentSteps(uri, filePath) };
      }
    }
    const active = this.activeBackground;
    if (active) {
      this.backgroundStepping = true;
      try {
        const next = this.withIncludeResolutionCache(() => measureDurationMs(this.logger, 'workspace.background',
          { uri: active.uri }, () => active.steps.next()), active.resolutions);
        if (next.done) { this.activeBackground = undefined; }
        else { next.value?.sync(); }
      } catch (error: unknown) {
        this.activeBackground = undefined;
        this.logger.error(`Background indexing failed for ${active.filePath}: ${getErrorMessage(error)}`);
      } finally { this.backgroundStepping = false; }
    }
    this.backgroundIndexingScheduled = false;
    if (this.activeBackground || this.pendingLoginIndexing || this.pendingBackgroundDocuments.size > 0) { this.scheduleBackgroundIndexing(); }
    else { this.setBackgroundActivity(false); this.resolveBackgroundWaiters(); }
  }

  private *indexSingleBackgroundDiskDocumentSteps(uri: string, filePath: string): Generator<AnalysisStep, void, void> {
    const open = this.openDocumentInput?.(uri) ?? this.openInputs.get(fileIdentity(uri));
    if (open) { yield* this.indexOpenDocumentSteps(open); return; }
    const normalizedPath = path.normalize(filePath);
    const stat = yield* statAnalysisFile(normalizedPath);
    const cached = this.documents.get(uri);
    if (cached?.mtimeMs === stat.mtimeMs && cached.workspaceIndexComplete) {
      this.replaceResolvedIncludeEdgesAndEnqueue(cached.analysis);
      return;
    }
    const text = yield* readAnalysisFile(normalizedPath);
    const initialAnalysis = yield* this.analyzer.analyzeDocumentSteps({ uri, version: 0, text, tool: this.tool,
      internalFeatures: this.internalFeatures, targetPlatform: this.targetPlatform });
    this.setIndexedDocument(uri, { analysis: initialAnalysis, text, filePath: normalizedPath,
      mtimeMs: stat.mtimeMs, workspaceDiagnosticsComplete: false });
    this.replaceResolvedIncludeEdgesAndEnqueue(initialAnalysis);
    const analysis = yield* this.reanalyzeWithVisibleContextSteps({ uri, version: 0, text }, initialAnalysis);
    this.setIndexedDocument(uri, { analysis, text, filePath: normalizedPath, mtimeMs: stat.mtimeMs,
      workspaceIndexComplete: true, workspaceDiagnosticsComplete: false });
    this.analyzer.releaseSyntax(uri);
  }

  private resolveBackgroundWaiters(): void {
    const waiters = this.backgroundWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }

    const changed = this.backgroundChanged;
    this.backgroundChanged = false;
    for (const listener of this.backgroundCompleteListeners) {
      listener(changed);
    }
  }

  private replaceIncludeEdges(uri: string, includedUris: Set<string>, definiteUris = includedUris): void {
    const oldEdges = this.includeGraph.get(uri) ?? new Set<string>();
    const oldDefinite = this.definiteIncludeGraph.get(uri) ?? new Set<string>();
    if (oldEdges.size === includedUris.size && [...oldEdges].every(edge => includedUris.has(edge))
      && oldDefinite.size === definiteUris.size && [...oldDefinite].every(edge => definiteUris.has(edge))) { return; }
    this.invalidateDerivedFor(this.collectDependents(uri));
    for (const includedUri of oldEdges) {
      const dependents = this.reverseIncludeGraph.get(includedUri);
      dependents?.delete(uri);
      if (dependents?.size === 0) {
        this.reverseIncludeGraph.delete(includedUri);
      }
    }

    this.includeGraph.set(uri, includedUris);
    this.definiteIncludeGraph.set(uri, definiteUris);
    for (const includedUri of includedUris) {
      const dependents = this.reverseIncludeGraph.get(includedUri) ?? new Set<string>();
      dependents.add(uri);
      this.reverseIncludeGraph.set(includedUri, dependents);
    }
  }

  private collectDependents(uri: string): Set<string> {
    const dependents = new Set<string>([uri]);
    const pending = [uri];

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) {
        continue;
      }

      for (const dependent of this.reverseIncludeGraph.get(current) ?? []) {
        if (!dependents.has(dependent)) {
          dependents.add(dependent);
          pending.push(dependent);
        }
      }
    }

    return dependents;
  }

  private collectVisibleUris(sourceUri: string): string[] {
    const visibleUris = new Set<string>();
    const pending = [...(this.includeGraph.get(sourceUri) ?? [])];

    for (const filePath of this.getForcedIncludeFiles()) {
      pending.push(pathToFileURL(filePath).toString());
    }

    while (pending.length > 0) {
      const uri = pending.pop();
      if (uri === undefined || documentUriIdentity(uri) === documentUriIdentity(sourceUri) || visibleUris.has(uri)) {
        continue;
      }

      visibleUris.add(uri);
      pending.push(...(this.includeGraph.get(uri) ?? []));
    }

    return Array.from(visibleUris).sort();
  }

  private listCachedVisibleDeclarations(sourceUri: string): AnalysisDeclaration[] {
    const cached = this.cachedVisibleDeclarationsCache.get(sourceUri);
    if (cached) { return cached; }
    const declarations = [
      ...(this.documents.get(sourceUri)?.analysis.declarations ?? []),
      ...this.collectDefiniteVisibleUris(sourceUri)
        .flatMap((uri) => this.documents.get(uri)?.analysis.declarations ?? [])
    ];
    const result = uniqueDeclarations([...declarations.sort(compareDeclarations), ...this.visibleLoginDeclarations(sourceUri, true)]);
    this.cachedVisibleDeclarationsCache.set(sourceUri, result);
    return result;
  }

  private isUncertainRange(analysis: AnalyzedDocument, range: AnalysisRange): boolean {
    return (analysis.uncertainRanges ?? []).some(uncertain => containsSourcePosition(uncertain, range.start));
  }

  // Potential reachability still drives indexing and invalidation. Only an
  // entirely definite include path can establish a declaration as visible.
  private collectDefiniteVisibleUris(sourceUri: string): string[] {
    const cached = this.definiteVisibleUrisCache.get(sourceUri);
    if (cached) { return cached; }
    const visible = new Set<string>();
    const visited = new Set<string>();
    const pending = [sourceUri, ...this.knownForcedIncludeUris()];
    while (pending.length > 0) {
      const uri = pending.pop();
      if (uri === undefined || visited.has(uri)) { continue; }
      visited.add(uri);
      if (documentUriIdentity(uri) !== documentUriIdentity(sourceUri)) { visible.add(uri); }
      pending.push(...(this.definiteIncludeGraph.get(uri) ?? []));
    }
    const result = [...visible].sort();
    this.definiteVisibleUrisCache.set(sourceUri, result);
    return result;
  }

  private collectVisibleUncertainNames(sourceUri: string): string[] {
    const definite = new Set(this.collectDefiniteVisibleUris(sourceUri));
    const names = new Set<string>(this.loginScope(sourceUri)?.uncertainNames ?? []);
    for (const uri of this.collectVisibleUris(sourceUri)) {
      const analysis = this.documents.get(uri)?.analysis;
      if (analysis === undefined) { continue; }
      const globalIds = new Set(analysis.scopes.filter(scope => scope.parentId === undefined).flatMap(scope => scope.declarationIds));
      const possible = analysis.uncertainDeclarations ?? [];
      for (const declaration of possible) {
        if (globalIds.has(declaration.id)) { names.add(declaration.name); }
      }
      for (const name of analysis.uncertainNames ?? []) {
        const local = possible.filter(declaration => declaration.name === name);
        if (local.length === 0 || local.some(declaration => globalIds.has(declaration.id))) { names.add(name); }
      }
      if (!definite.has(uri)) {
        for (const declaration of analysis.declarations) {
          if (globalIds.has(declaration.id)) { names.add(declaration.name); }
        }
      }
    }
    return [...names].sort();
  }

  private collectVisibleGuiClassEntries(sourceUri: string): GuiClassEntry[] {
    return [sourceUri, ...this.collectDefiniteVisibleUris(sourceUri)]
      .flatMap((uri) => (this.documents.get(uri)?.analysis.guiClasses ?? [])
        .map((guiClass) => ({ uri, guiClass })));
  }

  private collectPositionAwareMacroDefinitions(sourceUri: string, recordUndef = false): AnalysisMacroDefinition[] {
    const definitions: AnalysisMacroDefinition[] = [];
    const resolutions = new Map<string, IncludeResolution>();
    const fileStart = { line: 0, character: 0 };

    for (const forcedUri of this.knownForcedIncludeUris()) {
      this.appendDocumentMacroDefinitions(forcedUri, fileStart, new Set(), definitions, recordUndef, resolutions);
    }

    this.appendDocumentMacroDefinitions(sourceUri, undefined, new Set(), definitions, recordUndef, resolutions);
    // Nested includes expose their final macro state at one source position.
    // Keep the last event (including #undef) there, but preserve distinct positions.
    const seen = new Set<string>();
    const compact: AnalysisMacroDefinition[] = [];
    for (let i = definitions.length - 1; i >= 0; i--) {
      const macro = definitions[i];
      const start = macro.visibilityStart!;
      const key = `${macro.name}:${start.line}:${start.character}`;
      if (seen.has(key)) { continue; }
      seen.add(key);
      compact.push(macro);
    }
    return compact.reverse();
  }

  private appendDocumentMacroDefinitions(
    uri: string,
    visibilityStart: AnalysisPosition | undefined,
    visitedUris: Set<string>,
    definitions: AnalysisMacroDefinition[],
    recordUndef: boolean,
    resolutions: Map<string, IncludeResolution>
  ): void {
    if (visitedUris.has(uri)) {
      return;
    }

    const analysis = this.documents.get(uri)?.analysis;
    const includingFilePath = filePathFromUri(uri);
    if (analysis === undefined) {
      return;
    }

    const visited = new Set([...visitedUris, uri]);
    const events = [
      ...(recordUndef ? analysis.macroUndefinitions ?? (analysis.typeSnapshot
        ? descendants(analysis.typeSnapshot.root, 'preproc_call').filter(node => field(node, 'directive')?.text.replace(/\s/g, '') === '#undef')
          .map(node => ({ name: field(node, 'argument')?.text.trim() ?? '', range: node.range })) : []) : [])
        .filter(event => event.name && ![...analysis.inactiveRanges ?? [], ...analysis.uncertainRanges ?? []]
          .some(range => containsSourcePosition(range, event.range.start)))
        .map(event => ({ range: event.range, run: () => {
          const removed: AnalysisMacroDefinition & {_typeUndef:true} = {name:event.name,uri,range:event.range,
            selectionRange:event.range,visibilityStart:visibilityStart ?? event.range.end,
            detail:'',replacementText:'',_typeUndef:true};
          definitions.push(removed);
        }})),
      ...analysis.macroDefinitions.map((macro) => ({
        range: macro.range,
        run: () => definitions.push({
          ...macro,
          visibilityStart: visibilityStart ?? macro.range.end
        })
      })),
      ...analysis.includes.filter(include => !this.isUncertainRange(analysis, include.range)).map((include) => ({
        range: include.range,
        run: () => {
          if (includingFilePath === undefined) {
            return;
          }

          const includeText = includeTextForResolution(include.includePath, include.kind);
          const key = JSON.stringify([includingFilePath, includeText]);
          let resolution = resolutions.get(key);
          if (!resolution) {
            resolution = this.resolveInclude({includingFilePath, includeText, includeRoots:this.includeRoots});
            resolutions.set(key, resolution);
          }
          if (resolution.status === 'resolved') {
            this.appendDocumentMacroDefinitions(
              resolution.uri,
              visibilityStart ?? include.range.end,
              visited,
              definitions,
              recordUndef,
              resolutions
            );
          }
        }
      }))
    ].sort((left, right) => compareRanges(left.range, right.range));

    for (const event of events) {
      event.run();
    }
  }

  private collectVisiblePreprocessorSymbols(sourceUri: string): AnalysisPreprocessorSymbol[] {
    const definiteUris = new Set(this.collectDefiniteVisibleUris(sourceUri));
    const symbols: AnalysisPreprocessorSymbol[] = [
      ...defaultPreprocessorSymbols(this.defines).filter(symbol => !isSystemMacroName(symbol.name)),
      ...[...definiteUris]
      .flatMap((uri) => (this.documents.get(uri)?.analysis.declarations ?? []))
      .filter((declaration) => declaration.kind === 'macro')
      .sort(compareDeclarations)
      .map((declaration) => ({
        name: declaration.name,
        value: macroValueFromDetail(declaration)
      }))
    ];
    const byName = new Map(symbols.map(symbol => [symbol.name, symbol]));
    const uncertainNames = new Set<string>();
    for (const uri of this.collectVisibleUris(sourceUri)) {
      const analysis = this.documents.get(uri)?.analysis;
      if (analysis === undefined) { continue; }
      const possibleMacros = [
        ...(analysis.uncertainMacroDefinitions ?? []),
        ...(definiteUris.has(uri) ? [] : analysis.macroDefinitions)
      ];
      for (const macro of possibleMacros) {
        if (isSystemMacroName(macro.name)) { continue; }
        uncertainNames.add(macro.name);
      }
    }
    if (uncertainNames.size === 0) { return [...byName.values()]; }
    // Uncertain imports take effect at their include, rather than before all
    // local definitions. Keep the established handling of definite-only names.
    for (const name of uncertainNames) { byName.delete(name); }
    for (const symbol of defaultPreprocessorSymbols(this.defines)) {
      if (uncertainNames.has(symbol.name)) { byName.set(symbol.name, symbol); }
    }
    for (const uri of this.knownForcedIncludeUris()) {
      for (const symbol of this.collectImportedMacroSymbols(uri)) {
        if (!uncertainNames.has(symbol.name)) { continue; }
        const existing = byName.get(symbol.name);
        byName.set(symbol.name, symbol.possiblyUndefined && existing !== undefined
          ? { ...existing, unknownValue: true } : symbol);
      }
    }
    const events: AnalysisPreprocessorSymbol[] = [];
    const includingFilePath = filePathFromUri(sourceUri);
    if (includingFilePath !== undefined) {
      for (const include of this.documents.get(sourceUri)?.analysis.includes ?? []) {
        const resolution = this.resolveInclude({
          includingFilePath,
          includeText: includeTextForResolution(include.includePath, include.kind),
          includeRoots: this.includeRoots
        });
        if (resolution.status !== 'resolved') { continue; }
        events.push(...this.collectImportedMacroSymbols(resolution.uri)
          .filter(symbol => uncertainNames.has(symbol.name))
          .map(symbol => ({ ...symbol, sourceRange: include.range })));
      }
    }
    return [...byName.values(), ...events];
  }

  private collectImportedMacroSymbols(rootUri: string): AnalysisPreprocessorSymbol[] {
    const reachable = (graph: Map<string, Set<string>>): Set<string> => {
      const result = new Set<string>();
      const pending = [rootUri];
      while (pending.length > 0) {
        const uri = pending.pop();
        if (uri === undefined || result.has(uri)) { continue; }
        result.add(uri);
        pending.push(...(graph.get(uri) ?? []));
      }
      return result;
    };
    const definite = reachable(this.definiteIncludeGraph);
    const symbols = new Map<string, AnalysisPreprocessorSymbol>();
    for (const uri of [...reachable(this.includeGraph)].sort()) {
      const analysis = this.documents.get(uri)?.analysis;
      if (analysis === undefined) { continue; }
      for (const macro of [...analysis.macroDefinitions, ...(analysis.uncertainMacroDefinitions ?? [])]) {
        if (isSystemMacroName(macro.name)) { continue; }
        const possible = !definite.has(uri) || (analysis.uncertainMacroDefinitions ?? []).includes(macro);
        const previous = symbols.get(macro.name);
        if (possible) {
          symbols.set(macro.name, {
            name: macro.name,
            value: previous?.value,
            possiblyUndefined: previous === undefined || previous.possiblyUndefined,
            unknownValue: true
          });
        } else {
          symbols.set(macro.name, { name: macro.name, value: macro.replacementText,
            unknownValue: previous?.unknownValue });
        }
      }
    }
    return [...symbols.values()];
  }

  private getForcedIncludeFiles(): string[] {
    this.forcedIncludeFileCache ??= collectForcedIncludeFiles({
      forcedIncludeRoots: this.forcedIncludeRoots,
      forcedIncludeFiles: this.forcedIncludeFiles
    });
    return this.forcedIncludeFileCache;
  }

  private logSystemMacroConfiguration(options: unknown): void {
    if (options === null || typeof options !== 'object') { return; }
    const candidate = options as { tool?: unknown; targetPlatform?: unknown; defines?: unknown };
    if (candidate.tool !== undefined && normalizeTool(candidate.tool) !== candidate.tool) {
      this.logger.info('[configuration] Invalid Tool; using axel.');
    }
    if (candidate.targetPlatform !== undefined && normalizeTargetPlatform(candidate.targetPlatform) !== candidate.targetPlatform) {
      this.logger.info('[configuration] Invalid targetPlatform; using windows-x64.');
    }
    if (Array.isArray(candidate.defines)) {
      for (const define of candidate.defines) {
        if (typeof define === 'string' && isSystemMacroName(define.split('=', 1)[0].trim())) {
          this.logger.info('[configuration] Reserved system macro ignored: ' + define.split('=', 1)[0].trim());
        }
      }
    }
  }

  private enqueueKnownForcedIncludeFiles(): void {
    for (const filePath of this.knownForcedIncludeFiles()) {
      const uri = pathToFileURL(filePath).toString();
      if (!this.documents.has(uri)) {
        this.enqueueBackgroundDocument(uri, filePath);
      }
    }
  }

  private knownForcedIncludeUris(): string[] {
    return this.knownForcedIncludeFiles()
      .map((filePath) => pathToFileURL(filePath).toString());
  }

  private knownForcedIncludeFiles(): string[] {
    return Array.from(new Set([
      ...this.forcedIncludeFiles,
      ...(this.forcedIncludeFileCache ?? [])
    ])).sort();
  }

  // Install a synchronous-call or background-job cache only while executing.
  // Suspended jobs never lend their cached resolutions to unrelated requests.
  private withIncludeResolutionCache<T>(work: () => T, resolutions = new Map<string, IncludeResolution>()): T {
    if (this.includeResolutionCache) { return work(); }
    this.includeResolutionCache = resolutions;
    try { return work(); } finally { this.includeResolutionCache = undefined; }
  }

  private resolveInclude(input: Parameters<typeof resolveInclude>[0]): IncludeResolution {
    const cache = this.includeResolutionCache;
    const key = JSON.stringify([input.includingFilePath, input.includeText]);
    const cached = cache?.get(key);
    if (cached) { return cached; }
    const sourceUri = pathToFileURL(input.includingFilePath).toString();
    const candidates = this.includeCandidateDependencies.get(sourceUri) ?? new Set<string>();
    this.includeCandidateDependencies.set(sourceUri, candidates);
    const resolution = resolveInclude({ ...input, fileExists: file => {
      candidates.add(pathToFileURL(file).toString());
      return input.fileExists ? input.fileExists(file) : isIncludeFile(file);
    } });
    cache?.set(key, resolution);
    return resolution;
  }

  private clearInvalidatedAnalysis(): void {
    this.clearCachedAnalysis();
    // A broad dependency edit may interrupt background work before its edges
    // are published. Keep open documents queued so existing waiters settle on
    // the new generation rather than an empty, provisionally indexed workspace.
    for (const input of this.openInputs.values()) {
      this.enqueueBackgroundDocument(input.uri, filePathFromUri(input.uri) ?? input.uri);
    }
  }

  private invalidateDerivedFor(uris: Iterable<string>): void {
    const affected = new Set(uris);
    if (this.knownForcedIncludeUris().some(uri => affected.has(uri))) {
      this.derivedCache.invalidate();
    } else {
      this.derivedCache.invalidate(affected);
    }
  }

  private setIndexedDocument(uri: string, document: IndexedDocument): void {
    if (this.documents.get(uri)?.analysis !== document.analysis) {
      if (this.backgroundStepping) { this.backgroundChanged = true; }
      this.invalidateDerivedFor(this.collectDependents(uri));
    }
    this.documents.set(uri, document);
  }

  private deleteIndexedDocument(uri: string): void {
    if (this.documents.has(uri)) { this.invalidateDerivedFor(this.collectDependents(uri)); }
    this.documents.delete(uri);
  }

  private clearCachedAnalysis(): void {
    this.outlineAnalyzer.clear();
    this.reusedDependencyOpens.clear();
    this.backgroundGeneration++;
    if (!this.backgroundStepping) {
      this.activeBackground?.steps.return();
      this.activeBackground = undefined;
    }
    this.includeContexts.clear();
    this.builtinCatalogCache = undefined;
    this.forcedIncludesIndexed = false;
    for (const uri of this.documents.keys()) {
      this.analyzer.clear(uri);
    }

    this.derivedCache.invalidate();
    this.documents.clear();
    this.diagnosticIncludeDependencies.clear();
    this.includeCandidateDependencies.clear();
    this.includeGraph.clear();
    this.definiteIncludeGraph.clear();
    this.reverseIncludeGraph.clear();
    this.pendingBackgroundDocuments.clear();
    this.pendingLoginIndexing = false;
  }
}

function compareDeclarations(left: AnalysisDeclaration, right: AnalysisDeclaration): number {
  return left.uri.localeCompare(right.uri)
    || left.selectionRange.start.line - right.selectionRange.start.line
    || left.selectionRange.start.character - right.selectionRange.start.character
    || left.selectionRange.end.line - right.selectionRange.end.line
    || left.selectionRange.end.character - right.selectionRange.end.character;
}

function macroValueFromDetail(declaration: AnalysisDeclaration): string | undefined {
  const prefix = `#define ${declaration.name}`;
  if (!declaration.detail.startsWith(prefix)) {
    return undefined;
  }

  const rest = declaration.detail.slice(prefix.length).trim();
  return rest.startsWith('(') ? undefined : rest || undefined;
}

interface GuiClassEntry {
  uri: string;
  guiClass: AnalysisGuiClass;
}

function compareGuiClassEntries(left: GuiClassEntry, right: GuiClassEntry): number {
  return left.uri.localeCompare(right.uri)
    || compareRanges(left.guiClass.range, right.guiClass.range);
}

function compareRanges(left: AnalysisRange, right: AnalysisRange): number {
  return left.start.line - right.start.line
    || left.start.character - right.start.character
    || left.end.line - right.end.line
    || left.end.character - right.end.character;
}

function comparePositions(left: AnalysisPosition, right: AnalysisPosition): number {
  return left.line - right.line || left.character - right.character;
}

function normalizePaths(paths: string[]): string[] {
  return paths.map((filePath) => path.normalize(filePath));
}

function defaultPreprocessorSymbols(defines: readonly string[]): AnalysisPreprocessorSymbol[] {
  return defines
    .map(preprocessorSymbolFromDefine)
    .filter((symbol): symbol is AnalysisPreprocessorSymbol => symbol !== undefined);
}

function preprocessorSymbolFromDefine(define: string): AnalysisPreprocessorSymbol | undefined {
  const trimmed = define.trim();
  const match = trimmed.match(/^([A-Za-z_$][0-9A-Za-z_$]*)(?:\s*=\s*(.*))?$/);
  if (match === null) {
    return undefined;
  }

  const value = match[2]?.trim();
  return {
    name: match[1],
    ...(value === undefined || value === '' ? {} : { value })
  };
}

function includePathCompletions(roots: string[], prefix: string): string[] {
  return pathCompletions(roots, prefix, /\.(?:axl|h|hh)$/i);
}

function pathCompletions(roots: string[], prefix: string, filePattern: RegExp, preserveRootOrder = false): string[] {
  const entries: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }

    const joinedPrefix = path.join(root, prefix);
    const prefixEndsWithSeparator = prefix.endsWith('/') || prefix.endsWith('\\') || prefix.length === 0;
    const dir = prefixEndsWithSeparator
      ? joinedPrefix
      : path.dirname(joinedPrefix);
    const basePrefix = prefixEndsWithSeparator ? '' : path.basename(prefix);
    if (!fs.existsSync(dir)) {
      continue;
    }

    const children = fs.readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of children) {
      if (!entry.name.startsWith(basePrefix)) {
        continue;
      }

      const candidate = path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/');
      if (entry.isDirectory() || filePattern.test(entry.name)) {
        entries.push(entry.isDirectory() ? `${candidate}/` : candidate);
      }
    }
  }

  const uniqueEntries = Array.from(new Set(entries));
  return preserveRootOrder ? uniqueEntries : uniqueEntries.sort();
}

function filePathFromUri(uri: string): string | undefined {
  try {
    return path.normalize(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

function includeTextForResolution(includePath: string, kind: string): string {
  if (kind === 'quote') {
    return `"${includePath}"`;
  }

  if (kind === 'angle') {
    return `<${includePath}>`;
  }

  return includePath;
}

function limitDiagnostics(diagnostics: AnalysisDiagnostic[], maxNumberOfProblems: number | undefined): AnalysisDiagnostic[] {
  if (maxNumberOfProblems === undefined) {
    return diagnostics;
  }

  return diagnostics.slice(0, maxNumberOfProblems);
}

function containsPosition(range: AnalysisRange, position: AnalysisPosition): boolean {
  return positionBeforeOrEqual(range.start, position) && positionBefore(position, range.end);
}

function positionBeforeOrEqual(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line < right.line || (left.line === right.line && left.character <= right.character);
}

function positionBefore(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line < right.line || (left.line === right.line && left.character < right.character);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function uniqueDeclarations(declarations: AnalysisDeclaration[]): AnalysisDeclaration[] {
  const unique = new Map<string, AnalysisDeclaration>();
  for (const declaration of declarations) {
    if (!unique.has(declaration.id)) { unique.set(declaration.id, declaration); }
  }
  return [...unique.values()];
}

/** Compare URI spelling without filesystem I/O in visibility and macro traversal. */
function documentUriIdentity(uri: string): string {
  try {
    const filename = path.normalize(fileURLToPath(uri));
    return process.platform === 'win32' ? filename.toLowerCase() : filename;
  } catch { return uri; }
}

function fileIdentity(uri: string): string {
  try {
    let existing = path.normalize(fileURLToPath(uri));
    const suffix: string[] = [];
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
      suffix.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
    try { existing = fs.realpathSync.native(existing); } catch { /* Preserve inaccessible path identity. */ }
    const filename = path.join(existing, ...suffix);
    return process.platform === 'win32' ? filename.toLowerCase() : filename;
  } catch { return uri; }
}
