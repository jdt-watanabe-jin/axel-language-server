import { SymbolKind, type InitializeParams, type WorkspaceSymbol } from 'vscode-languageserver/node';
import type { HandlerRegistrationContext } from './registerHandlers';
import { WorkspaceSymbolIndex } from '../analyzer/workspaceSymbols/index';
import { normalizeWorkspaceSymbolSettings } from '../analyzer/workspaceSymbols/config';
import type { WorkspaceSymbolEntry } from '../analyzer/workspaceSymbols/model';
import { toLspSymbolKind } from './documentSymbols';
import { throwIfCancelled } from '../util/cancellation';

export function toLspWorkspaceSymbol(entry: WorkspaceSymbolEntry, supportedKinds?: readonly SymbolKind[]): WorkspaceSymbol {
  let kind = toLspSymbolKind(entry.kind);
  const supported = supportedKinds ?? Array.from({ length: 18 }, (_, i) => (i + 1) as SymbolKind);
  if (!supported.includes(kind)) {
    const alternative = ['constructor', 'operator', 'method', 'function'].includes(entry.kind) ? SymbolKind.Function : SymbolKind.Variable;
    kind = supported.includes(alternative) ? alternative : supported[0] ?? SymbolKind.Variable;
  }
  return { name: entry.name, containerName: entry.containerName, kind, location: { uri: entry.uri, range: entry.selectionRange } };
}

/** Lifecycle hooks are composed with the existing registrations, never overwritten. */
export function registerWorkspaceSymbolHandler(context: HandlerRegistrationContext, foldersChanged: (roots: string[]) => void = () => {}) {
  if (!context.connection.onWorkspaceSymbol) { return undefined; }
  const index = new WorkspaceSymbolIndex(error => context.logger.error(error), context.projectScope);
  let roots: string[] = [];
  let foldersSupported = false;
  let progressSupported = false;
  let supportedKinds: SymbolKind[] | undefined;
  context.documents.onDidChangeContent(event => index.updateDocument({ uri: event.document.uri,
    version: event.document.version, text: event.document.getText() }));
  context.documents.onDidClose(event => index.closeDocument(event.document.uri));
  context.connection.onWorkspaceSymbol(async (params, token, progress) => {
    throwIfCancelled(token);
    await context.configuration!.ready(token);
    // vscode-languageserver consumes workDoneToken before invoking this handler.
    // The supplied reporter is a no-op when the request did not carry a token.
    const reporting = progressSupported;
    if (reporting) { progress.begin('Indexing AXEL workspace symbols', 0, undefined, true); }
    let previousPercent = -1;
    try {
      const entries = await index.search(params.query, token, reporting ? (completed, total) => {
        const percent = total ? Math.floor(completed / total * 100) : 100;
        if (percent !== previousPercent) { previousPercent = percent; progress.report(percent); }
      } : undefined);
      return entries.map(entry => toLspWorkspaceSymbol(entry, supportedKinds));
    } finally { if (reporting) { progress.done(); } }
  });
  return {
    initialize(params: InitializeParams) {
      roots = params.workspaceFolders != null ? params.workspaceFolders.map(folder => folder.uri) : params.rootUri ? [params.rootUri] : [];
      foldersSupported = params.capabilities.workspace?.workspaceFolders === true;
      progressSupported = params.capabilities.window?.workDoneProgress === true;
      supportedKinds = params.capabilities.workspace?.symbol?.symbolKind?.valueSet;
      index.setRoots(roots);
    },
    start() {
      if (foldersSupported) {
        context.connection.workspace.onDidChangeWorkspaceFolders(event => {
          const removed = new Set(event.removed.map(folder => folder.uri));
          roots = [...new Set([...roots.filter(uri => !removed.has(uri)), ...event.added.map(folder => folder.uri)])];
          index.setRoots(roots);
          foldersChanged(roots);
        });
      }
    },
    pause() { index.pause(); },
    resume() { index.resume(); },
    configure(settings: unknown) { index.configure(normalizeWorkspaceSymbolSettings(settings)); },
    invalidate(uris: readonly string[]) { index.invalidateFiles(uris); },
    dispose() { return index.dispose(); }
  };
}
