import { normalizeTargetPlatform } from './targetPlatform';
import { descendants, field } from './typeChecking/syntax';
import { collectTypeDiagnostics } from './typeChecking/diagnostics';
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
import { collectForcedIncludeFiles, type ForcedIncludeOptions } from './forcedIncludes';
import { resolveInclude, resolveScriptExecution } from './includeResolver';
import type { WorkspaceDeclarationLookup } from './resolution';
import { collectSemanticDiagnostics } from './semanticDiagnostics';
import { mergeWorkspaceIndexOptions } from './workspaceConfig';
import { collectIncludeResolutionStatus, type IncludeResolutionStatus } from './includeDiagnostics';
import { measureDurationMs, NullLogger, type AnalysisLogger } from '../util/logger';

export interface WorkspaceIndexOptions extends ForcedIncludeOptions {
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
  analysis: AnalyzedDocument;
  filePath?: string;
  version?: number;
  mtimeMs?: number;
  workspaceDiagnosticsComplete?: boolean;
}

export class WorkspaceIndex {
  private readonly analyzer: DocumentAnalyzer;
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
  private readonly includeGraph = new Map<string, Set<string>>();
  private readonly definiteIncludeGraph = new Map<string, Set<string>>();
  private readonly reverseIncludeGraph = new Map<string, Set<string>>();
  private forcedIncludeFileCache: string[] | undefined;
  private indexingForcedIncludes = false;
  private forcedIncludesIndexed = false;
  private readonly pendingBackgroundDocuments = new Map<string, string>();
  private backgroundIndexingScheduled = false;
  private readonly backgroundWaiters: (() => void)[] = [];
  private readonly backgroundCompleteListeners: (() => void)[] = [];

  public constructor(options: WorkspaceIndexOptions = {}) {
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
  }

