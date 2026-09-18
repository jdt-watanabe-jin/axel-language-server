import { DocumentHighlightKind, type DocumentHighlight, type DocumentHighlightParams } from 'vscode-languageserver/node';
import { getDocumentHighlightsSteps, type AnalysisDocumentHighlight } from '../analyzer/documentHighlights';
import { rethrowCancellation, throwIfCancelled } from '../util/cancellation';
import type { CallHierarchyRequestLifecycle } from './callHierarchy';
import type { HandlerRegistrationContext } from './registerHandlers';

export function registerDocumentHighlightHandler(
  context: HandlerRegistrationContext,
  lifecycle: CallHierarchyRequestLifecycle
): void {
  context.connection.onDocumentHighlight?.(lifecycle.request(async (params: DocumentHighlightParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    return lifecycle.measureRequest(token, 'lsp.documentHighlight', {
      uri: params.textDocument.uri, version: document?.version,
      documentMissing: document === undefined ? true : undefined,
      line: params.position.line, character: params.position.character
    }, async () => {
      if (document === undefined) { return []; }
      try {
        const analysis = await lifecycle.analyzeRequest(token, {
          uri: document.uri, version: document.version, text: document.getText()
        });
        const highlights = await lifecycle.runRequestSteps(getDocumentHighlightsSteps({
          analysis, position: params.position, workspaceIndex: context.analyzer
        }), token);
        return highlights.map(toLspDocumentHighlight);
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Document highlight failed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
  }));
}

export function toLspDocumentHighlight(highlight: AnalysisDocumentHighlight): DocumentHighlight {
  const kinds = { text: DocumentHighlightKind.Text, read: DocumentHighlightKind.Read, write: DocumentHighlightKind.Write };
  return { range: highlight.range, kind: kinds[highlight.kind] };
}
