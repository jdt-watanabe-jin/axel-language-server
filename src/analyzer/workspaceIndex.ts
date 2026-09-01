import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type {
  AnalysisDeclaration,
  AnalysisDiagnostic,
  AnalysisGuiClass,
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
import { measureDurationMs, NullLogger, type AnalysisLogger } from '../util/logger';

export interface WorkspaceIndexOptions extends ForcedIncludeOptions {
  includeRoots?: string[];
  analyzer?: DocumentAnalyzer;
  maxNumberOfProblems?: number;
  logger?: AnalysisLogger;
}

interface IndexedDocument {
  analysis: AnalyzedDocument;
  filePath?: string;
  version?: number;
  mtimeMs?: number;
}

export class WorkspaceIndex {
  private readonly analyzer: DocumentAnalyzer;
  private includeRoots: string[];
  private forcedIncludeRoots: string[];
  private forcedIncludeFiles: string[];
  private maxNumberOfProblems: number | undefined;
  private readonly logger: AnalysisLogger;
  private readonly documents = new Map<string, IndexedDocument>();
  private readonly includeGraph = new Map<string, Set<string>>();
  private readonly reverseIncludeGraph = new Map<string, Set<string>>();
  private forcedIncludeFileCache: string[] | undefined;
  private indexingForcedIncludes = false;
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
    this.maxNumberOfProblems = options.maxNumberOfProblems;
  }

  public configure(options: unknown): void {
    const merged = mergeWorkspaceIndexOptions({
      includeRoots: this.includeRoots,
      forcedIncludeRoots: this.forcedIncludeRoots,
      forcedIncludeFiles: this.forcedIncludeFiles
    }, options);

    this.includeRoots = normalizePaths(merged.includeRoots ?? []);
    this.forcedIncludeRoots = normalizePaths(merged.forcedIncludeRoots ?? []);
    this.forcedIncludeFiles = normalizePaths(merged.forcedIncludeFiles ?? []);
    this.maxNumberOfProblems = merged.maxNumberOfProblems;
    this.forcedIncludeFileCache = undefined;
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

      const analysis = this.analyzer.analyzeDocument(input);
      this.documents.set(input.uri, {
        analysis,
        version: input.version,
        filePath: filePathFromUri(input.uri)
      });
      this.enqueueKnownForcedIncludeFiles();
      this.replaceResolvedIncludeEdgesAndEnqueue(analysis);
      return analysis;
    });
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
    if (cached?.version === input.version) {
      return cached.analysis;
    }

    const initialAnalysis = this.analyzer.analyzeDocument(input);
    this.documents.set(input.uri, {
      analysis: initialAnalysis,
      version: input.version,
      filePath: filePathFromUri(input.uri)
    });
    this.indexResolvedIncludes(initialAnalysis, new Set([input.uri]));
    const analysis = this.withWorkspaceDiagnostics(this.reanalyzeWithVisibleContext(input, initialAnalysis));
    this.documents.set(input.uri, {
      ...(this.documents.get(input.uri) ?? {}),
      analysis
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
    } finally {
      this.indexingForcedIncludes = false;
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
    this.indexForcedIncludes();
    return this.collectVisibleUris(sourceUri)
      .flatMap((uri) => this.documents.get(uri)?.analysis.declarations ?? [])
      .filter((declaration) => declaration.name === name)
      .sort(compareDeclarations);
  }

  public listVisibleDeclarations(sourceUri: string): AnalysisDeclaration[] {
    this.indexForcedIncludes();
    const declarations = [
      ...(this.documents.get(sourceUri)?.analysis.declarations ?? []),
      ...this.collectVisibleUris(sourceUri)
        .flatMap((uri) => this.documents.get(uri)?.analysis.declarations ?? [])
    ];
    return Array.from(new Map(declarations.map((declaration) => [declaration.id, declaration])).values())
      .sort(compareDeclarations);
  }

  public listVisibleDocuments(sourceUri: string): AnalyzedDocument[] {
    this.indexForcedIncludes();
    return [sourceUri, ...this.collectVisibleUris(sourceUri)]
      .map((uri) => this.documents.get(uri)?.analysis)
      .filter((analysis): analysis is AnalyzedDocument => analysis !== undefined);
  }

  public listReferenceSearchDocuments(sourceUri: string): AnalyzedDocument[] {
    void sourceUri;
    this.indexForcedIncludes();
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
    return pathCompletions([...localRoot, ...this.includeRoots], prefix, /\.(?:axl)$/i);
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
    this.indexForcedIncludes();
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
    this.documents.delete(uri);
    this.replaceIncludeEdges(uri, new Set());
    this.analyzer.clear(uri);
  }

  public invalidateFile(filePath: string): void {
    const uri = pathToFileURL(path.normalize(filePath)).toString();
    this.invalidateUri(uri);
  }

  public invalidateUri(uri: string): void {
    const dependents = this.collectDependents(uri);
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

    if (cached?.mtimeMs === stat.mtimeMs) {
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
    const initialAnalysis = this.analyzer.analyzeDocument({ uri, version: 0, text });
    this.documents.set(uri, {
      analysis: initialAnalysis,
      filePath: normalizedPath,
      mtimeMs: stat.mtimeMs
    });
    this.indexResolvedIncludes(initialAnalysis, new Set([...visitedUris, uri]));
    const analysis = this.withWorkspaceDiagnostics(
      this.reanalyzeWithVisibleContext({ uri, version: 0, text }, initialAnalysis)
    );
    this.documents.set(uri, {
      analysis,
      filePath: normalizedPath,
      mtimeMs: stat.mtimeMs
    });
    return analysis;
  }

  private withWorkspaceDiagnostics(analysis: AnalyzedDocument): AnalyzedDocument {
    return {
      ...analysis,
      diagnostics: limitDiagnostics([
        ...analysis.diagnostics,
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
        message: `Include file not found: '${item.include.includePath}'.`,
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
        message: `AXEL execution file not found: '${item.execution.scriptPath}'.`,
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
    if (knownGuiClasses.length === 0 && preprocessorSymbols.length === 0) {
      return initialAnalysis;
    }

    const analysis = this.analyzer.analyzeDocument({
      ...input,
      knownGuiClasses,
      preprocessorSymbols
    });
    this.documents.set(input.uri, {
      ...(this.documents.get(input.uri) ?? {}),
      analysis
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
      if (!visitedUris.has(resolution.uri)) {
        this.indexDiskDocumentInternal(resolution.filePath, new Set([...visitedUris, resolution.uri]));
      }
    }

    this.replaceIncludeEdges(analysis.uri, resolvedUris);
  }

  private replaceResolvedIncludeEdgesAndEnqueue(analysis: AnalyzedDocument): void {
    const includingFilePath = filePathFromUri(analysis.uri);
    if (includingFilePath === undefined) {
      this.replaceIncludeEdges(analysis.uri, new Set());
      return;
    }

    const resolvedUris = new Set<string>();
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
      if (!this.documents.has(resolution.uri)) {
        this.enqueueBackgroundDocument(resolution.uri, resolution.filePath);
      }
    }

    this.replaceIncludeEdges(analysis.uri, resolvedUris);
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
      const initialAnalysis = this.analyzer.analyzeDocument({ uri, version: 0, text });
      this.documents.set(uri, {
        analysis: initialAnalysis,
        filePath: normalizedPath,
        mtimeMs: stat.mtimeMs
      });
      this.replaceResolvedIncludeEdgesAndEnqueue(initialAnalysis);
      const analysis = this.withWorkspaceDiagnostics(
        this.reanalyzeWithVisibleContext({ uri, version: 0, text }, initialAnalysis)
      );
      this.documents.set(uri, {
        analysis,
        filePath: normalizedPath,
        mtimeMs: stat.mtimeMs
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

  private replaceIncludeEdges(uri: string, includedUris: Set<string>): void {
    const oldEdges = this.includeGraph.get(uri) ?? new Set<string>();
    for (const includedUri of oldEdges) {
      const dependents = this.reverseIncludeGraph.get(includedUri);
      dependents?.delete(uri);
      if (dependents?.size === 0) {
        this.reverseIncludeGraph.delete(includedUri);
      }
    }

    this.includeGraph.set(uri, includedUris);
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
      if (uri === undefined || visibleUris.has(uri)) {
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
      ...this.collectCachedVisibleUris(sourceUri)
        .flatMap((uri) => this.documents.get(uri)?.analysis.declarations ?? [])
    ];
    return Array.from(new Map(declarations.map((declaration) => [declaration.id, declaration])).values())
      .sort(compareDeclarations);
  }

  private collectCachedVisibleUris(sourceUri: string): string[] {
    const visibleUris = new Set<string>();
    const pending = [
      ...(this.includeGraph.get(sourceUri) ?? []),
      ...this.knownForcedIncludeUris()
    ];

    while (pending.length > 0) {
      const uri = pending.pop();
      if (uri === undefined || visibleUris.has(uri)) {
        continue;
      }

      visibleUris.add(uri);
      pending.push(...(this.includeGraph.get(uri) ?? []));
    }

    return Array.from(visibleUris).sort();
  }

  private collectVisibleGuiClassEntries(sourceUri: string): GuiClassEntry[] {
    return [sourceUri, ...this.collectVisibleUris(sourceUri)]
      .flatMap((uri) => (this.documents.get(uri)?.analysis.guiClasses ?? [])
        .map((guiClass) => ({ uri, guiClass })));
  }

  private collectVisiblePreprocessorSymbols(sourceUri: string): AnalysisPreprocessorSymbol[] {
    return this.collectVisibleUris(sourceUri)
      .flatMap((uri) => (this.documents.get(uri)?.analysis.declarations ?? []))
      .filter((declaration) => declaration.kind === 'macro')
      .sort(compareDeclarations)
      .map((declaration) => ({
        name: declaration.name,
        value: macroValueFromDetail(declaration)
      }));
  }

  private getForcedIncludeFiles(): string[] {
    this.forcedIncludeFileCache ??= collectForcedIncludeFiles({
      forcedIncludeRoots: this.forcedIncludeRoots,
      forcedIncludeFiles: this.forcedIncludeFiles
    });
    return this.forcedIncludeFileCache;
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

function normalizePaths(paths: string[]): string[] {
  return paths.map((filePath) => path.normalize(filePath));
}

function includePathCompletions(roots: string[], prefix: string): string[] {
  return pathCompletions(roots, prefix, /\.(?:axl|h|hh)$/i);
}

function pathCompletions(roots: string[], prefix: string, filePattern: RegExp): string[] {
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

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.name.startsWith(basePrefix)) {
        continue;
      }

      const candidate = path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/');
      if (entry.isDirectory() || filePattern.test(entry.name)) {
        entries.push(entry.isDirectory() ? `${candidate}/` : candidate);
      }
    }
  }

  return Array.from(new Set(entries)).sort();
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
