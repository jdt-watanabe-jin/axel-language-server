import { CancellationToken, LSPErrorCodes, ResponseError, type DocumentOnTypeFormattingParams } from 'vscode-languageserver/node';
import { getOnTypeFormattingEditsSteps } from '../analyzer/formatting';
import { runAnalysisStepsAsync } from '../util/analysisSteps';
import { cancellationCheckpoint, createRequestHandler, rethrowCancellation, throwIfCancelled } from '../util/cancellation';
import { toLspTextEdits } from './formatting';
import type { HandlerRegistrationContext } from './registerHandlers';

/** Input indentation is source-only and never queues behind dependency analysis. */
export function registerOnTypeFormattingHandler(context: HandlerRegistrationContext): void {
  const queue = createRequestHandler();
  const handle = queue(async (entry: { params: DocumentOnTypeFormattingParams; version: number | undefined }, token) => {
    const { params, version } = entry;
    const document = context.documents.get(params.textDocument.uri);
    if (!document || version === undefined) { return []; }
    const validate = () => {
      throwIfCancelled(token);
      if (context.documents.get(document.uri)?.version !== version) {
        throw new ResponseError(LSPErrorCodes.ContentModified, 'Document changed during input formatting.');
      }
    };
    validate();
    const started = Date.now();
    try {
      const edits = await runAnalysisStepsAsync(getOnTypeFormattingEditsSteps({
        text: document.getText(), position: params.position, ch: params.ch,
        options: { insertSpaces: Boolean(params.options.insertSpaces), tabSize: params.options.tabSize }
      }), token, validate);
      await cancellationCheckpoint(token);
      validate();
      context.logger.info?.(`[timing] operation=lsp.onTypeFormatting uri=${document.uri} version=${version} durationMs=${Date.now() - started}`);
      return toLspTextEdits(edits);
    } catch (error: unknown) {
      rethrowCancellation(error);
      throwIfCancelled(token);
      context.logger.error(`On type formatting failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
  context.connection.onDocumentOnTypeFormatting?.((params, token = CancellationToken.None) =>
    handle({ params, version: context.documents.get(params.textDocument.uri)?.version }, token));
}
