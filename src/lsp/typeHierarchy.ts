import { ErrorCodes, LSPErrorCodes, ResponseError, SymbolKind, type CancellationToken, type TypeHierarchyItem,
  type TypeHierarchyPrepareParams, type TypeHierarchySupertypesParams, type TypeHierarchySubtypesParams } from 'vscode-languageserver/node';
import { TypeHierarchyIndex } from '../analyzer/typeHierarchy/index';
import type { AnalysisTypeHierarchyItem } from '../analyzer/typeHierarchy/model';
import type { HandlerRegistrationContext } from './registerHandlers';
import { rethrowCancellation, throwIfCancelled } from '../util/cancellation';

export function createTypeHierarchyIndex(context: HandlerRegistrationContext): TypeHierarchyIndex {
  const index = new TypeHierarchyIndex(context.projectScope!, () => (context.documents.all?.() ?? []).map(document => ({
    uri: document.uri, version: document.version, text: document.getText()
  })), message => context.logger.error(message));
  context.documents.onDidChangeContent(event => index.invalidate([event.document.uri]));
  context.documents.onDidClose(event => index.invalidate([event.document.uri]));
  return index;
}

interface Lifecycle {
  request<P, T>(work: (params: P, token: CancellationToken) => Promise<T>): (params: P, token?: CancellationToken) => Promise<T>;
}
export function registerTypeHierarchyHandlers(context: HandlerRegistrationContext, index: TypeHierarchyIndex, lifecycle: Lifecycle): void {
  const hierarchy = context.connection.languages.typeHierarchy;
  if (!hierarchy) { return; }
  const run = async (work: () => Promise<AnalysisTypeHierarchyItem[] | null>, token: CancellationToken) => {
    try { return (await work())?.map(toLspTypeHierarchyItem) ?? null; }
    catch (error) {
      rethrowCancellation(error); throwIfCancelled(token);
      if (error instanceof ResponseError) { throw error; }
      context.logger.error(`Type hierarchy failed: ${String(error)}`);
      throw new ResponseError(LSPErrorCodes.RequestFailed, 'Type hierarchy indexing failed; see server log.');
    }
  };
  hierarchy.onPrepare(lifecycle.request(async (params: TypeHierarchyPrepareParams, token) => {
    if (!params?.textDocument || typeof params.textDocument.uri !== 'string' || !validPosition(params.position)) {
      throw new ResponseError(ErrorCodes.InvalidParams, 'Expected document URI and UTF-16 position.');
    }
    return run(() => index.prepare(params.textDocument.uri, params.position, token), token);
  }));
  hierarchy.onSupertypes(lifecycle.request(async (params: TypeHierarchySupertypesParams, token) => {
    validateItem(params); return run(() => index.supertypes(params.item.data, token), token);
  }));
  hierarchy.onSubtypes(async (params: TypeHierarchySubtypesParams, token, progress) => {
    return lifecycle.request(async (request: TypeHierarchySubtypesParams, cancellation) => {
      validateItem(request);
      progress.begin('Indexing AXEL type hierarchy', 0, undefined, true);
      try {
        return await run(() => index.subtypes(request.item.data, cancellation, (completed, total) => {
          progress.report(total ? Math.floor(completed / total * 100) : 100);
        }), cancellation);
      } finally { progress.done(); }
    })(params, token);
  });
}
function validPosition(position: unknown): boolean {
  if (!position || typeof position !== 'object') { return false; }
  const p = position as { line?: number; character?: number };
  return Number.isInteger(p.line) && Number.isInteger(p.character) && p.line! >= 0 && p.character! >= 0;
}
function validateItem(params: unknown): void {
  const item = (params as { item?: TypeHierarchyItem } | null)?.item;
  if (!item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.uri !== 'string'
    || !Number.isInteger(item.kind) || !validPosition(item.range?.start) || !validPosition(item.range?.end)
    || !validPosition(item.selectionRange?.start) || !validPosition(item.selectionRange?.end)) {
    throw new ResponseError(ErrorCodes.InvalidParams, 'Expected a TypeHierarchyItem.');
  }
}
export function toLspTypeHierarchyItem(item: AnalysisTypeHierarchyItem): TypeHierarchyItem {
  return { name: item.name, kind: item.kind === 'struct' ? SymbolKind.Struct : SymbolKind.Class,
    detail: item.detail, uri: item.uri, range: item.range, selectionRange: item.selectionRange, data: item.data };
}
