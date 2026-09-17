import { runAnalysisSteps, type AnalysisStep } from '../util/analysisSteps';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { AnalysisDeclaration, AnalyzedDocument } from '../types/analysis';
import { containsSourcePosition } from './systemMacros';
import { resolveInclude } from './includeResolver';
import { WorkspaceIndex, type WorkspaceIndexOptions } from './workspaceIndex';
import { buildTypeContext } from './typeChecking/declarations';
import { loadBuiltinCatalog } from './typeChecking/builtinCatalog';
import type { TypeContext } from './typeChecking/model';

export interface LoginScopeSnapshot {
  entryUri: string;
  declarations: AnalysisDeclaration[];
  documents: AnalyzedDocument[];
  dependencyUris: string[];
  uncertainNames?: string[];
  typeContext?: TypeContext;
}

/** Startup and subsequent-file macro environments must use separate indexes. */
export function buildLoginScope(entryPath: string, options: WorkspaceIndexOptions): LoginScopeSnapshot {
  return runAnalysisSteps(buildLoginScopeSteps(entryPath, options));
}

export function* buildLoginScopeSteps(entryPath: string, options: WorkspaceIndexOptions, forcedIncludesSource?: WorkspaceIndex): Generator<AnalysisStep, LoginScopeSnapshot, void> {
  const index = new WorkspaceIndex({ ...options, sxmHome: '', inheritIncludeContext: true, dependencyAnalysisOnly: true }, forcedIncludesSource);
  const entryUri = pathToFileURL(entryPath).toString();
  const snapshot: LoginScopeSnapshot = { entryUri, declarations: [], documents: [], dependencyUris: [entryUri] };
  try {
    yield* index.indexDiskDocumentSteps(entryPath);
  } catch (error: unknown) {
    options.logger?.info(`[login] Unable to read ${entryPath}: ${error instanceof Error ? error.message : String(error)}`);
    return snapshot;
  }
  const visited = new Set<string>();
  const dependencies = new Set([entryUri]);
  const declarations = new Map<string, AnalysisDeclaration>();
  const documents = new Map<string, AnalyzedDocument>();
  const uncertainNames = new Set<string>();
  function visit(uri: string, global: boolean, definite: boolean): void {
    const key = `${uri}:${global}:${definite}`;
    if (visited.has(key)) { return; }
    visited.add(key);
    const analysis = index.getAnalyzedDocument(uri);
    if (!analysis) { return; }
    documents.set(uri, analysis);
    if (global) {
      const globalIds = new Set(analysis.scopes.filter(scope => !scope.parentId).flatMap(scope => scope.declarationIds));
      const possible = [...analysis.uncertainDeclarations ?? [], ...(!definite ? analysis.declarations : [])];
      for (const declaration of possible) {
        if (globalIds.has(declaration.id) && (declaration.kind === 'class' || declaration.kind === 'variable'
          || declaration.kind === 'function' && declaration.name !== 'main')) { uncertainNames.add(declaration.name); }
      }
    }
    if (global && definite) {
      const globalIds = new Set(analysis.scopes.filter(s => !s.parentId).flatMap(s => s.declarationIds));
      const roots = analysis.declarations.filter(d => globalIds.has(d.id) &&
        (d.kind === 'class' || d.kind === 'variable' || d.kind === 'function' && d.name !== 'main'));
      for (const declaration of roots) { declarations.set(declaration.id, declaration); }
      for (const declaration of analysis.declarations) {
        if (declaration.containerName && roots.some(root => root.kind === 'class' && root.name === declaration.containerName)) {
          declarations.set(declaration.id, declaration);
        }
      }
    }
    for (const include of analysis.includes) {
      const resolution = resolveInclude({ includingFilePath: fileURLToPath(uri),
        includeText: include.kind === 'angle' ? `<${include.includePath}>` : include.kind === 'quote' ? `"${include.includePath}"` : include.includePath,
        includeRoots: options.includeRoots ?? [] });
      const candidates = resolution.status === 'resolved' ? [resolution.filePath] : resolution.candidates;
      for (const candidate of candidates) { dependencies.add(pathToFileURL(path.normalize(candidate)).toString()); }
      if (resolution.status !== 'resolved') { continue; }
      const nested = analysis.scopes.some(scope => scope.parentId && containsSourcePosition(scope.range, include.range.start));
      const uncertain = analysis.uncertainRanges?.some(range => containsSourcePosition(range, include.range.start));
      visit(resolution.uri, global && !nested, definite && !uncertain);
    }
  }
  visit(entryUri, true, true);
  for (const document of index.listVisibleDocuments(entryUri)) {
    dependencies.add(document.uri);
    if (!documents.has(document.uri)) { documents.set(document.uri, document); }
  }
  const entry = documents.get(entryUri);
  const typeContext = entry ? buildTypeContext({ analysis: entry, documents: [...documents.values()].reverse().filter(document => document.uri !== entryUri),
    catalog: loadBuiltinCatalog(options.forcedIncludeFiles ?? []) }) : undefined;
  const exported = [...declarations.values()].map(declaration => {
    const binding = typeContext?.bindings.find(binding => binding.uri === declaration.uri && binding.name === declaration.name
      && containsSourcePosition(binding.node.range, declaration.selectionRange.start));
    const type = binding?.type.kind === 'function' ? binding.type.call?.result : binding?.type;
    return type && type.kind !== 'unknown' ? { ...declaration, startup: true, typeName: type.name } : { ...declaration, startup: true };
  });
  return { ...snapshot, declarations: exported, documents: [...documents.values()], dependencyUris: [...dependencies].sort(),
    uncertainNames: [...uncertainNames], typeContext };
}