  public configure(options: unknown): void {
    this.logSystemMacroConfiguration(options);
    const merged = mergeWorkspaceIndexOptions({
      includeRoots: this.includeRoots,
      forcedIncludeRoots: this.forcedIncludeRoots,
      forcedIncludeFiles: this.forcedIncludeFiles,
      defines: this.defines
    }, options);

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

  public analyzeDocument(input: AnalyzeDocumentInput): AnalyzedDocument {
    return this.indexOpenDocument(input);
  }

  public analyzeForegroundDocument(input: AnalyzeDocumentInput): AnalyzedDocument {
    return measureDurationMs(this.logger, 'workspace.foreground', { uri: input.uri, version: input.version }, () => {
      const cached = this.documents.get(input.uri);
      if (cached?.version === input.version) {
        return cached.analysis;
      }

      const analysis = this.analyzer.analyzeDocument({ ...input, tool: this.tool, internalFeatures: this.internalFeatures, targetPlatform: this.targetPlatform });
      this.documents.set(input.uri, {
        analysis,
        version: input.version,
        filePath: filePathFromUri(input.uri),
        workspaceDiagnosticsComplete: false
      });
      this.enqueueKnownForcedIncludeFiles();
      this.replaceResolvedIncludeEdgesAndEnqueue(analysis);
      return analysis;
    });
  }

  public analyzeDiagnosticDocument(input: AnalyzeDocumentInput): AnalyzedDocument {
    const foregroundAnalysis = this.analyzeForegroundDocument(input);
    if (this.backgroundIndexingScheduled || this.pendingBackgroundDocuments.size > 0) {
      return foregroundAnalysis;
    }

    return this.indexOpenDocument(input);
  }

  public getIncludeResolutionStatus(analysis: AnalyzedDocument): IncludeResolutionStatus {
    const status = collectIncludeResolutionStatus(analysis, this.includeRoots,
      Array.from(new Set([...this.forcedIncludeFiles, ...this.getForcedIncludeFiles()])),
      uri => this.documents.get(uri)?.analysis);
    status.diagnostics = limitDiagnostics(status.diagnostics, this.maxNumberOfProblems);
    this.diagnosticIncludeDependencies.set(analysis.uri, status.dependencyUris);
    return status;
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

  public onBackgroundIndexingComplete(listener: () => void): void {
    this.backgroundCompleteListeners.push(listener);
  }

  public indexOpenDocument(input: AnalyzeDocumentInput): AnalyzedDocument {
    const cached = this.documents.get(input.uri);
    if (cached?.version === input.version && cached.workspaceDiagnosticsComplete === true) {
      return cached.analysis;
    }

    const initialAnalysis = this.analyzer.analyzeDocument({ ...input, tool: this.tool, internalFeatures: this.internalFeatures, targetPlatform: this.targetPlatform });
    this.documents.set(input.uri, {
      analysis: initialAnalysis,
      version: input.version,
      filePath: filePathFromUri(input.uri),
      workspaceDiagnosticsComplete: false
    });
    this.indexResolvedIncludes(initialAnalysis, new Set([input.uri]));
    const analysis = this.withWorkspaceDiagnostics(this.reanalyzeWithVisibleContext(input, initialAnalysis));
    this.documents.set(input.uri, {
      ...(this.documents.get(input.uri) ?? {}),
      analysis,
      workspaceDiagnosticsComplete: true
    });
    return analysis;
  }

  public indexDiskDocument(filePath: string): AnalyzedDocument {
    return this.indexDiskDocumentInternal(path.normalize(filePath), new Set());
  }

  public indexForcedIncludes(): void {
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
  }

  private ensureForcedIncludesIndexed(): void {
    if (!this.forcedIncludesIndexed) {
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
    return this.collectDefiniteVisibleUris(sourceUri)
      .flatMap((uri) => this.documents.get(uri)?.analysis.declarations ?? [])
      .filter((declaration) => declaration.name === name)
      .sort(compareDeclarations);
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
    const declarations = [
      ...(this.documents.get(sourceUri)?.analysis.declarations ?? []),
      ...this.collectDefiniteVisibleUris(sourceUri)
        .flatMap((uri) => this.documents.get(uri)?.analysis.declarations ?? [])
    ];
    return Array.from(new Map(declarations.map((declaration) => [declaration.id, declaration])).values())
      .sort(compareDeclarations);
  }

  public listVisibleDocuments(sourceUri: string): AnalyzedDocument[] {
    this.ensureForcedIncludesIndexed();
    return [sourceUri, ...this.collectVisibleUris(sourceUri)]
      .map((uri) => this.documents.get(uri)?.analysis)
      .filter((analysis): analysis is AnalyzedDocument => analysis !== undefined);
  }

  public listReferenceSearchDocuments(sourceUri: string): AnalyzedDocument[] {
    void sourceUri;
    this.ensureForcedIncludesIndexed();
    return Array.from(this.documents.values())
      .map((document) => document.analysis);
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

    const resolution = resolveInclude({
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
    this.invalidateUri(uri);
    this.diagnosticIncludeDependencies.delete(uri);
    this.documents.delete(uri);
    this.replaceIncludeEdges(uri, new Set());
    this.analyzer.clear(uri);
  }

  public invalidateFile(filePath: string): void {
    const uri = pathToFileURL(path.normalize(filePath)).toString();
    this.invalidateUri(uri);
  }

  public invalidateUri(uri: string): void {
    const catalogSource = this.builtinCatalogCache?.declarationUris.has(uri);
    this.builtinCatalogCache = undefined;
    if (uri.endsWith('.analysis.json') || catalogSource || this.knownForcedIncludeUris().includes(uri)) {
      this.clearCachedAnalysis();
      return;
    }
    this.forcedIncludesIndexed = false;
    const dependents = this.collectDependents(uri);
    // Missing include candidates have no resolved graph edge. Track them so
    // creating a header also invalidates documents waiting for that header.
    for (const [sourceUri, dependencies] of this.diagnosticIncludeDependencies) {
      if (dependencies.has(uri)) {
        for (const dependentUri of this.collectDependents(sourceUri)) { dependents.add(dependentUri); }
      }
    }
    for (const dependentUri of dependents) {
      this.documents.delete(dependentUri);
      this.analyzer.clear(dependentUri);
    }
  }

  private indexDiskDocumentInternal(filePath: string, visitedUris: Set<string>): AnalyzedDocument {
    const normalizedPath = path.normalize(filePath);
    const uri = pathToFileURL(normalizedPath).toString();
    const stat = fs.statSync(normalizedPath);
    const cached = this.documents.get(uri);

    if (cached?.mtimeMs === stat.mtimeMs && cached.workspaceDiagnosticsComplete === true) {
      this.indexResolvedIncludes(cached.analysis, new Set([...visitedUris, uri]));
      return cached.analysis;
    }

    if (visitedUris.has(uri)) {
      const existing = this.documents.get(uri);
      if (existing !== undefined) {
        return existing.analysis;
      }
    }

    const text = fs.readFileSync(normalizedPath, 'utf8');
    const initialAnalysis = this.analyzer.analyzeDocument({ uri, version: 0, text, tool: this.tool, internalFeatures: this.internalFeatures, targetPlatform: this.targetPlatform });
    this.documents.set(uri, {
      analysis: initialAnalysis,
      filePath: normalizedPath,
      mtimeMs: stat.mtimeMs,
      workspaceDiagnosticsComplete: false
    });
    this.indexResolvedIncludes(initialAnalysis, new Set([...visitedUris, uri]));
    const analysis = this.withWorkspaceDiagnostics(
      this.reanalyzeWithVisibleContext({ uri, version: 0, text }, initialAnalysis)
    );
    this.documents.set(uri, {
      analysis,
      filePath: normalizedPath,
      mtimeMs: stat.mtimeMs,
      workspaceDiagnosticsComplete: true
    });
    return analysis;
  }

  private withWorkspaceDiagnostics(analysis: AnalyzedDocument): AnalyzedDocument {
    const macros = this.collectPositionAwareMacroDefinitions(analysis.uri, true);
    const macrosByName = new Map<string, AnalysisMacroDefinition[]>();
    for (const macro of macros) {
      const entries = macrosByName.get(macro.name) ?? [];
      entries.push(macro); macrosByName.set(macro.name, entries);
    }
    return {
      ...analysis,
      diagnostics: limitDiagnostics([
        ...analysis.diagnostics,
        ...collectTypeDiagnostics({analysis,
          resolveMacro: (name,node) => {
            const macro = macrosByName.get(name)?.filter(macro => !macro.visibilityStart || comparePositions(macro.visibilityStart,node.range.start)<=0).at(-1);
            return macro && !('_typeUndef' in macro) ? macro : undefined;
          },
          documents: this.collectDefiniteVisibleUris(analysis.uri).flatMap(uri => {
            const visible = this.documents.get(uri)?.analysis;
            return visible ? [visible] : [];
          }), catalog: this.builtinCatalogCache ??= loadBuiltinCatalog(this.forcedIncludeFiles)}),
        ...this.unresolvedIncludeDiagnostics(analysis),
        ...this.unresolvedScriptExecutionDiagnostics(analysis),
        ...collectSemanticDiagnostics({
          analysis,
          workspaceIndex: this
        })
      ], this.maxNumberOfProblems)
    };
  }

  private unresolvedIncludeDiagnostics(analysis: AnalyzedDocument): AnalysisDiagnostic[] {
    const includingFilePath = filePathFromUri(analysis.uri);
    if (includingFilePath === undefined) {
      return [];
    }

    return analysis.includes
      .map((include) => ({
        include,
        resolution: resolveInclude({
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

  private reanalyzeWithVisibleContext(
    input: AnalyzeDocumentInput,
    initialAnalysis: AnalyzedDocument
  ): AnalyzedDocument {
    if (!this.indexingForcedIncludes) {
      this.indexForcedIncludes();
    }

    const knownGuiClasses = this.collectVisibleGuiClassEntries(input.uri)
      .sort(compareGuiClassEntries)
      .map((entry) => ({
        name: entry.guiClass.name,
        kind: entry.guiClass.kind
      }));
    const preprocessorSymbols = this.collectVisiblePreprocessorSymbols(input.uri);
    const uncertainNames = this.collectVisibleUncertainNames(input.uri);
    const macroDefinitions = this.collectPositionAwareMacroDefinitions(input.uri)
      .filter((macro) => macro.uri !== input.uri);
    if (knownGuiClasses.length === 0 && preprocessorSymbols.length === 0 && macroDefinitions.length === 0 && uncertainNames.length === 0) {
      return initialAnalysis;
    }

    const analysis = this.analyzer.analyzeDocument({
      ...input,
      tool: this.tool, internalFeatures: this.internalFeatures, targetPlatform: this.targetPlatform,
      knownGuiClasses,
      preprocessorSymbols,
      uncertainNames,
      macroDefinitions
    });
    this.documents.set(input.uri, {
      ...(this.documents.get(input.uri) ?? {}),
      analysis,
      workspaceDiagnosticsComplete: false
    });
    this.indexResolvedIncludes(analysis, new Set([input.uri]));
    return analysis;
  }

  private indexResolvedIncludes(analysis: AnalyzedDocument, visitedUris: Set<string>): void {
    const includingFilePath = filePathFromUri(analysis.uri);
    if (includingFilePath === undefined) {
      return;
    }

    const resolvedUris = new Set<string>();
    const definiteUris = new Set<string>();
    for (const include of analysis.includes) {
      const resolution = resolveInclude({
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
        this.indexDiskDocumentInternal(resolution.filePath, new Set([...visitedUris, resolution.uri]));
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
      const resolution = resolveInclude({
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
    if (this.backgroundIndexingScheduled) {
      return;
    }

    this.backgroundIndexingScheduled = true;
    setImmediate(() => this.processNextBackgroundDocument());
  }

  private processNextBackgroundDocument(): void {
    const next = this.pendingBackgroundDocuments.entries().next();
    if (next.done === true) {
      this.backgroundIndexingScheduled = false;
      this.resolveBackgroundWaiters();
      return;
    }

    const [uri, filePath] = next.value;
    this.pendingBackgroundDocuments.delete(uri);
    try {
      this.indexSingleBackgroundDiskDocument(uri, filePath);
    } catch (error: unknown) {
      this.logger.error(`Background indexing failed for ${filePath}: ${getErrorMessage(error)}`);
    }

    this.backgroundIndexingScheduled = false;
    if (this.pendingBackgroundDocuments.size === 0) {
      this.resolveBackgroundWaiters();
      return;
    }

    this.scheduleBackgroundIndexing();
  }

  private indexSingleBackgroundDiskDocument(uri: string, filePath: string): void {
    measureDurationMs(this.logger, 'workspace.background', { uri }, () => {
      const normalizedPath = path.normalize(filePath);
      const stat = fs.statSync(normalizedPath);
      const cached = this.documents.get(uri);
      if (cached?.mtimeMs === stat.mtimeMs) {
        this.replaceResolvedIncludeEdgesAndEnqueue(cached.analysis);
        return;
      }

      const text = fs.readFileSync(normalizedPath, 'utf8');
      const initialAnalysis = this.analyzer.analyzeDocument({ uri, version: 0, text, tool: this.tool, internalFeatures: this.internalFeatures, targetPlatform: this.targetPlatform });
      this.documents.set(uri, {
        analysis: initialAnalysis,
        filePath: normalizedPath,
        mtimeMs: stat.mtimeMs,
        workspaceDiagnosticsComplete: false
      });
      this.replaceResolvedIncludeEdgesAndEnqueue(initialAnalysis);
      const analysis = this.withWorkspaceDiagnostics(
        this.reanalyzeWithVisibleContext({ uri, version: 0, text }, initialAnalysis)
      );
      this.documents.set(uri, {
        analysis,
        filePath: normalizedPath,
        mtimeMs: stat.mtimeMs,
        workspaceDiagnosticsComplete: true
      });
    });
  }

  private resolveBackgroundWaiters(): void {
    const waiters = this.backgroundWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }

    for (const listener of this.backgroundCompleteListeners) {
      listener();
    }
  }

  private replaceIncludeEdges(uri: string, includedUris: Set<string>, definiteUris = includedUris): void {
    const oldEdges = this.includeGraph.get(uri) ?? new Set<string>();
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
      if (uri === undefined || uri === sourceUri || visibleUris.has(uri)) {
        continue;
      }

      visibleUris.add(uri);
      pending.push(...(this.includeGraph.get(uri) ?? []));
    }

    return Array.from(visibleUris).sort();
  }

  private listCachedVisibleDeclarations(sourceUri: string): AnalysisDeclaration[] {
    const declarations = [
      ...(this.documents.get(sourceUri)?.analysis.declarations ?? []),
      ...this.collectDefiniteVisibleUris(sourceUri)
        .flatMap((uri) => this.documents.get(uri)?.analysis.declarations ?? [])
    ];
    return Array.from(new Map(declarations.map((declaration) => [declaration.id, declaration])).values())
      .sort(compareDeclarations);
  }

  private isUncertainRange(analysis: AnalyzedDocument, range: AnalysisRange): boolean {
    return (analysis.uncertainRanges ?? []).some(uncertain => containsSourcePosition(uncertain, range.start));
  }

  // Potential reachability still drives indexing and invalidation. Only an
  // entirely definite include path can establish a declaration as visible.
  private collectDefiniteVisibleUris(sourceUri: string): string[] {
    const visible = new Set<string>();
    const visited = new Set<string>();
    const pending = [sourceUri, ...this.knownForcedIncludeUris()];
    while (pending.length > 0) {
      const uri = pending.pop();
      if (uri === undefined || visited.has(uri)) { continue; }
      visited.add(uri);
      if (uri !== sourceUri) { visible.add(uri); }
      pending.push(...(this.definiteIncludeGraph.get(uri) ?? []));
    }
    return [...visible].sort();
  }

  private collectVisibleUncertainNames(sourceUri: string): string[] {
    const definite = new Set(this.collectDefiniteVisibleUris(sourceUri));
    const names = new Set<string>();
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
    const fileStart = { line: 0, character: 0 };

    for (const forcedUri of this.knownForcedIncludeUris()) {
      this.appendDocumentMacroDefinitions(forcedUri, fileStart, new Set(), definitions, recordUndef);
    }

    this.appendDocumentMacroDefinitions(sourceUri, undefined, new Set(), definitions, recordUndef);
    return definitions;
  }

  private appendDocumentMacroDefinitions(
    uri: string,
    visibilityStart: AnalysisPosition | undefined,
    visitedUris: Set<string>,
    definitions: AnalysisMacroDefinition[],
    recordUndef = false
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
      ...(recordUndef && analysis.typeSnapshot ? descendants(analysis.typeSnapshot.root,'preproc_call') : [])
        .filter(node => field(node,'directive')?.text.replace(/\s/g,'') === '#undef'
          && ![...analysis.inactiveRanges ?? [], ...analysis.uncertainRanges ?? []]
            .some(range => containsSourcePosition(range,node.range.start)))
        .map(node => ({range:node.range, run:() => {
          const name=field(node,'argument')?.text.trim();
          if (!name) { return; }
          const removed: AnalysisMacroDefinition & {_typeUndef:true} = {name,uri,range:node.range,
            selectionRange:node.range,visibilityStart:visibilityStart ?? node.range.end,
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

          const resolution = resolveInclude({
            includingFilePath,
            includeText: includeTextForResolution(include.includePath, include.kind),
            includeRoots: this.includeRoots
          });
          if (resolution.status === 'resolved') {
            this.appendDocumentMacroDefinitions(
              resolution.uri,
              visibilityStart ?? include.range.end,
              visited,
              definitions,
              recordUndef
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
        const resolution = resolveInclude({
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

  private clearCachedAnalysis(): void {
    this.builtinCatalogCache = undefined;
    this.forcedIncludesIndexed = false;
    for (const uri of this.documents.keys()) {
      this.analyzer.clear(uri);
    }

    this.documents.clear();
    this.diagnosticIncludeDependencies.clear();
    this.includeGraph.clear();
    this.definiteIncludeGraph.clear();
    this.reverseIncludeGraph.clear();
    this.pendingBackgroundDocuments.clear();
    this.backgroundIndexingScheduled = false;
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
