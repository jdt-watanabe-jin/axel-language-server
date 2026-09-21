import { createHash } from 'crypto';
import { LSPErrorCodes, ResponseError, SymbolKind, type InitializeParams, type WorkspaceSymbol } from 'vscode-languageserver/node';
import type { HandlerRegistrationContext } from './registerHandlers';
import { fileIdentity, filePath } from '../analyzer/projectScope';
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

function symbolFileIdentity(uri: string): string | undefined {
  const file = filePath(uri);
  return file ? fileIdentity(file) : undefined;
}

// Identity deliberately excludes coordinates so inserting lines before a declaration
// can resolve to its current range. Duplicate identities are never guessed.
function symbolIdentity(entry: WorkspaceSymbolEntry): string {
  return createHash('sha256').update(JSON.stringify([symbolFileIdentity(entry.uri), entry.qualifiedName, entry.kind]))
    .digest('base64url').slice(0, 22);
}

/** Lifecycle hooks are composed with the existing registrations, never overwritten. */
export function registerWorkspaceSymbolHandler(context: HandlerRegistrationContext, foldersChanged: (roots: string[]) => void = () => {}) {
  if (!context.connection.onWorkspaceSymbol) { return undefined; }
  const index = new WorkspaceSymbolIndex(error => context.logger.error(error), context.projectScope);
  let roots: string[] = [];
  let foldersSupported = false;
  let progressSupported = false;
  let resolveSupported = false;
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
      if (!resolveSupported) { return entries.map(entry => toLspWorkspaceSymbol(entry, supportedKinds)); }
      const identities = entries.map(symbolIdentity);
      const counts = new Map<string, number>();
      for (const identity of identities) { counts.set(identity, (counts.get(identity) ?? 0) + 1); }
      return entries.map((entry, i) => {
        const symbol = toLspWorkspaceSymbol(entry, supportedKinds);
        // Overloads and duplicate declarations still navigate eagerly; their
        // shared identity cannot safely select one after edits.
        return counts.get(identities[i]) === 1 ? { ...symbol, location: { uri: entry.uri }, data: identities[i] } : symbol;
      });
    } finally { if (reporting) { progress.done(); } }
  });
  context.connection.onWorkspaceSymbolResolve?.(async (symbol, token) => {
    throwIfCancelled(token);
    await context.configuration!.ready(token);
    const stale = () => new ResponseError(LSPErrorCodes.ContentModified, 'Workspace symbol is no longer uniquely available.');
    if (!resolveSupported || typeof symbol.data !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(symbol.data)
      || typeof symbol.name !== 'string' || typeof symbol.location?.uri !== 'string') { throw stale(); }
    // The index reconciles roots, settings, disk and buffers, reusing unchanged
    // extraction results. Resolving a selection never triggers a separate parse.
    const uriIdentity = symbolFileIdentity(symbol.location.uri);
    if (!uriIdentity) { throw stale(); }
    const entries = await index.search(symbol.name, token);
    const matches = entries.filter(entry => symbolFileIdentity(entry.uri) === uriIdentity && symbolIdentity(entry) === symbol.data);
    if (matches.length !== 1) { throw stale(); }
    const current = toLspWorkspaceSymbol(matches[0], supportedKinds);
    if (current.name !== symbol.name || current.kind !== symbol.kind || current.containerName !== symbol.containerName) { throw stale(); }
    return { ...symbol, location: current.location };
  });
  return {
    initialize(params: InitializeParams) {
      roots = params.workspaceFolders != null ? params.workspaceFolders.map(folder => folder.uri) : params.rootUri ? [params.rootUri] : [];
      foldersSupported = params.capabilities.workspace?.workspaceFolders === true;
      progressSupported = params.capabilities.window?.workDoneProgress === true;
      supportedKinds = params.capabilities.workspace?.symbol?.symbolKind?.valueSet;
      resolveSupported = params.capabilities.workspace?.symbol?.resolveSupport?.properties.includes('location.range') === true
        && typeof context.connection.onWorkspaceSymbolResolve === 'function';
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
