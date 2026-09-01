"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceIndex = void 0;
const fs = require("fs");
const path = require("path");
const url_1 = require("url");
const documentAnalyzer_1 = require("./documentAnalyzer");
const forcedIncludes_1 = require("./forcedIncludes");
const includeResolver_1 = require("./includeResolver");
const semanticDiagnostics_1 = require("./semanticDiagnostics");
const workspaceConfig_1 = require("./workspaceConfig");
const logger_1 = require("../util/logger");
class WorkspaceIndex {
    analyzer;
    includeRoots;
    forcedIncludeRoots;
    forcedIncludeFiles;
    maxNumberOfProblems;
    logger;
    documents = new Map();
    includeGraph = new Map();
    reverseIncludeGraph = new Map();
    forcedIncludeFileCache;
    indexingForcedIncludes = false;
    pendingBackgroundDocuments = new Map();
    backgroundIndexingScheduled = false;
    backgroundWaiters = [];
    backgroundCompleteListeners = [];
    constructor(options = {}) {
        this.logger = options.logger ?? logger_1.NullLogger;
        this.analyzer = options.analyzer ?? new documentAnalyzer_1.DocumentAnalyzer(undefined, this.logger);
        this.includeRoots = normalizePaths(options.includeRoots ?? []);
        this.forcedIncludeRoots = normalizePaths(options.forcedIncludeRoots ?? []);
        this.forcedIncludeFiles = normalizePaths(options.forcedIncludeFiles ?? []);
        this.maxNumberOfProblems = options.maxNumberOfProblems;
    }
    configure(options) {
        const merged = (0, workspaceConfig_1.mergeWorkspaceIndexOptions)({
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
    analyzeDocument(input) {
        return this.indexOpenDocument(input);
    }
    analyzeForegroundDocument(input) {
        return (0, logger_1.measureDurationMs)(this.logger, 'workspace.foreground', { uri: input.uri, version: input.version }, () => {
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
    semanticTokenWorkspaceIndex(_sourceUri) {
        return {
            findVisibleDeclarations: (uri, name) => this.listCachedVisibleDeclarations(uri)
                .filter((declaration) => declaration.name === name),
            listVisibleDeclarations: (uri) => this.listCachedVisibleDeclarations(uri)
        };
    }
    waitForBackgroundIndexing() {
        if (!this.backgroundIndexingScheduled && this.pendingBackgroundDocuments.size === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.backgroundWaiters.push(resolve);
        });
    }
    onBackgroundIndexingComplete(listener) {
        this.backgroundCompleteListeners.push(listener);
    }
    indexOpenDocument(input) {
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
        const analysis = this.withWorkspaceDiagnostics(this.reanalyzeWithVisibleGuiClasses(input, initialAnalysis));
        this.documents.set(input.uri, {
            ...(this.documents.get(input.uri) ?? {}),
            analysis
        });
        return analysis;
    }
    indexDiskDocument(filePath) {
        return this.indexDiskDocumentInternal(path.normalize(filePath), new Set());
    }
    indexForcedIncludes() {
        if (this.indexingForcedIncludes) {
            return;
        }
        this.indexingForcedIncludes = true;
        try {
            for (const filePath of this.getForcedIncludeFiles()) {
                this.indexDiskDocumentInternal(filePath, new Set());
            }
        }
        finally {
            this.indexingForcedIncludes = false;
        }
    }
    findDeclarations(name) {
        const declarations = [];
        for (const document of this.documents.values()) {
            declarations.push(...document.analysis.declarations.filter((declaration) => declaration.name === name));
        }
        return declarations;
    }
    findVisibleDeclarations(sourceUri, name) {
        this.indexForcedIncludes();
        return this.collectVisibleUris(sourceUri)
            .flatMap((uri) => this.documents.get(uri)?.analysis.declarations ?? [])
            .filter((declaration) => declaration.name === name)
            .sort(compareDeclarations);
    }
    listVisibleDeclarations(sourceUri) {
        this.indexForcedIncludes();
        const declarations = [
            ...(this.documents.get(sourceUri)?.analysis.declarations ?? []),
            ...this.collectVisibleUris(sourceUri)
                .flatMap((uri) => this.documents.get(uri)?.analysis.declarations ?? [])
        ];
        return Array.from(new Map(declarations.map((declaration) => [declaration.id, declaration])).values())
            .sort(compareDeclarations);
    }
    listVisibleDocuments(sourceUri) {
        this.indexForcedIncludes();
        return [sourceUri, ...this.collectVisibleUris(sourceUri)]
            .map((uri) => this.documents.get(uri)?.analysis)
            .filter((analysis) => analysis !== undefined);
    }
    listReferenceSearchDocuments(sourceUri) {
        void sourceUri;
        this.indexForcedIncludes();
        return Array.from(this.documents.values())
            .map((document) => document.analysis);
    }
    findIncludePathCompletions(sourceUri, prefix, includeKind) {
        const includingFilePath = filePathFromUri(sourceUri);
        const localRoot = includingFilePath === undefined ? [] : [path.dirname(includingFilePath)];
        const roots = [
            ...(includeKind === 'quote' || this.includeRoots.length === 0 ? localRoot : []),
            ...this.includeRoots
        ];
        return includePathCompletions(roots, prefix);
    }
    findScriptExecutionPathCompletions(sourceUri, prefix) {
        const includingFilePath = filePathFromUri(sourceUri);
        const localRoot = includingFilePath === undefined ? [] : [path.dirname(includingFilePath)];
        return pathCompletions([...localRoot, ...this.includeRoots], prefix, /\.(?:axl)$/i);
    }
    resolveIncludeAtPosition(sourceUri, position) {
        const analysis = this.documents.get(sourceUri)?.analysis;
        const includingFilePath = filePathFromUri(sourceUri);
        if (analysis === undefined || includingFilePath === undefined) {
            return undefined;
        }
        const include = analysis.includes.find((candidate) => containsPosition(candidate.range, position));
        if (include === undefined) {
            return undefined;
        }
        const resolution = (0, includeResolver_1.resolveInclude)({
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
    resolveScriptExecutionAtPosition(sourceUri, position) {
        const analysis = this.documents.get(sourceUri)?.analysis;
        const includingFilePath = filePathFromUri(sourceUri);
        if (analysis === undefined || includingFilePath === undefined) {
            return undefined;
        }
        const execution = analysis.scriptExecutions.find((candidate) => containsPosition(candidate.range, position));
        if (execution === undefined) {
            return undefined;
        }
        const resolution = (0, includeResolver_1.resolveScriptExecution)({
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
    findGuiClass(sourceUri, name) {
        return this.findVisibleGuiClasses(sourceUri, name)[0];
    }
    findVisibleGuiClasses(sourceUri, name) {
        this.indexForcedIncludes();
        return this.collectVisibleGuiClassEntries(sourceUri)
            .filter((entry) => entry.guiClass.name === name)
            .sort(compareGuiClassEntries)
            .map((entry) => entry.guiClass);
    }
    isKnownGuiClass(sourceUri, name) {
        return this.findGuiClass(sourceUri, name) !== undefined;
    }
    getAnalyzedDocument(uri) {
        return this.documents.get(uri)?.analysis;
    }
    deleteDocument(uri) {
        this.documents.delete(uri);
        this.replaceIncludeEdges(uri, new Set());
        this.analyzer.clear(uri);
    }
    invalidateFile(filePath) {
        const uri = (0, url_1.pathToFileURL)(path.normalize(filePath)).toString();
        this.invalidateUri(uri);
    }
    invalidateUri(uri) {
        const dependents = this.collectDependents(uri);
        for (const dependentUri of dependents) {
            this.documents.delete(dependentUri);
            this.analyzer.clear(dependentUri);
        }
    }
    indexDiskDocumentInternal(filePath, visitedUris) {
        const normalizedPath = path.normalize(filePath);
        const uri = (0, url_1.pathToFileURL)(normalizedPath).toString();
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
        const analysis = this.withWorkspaceDiagnostics(this.reanalyzeWithVisibleGuiClasses({ uri, version: 0, text }, initialAnalysis));
        this.documents.set(uri, {
            analysis,
            filePath: normalizedPath,
            mtimeMs: stat.mtimeMs
        });
        return analysis;
    }
    withWorkspaceDiagnostics(analysis) {
        return {
            ...analysis,
            diagnostics: limitDiagnostics([
                ...analysis.diagnostics,
                ...this.unresolvedIncludeDiagnostics(analysis),
                ...this.unresolvedScriptExecutionDiagnostics(analysis),
                ...(0, semanticDiagnostics_1.collectSemanticDiagnostics)({
                    analysis,
                    workspaceIndex: this
                })
            ], this.maxNumberOfProblems)
        };
    }
    unresolvedIncludeDiagnostics(analysis) {
        const includingFilePath = filePathFromUri(analysis.uri);
        if (includingFilePath === undefined) {
            return [];
        }
        return analysis.includes
            .map((include) => ({
            include,
            resolution: (0, includeResolver_1.resolveInclude)({
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
    unresolvedScriptExecutionDiagnostics(analysis) {
        const includingFilePath = filePathFromUri(analysis.uri);
        if (includingFilePath === undefined) {
            return [];
        }
        return analysis.scriptExecutions
            .map((execution) => ({
            execution,
            resolution: (0, includeResolver_1.resolveScriptExecution)({
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
    reanalyzeWithVisibleGuiClasses(input, initialAnalysis) {
        if (!this.indexingForcedIncludes) {
            this.indexForcedIncludes();
        }
        const knownGuiClasses = this.collectVisibleGuiClassEntries(input.uri)
            .sort(compareGuiClassEntries)
            .map((entry) => ({
            name: entry.guiClass.name,
            kind: entry.guiClass.kind
        }));
        if (knownGuiClasses.length === 0) {
            return initialAnalysis;
        }
        const analysis = this.analyzer.analyzeDocument({
            ...input,
            knownGuiClasses
        });
        this.documents.set(input.uri, {
            ...(this.documents.get(input.uri) ?? {}),
            analysis
        });
        this.indexResolvedIncludes(analysis, new Set([input.uri]));
        return analysis;
    }
    indexResolvedIncludes(analysis, visitedUris) {
        const includingFilePath = filePathFromUri(analysis.uri);
        if (includingFilePath === undefined) {
            return;
        }
        const resolvedUris = new Set();
        for (const include of analysis.includes) {
            const resolution = (0, includeResolver_1.resolveInclude)({
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
    replaceResolvedIncludeEdgesAndEnqueue(analysis) {
        const includingFilePath = filePathFromUri(analysis.uri);
        if (includingFilePath === undefined) {
            this.replaceIncludeEdges(analysis.uri, new Set());
            return;
        }
        const resolvedUris = new Set();
        for (const include of analysis.includes) {
            const resolution = (0, includeResolver_1.resolveInclude)({
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
    enqueueBackgroundDocument(uri, filePath) {
        if (this.pendingBackgroundDocuments.has(uri)) {
            return;
        }
        this.pendingBackgroundDocuments.set(uri, filePath);
        this.scheduleBackgroundIndexing();
    }
    scheduleBackgroundIndexing() {
        if (this.backgroundIndexingScheduled) {
            return;
        }
        this.backgroundIndexingScheduled = true;
        setImmediate(() => this.processNextBackgroundDocument());
    }
    processNextBackgroundDocument() {
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
        }
        catch (error) {
            this.logger.error(`Background indexing failed for ${filePath}: ${getErrorMessage(error)}`);
        }
        this.backgroundIndexingScheduled = false;
        if (this.pendingBackgroundDocuments.size === 0) {
            this.resolveBackgroundWaiters();
            return;
        }
        this.scheduleBackgroundIndexing();
    }
    indexSingleBackgroundDiskDocument(uri, filePath) {
        (0, logger_1.measureDurationMs)(this.logger, 'workspace.background', { uri }, () => {
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
            const analysis = this.withWorkspaceDiagnostics(this.reanalyzeWithVisibleGuiClasses({ uri, version: 0, text }, initialAnalysis));
            this.documents.set(uri, {
                analysis,
                filePath: normalizedPath,
                mtimeMs: stat.mtimeMs
            });
        });
    }
    resolveBackgroundWaiters() {
        const waiters = this.backgroundWaiters.splice(0);
        for (const waiter of waiters) {
            waiter();
        }
        for (const listener of this.backgroundCompleteListeners) {
            listener();
        }
    }
    replaceIncludeEdges(uri, includedUris) {
        const oldEdges = this.includeGraph.get(uri) ?? new Set();
        for (const includedUri of oldEdges) {
            const dependents = this.reverseIncludeGraph.get(includedUri);
            dependents?.delete(uri);
            if (dependents?.size === 0) {
                this.reverseIncludeGraph.delete(includedUri);
            }
        }
        this.includeGraph.set(uri, includedUris);
        for (const includedUri of includedUris) {
            const dependents = this.reverseIncludeGraph.get(includedUri) ?? new Set();
            dependents.add(uri);
            this.reverseIncludeGraph.set(includedUri, dependents);
        }
    }
    collectDependents(uri) {
        const dependents = new Set([uri]);
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
    collectVisibleUris(sourceUri) {
        const visibleUris = new Set();
        const pending = [...(this.includeGraph.get(sourceUri) ?? [])];
        for (const filePath of this.getForcedIncludeFiles()) {
            pending.push((0, url_1.pathToFileURL)(filePath).toString());
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
    listCachedVisibleDeclarations(sourceUri) {
        const declarations = [
            ...(this.documents.get(sourceUri)?.analysis.declarations ?? []),
            ...this.collectCachedVisibleUris(sourceUri)
                .flatMap((uri) => this.documents.get(uri)?.analysis.declarations ?? [])
        ];
        return Array.from(new Map(declarations.map((declaration) => [declaration.id, declaration])).values())
            .sort(compareDeclarations);
    }
    collectCachedVisibleUris(sourceUri) {
        const visibleUris = new Set();
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
    collectVisibleGuiClassEntries(sourceUri) {
        return [sourceUri, ...this.collectVisibleUris(sourceUri)]
            .flatMap((uri) => (this.documents.get(uri)?.analysis.guiClasses ?? [])
            .map((guiClass) => ({ uri, guiClass })));
    }
    getForcedIncludeFiles() {
        this.forcedIncludeFileCache ??= (0, forcedIncludes_1.collectForcedIncludeFiles)({
            forcedIncludeRoots: this.forcedIncludeRoots,
            forcedIncludeFiles: this.forcedIncludeFiles
        });
        return this.forcedIncludeFileCache;
    }
    enqueueKnownForcedIncludeFiles() {
        for (const filePath of this.knownForcedIncludeFiles()) {
            const uri = (0, url_1.pathToFileURL)(filePath).toString();
            if (!this.documents.has(uri)) {
                this.enqueueBackgroundDocument(uri, filePath);
            }
        }
    }
    knownForcedIncludeUris() {
        return this.knownForcedIncludeFiles()
            .map((filePath) => (0, url_1.pathToFileURL)(filePath).toString());
    }
    knownForcedIncludeFiles() {
        return Array.from(new Set([
            ...this.forcedIncludeFiles,
            ...(this.forcedIncludeFileCache ?? [])
        ])).sort();
    }
}
exports.WorkspaceIndex = WorkspaceIndex;
function compareDeclarations(left, right) {
    return left.uri.localeCompare(right.uri)
        || left.selectionRange.start.line - right.selectionRange.start.line
        || left.selectionRange.start.character - right.selectionRange.start.character
        || left.selectionRange.end.line - right.selectionRange.end.line
        || left.selectionRange.end.character - right.selectionRange.end.character;
}
function compareGuiClassEntries(left, right) {
    return left.uri.localeCompare(right.uri)
        || compareRanges(left.guiClass.range, right.guiClass.range);
}
function compareRanges(left, right) {
    return left.start.line - right.start.line
        || left.start.character - right.start.character
        || left.end.line - right.end.line
        || left.end.character - right.end.character;
}
function normalizePaths(paths) {
    return paths.map((filePath) => path.normalize(filePath));
}
function includePathCompletions(roots, prefix) {
    return pathCompletions(roots, prefix, /\.(?:axl|h|hh)$/i);
}
function pathCompletions(roots, prefix, filePattern) {
    const entries = [];
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
function filePathFromUri(uri) {
    try {
        return path.normalize((0, url_1.fileURLToPath)(uri));
    }
    catch {
        return undefined;
    }
}
function includeTextForResolution(includePath, kind) {
    if (kind === 'quote') {
        return `"${includePath}"`;
    }
    if (kind === 'angle') {
        return `<${includePath}>`;
    }
    return includePath;
}
function limitDiagnostics(diagnostics, maxNumberOfProblems) {
    if (maxNumberOfProblems === undefined) {
        return diagnostics;
    }
    return diagnostics.slice(0, maxNumberOfProblems);
}
function containsPosition(range, position) {
    return positionBeforeOrEqual(range.start, position) && positionBefore(position, range.end);
}
function positionBeforeOrEqual(left, right) {
    return left.line < right.line || (left.line === right.line && left.character <= right.character);
}
function positionBefore(left, right) {
    return left.line < right.line || (left.line === right.line && left.character < right.character);
}
function getErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
//# sourceMappingURL=workspaceIndex.js.map