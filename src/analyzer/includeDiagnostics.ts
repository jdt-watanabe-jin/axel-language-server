import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import type { AnalysisDiagnostic, AnalysisRange, AnalyzedDocument } from '../types/analysis';
import { message } from '../i18n/messages';
import { resolveInclude } from './includeResolver';

export interface IncludeResolutionStatus {
  resolved: boolean;
  diagnostics: AnalysisDiagnostic[];
  dependencyUris: Set<string>;
}

// An include still awaiting background parsing is not yet known to resolve
// transitively. Reuse analyzed documents without parsing on the request path.
export function collectIncludeResolutionStatus(
  analysis: AnalyzedDocument,
  includeRoots: string[],
  forcedIncludeFiles: string[],
  getDocument: (uri: string) => AnalyzedDocument | undefined
): IncludeResolutionStatus {
  const result: IncludeResolutionStatus = { resolved: true, diagnostics: [], dependencyUris: new Set() };
  const visited = new Set<string>();
  const start: AnalysisRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  const fail = (includePath: string, range: AnalysisRange, unsupported = false): void => {
    result.resolved = false;
    result.diagnostics.push({ severity: 'error', source: 'axel', range,
      ...message(unsupported ? "Include could not be resolved: '{0}'." : "Include file not found: '{0}'.", includePath) });
  };
  const visit = (document: AnalyzedDocument, anchor?: AnalysisRange): void => {
    if (visited.has(document.uri)) { return; }
    visited.add(document.uri);
    let includingFilePath: string;
    try { includingFilePath = fileURLToPath(document.uri); }
    catch { if (document.includes.length > 0) { result.resolved = false; } return; }
    for (const include of document.includes) {
      const range = anchor ?? include.range;
      const includeText = include.kind === 'quote' ? '"' + include.includePath + '"'
        : include.kind === 'angle' ? '<' + include.includePath + '>' : include.includePath;
      const resolution = resolveInclude({ includingFilePath, includeText, includeRoots });
      if (resolution.status === 'unresolved') {
        for (const file of resolution.candidates) { result.dependencyUris.add(pathToFileURL(file).toString()); }
        fail(include.includePath, range, resolution.reason === 'unsupported');
      } else {
        result.dependencyUris.add(resolution.uri);
        const included = getDocument(resolution.uri);
        if (included) { visit(included, range); }
        else { result.resolved = false; }
      }
    }
  };
  visit(analysis);
  for (const file of forcedIncludeFiles) {
    const uri = pathToFileURL(file).toString();
    result.dependencyUris.add(uri);
    let exists = false;
    try { exists = fs.statSync(file).isFile(); } catch { /* Report the missing forced include below. */ }
    if (!exists) { fail(file, start); continue; }
    const document = getDocument(uri);
    if (document) { visit(document, start); }
    else { result.resolved = false; }
  }
  return result;
}
