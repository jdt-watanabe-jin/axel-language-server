import { CancellationToken, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import type { FoldingRange, FoldingRangeClientCapabilities, FoldingRangeParams } from 'vscode-languageserver/node';
import type { FoldingRangeCandidate } from '../analyzer/foldingRanges';
import { runAnalysisStepsAsync } from '../util/analysisSteps';
import { cancellationCheckpoint, createRequestHandler, rethrowCancellation, throwIfCancelled } from '../util/cancellation';
import type { HandlerRegistrationContext } from './registerHandlers';

/** Apply client preferences after syntax collection and normalization. */
export function toLspFoldingRanges(
  ranges: readonly FoldingRangeCandidate[], capabilities?: FoldingRangeClientCapabilities
): FoldingRange[] {
  const kinds = capabilities?.foldingRangeKind?.valueSet;
  const selected = capabilities?.rangeLimit === undefined ? ranges : ranges.slice(0, capabilities.rangeLimit);
  return selected.map(range => ({
    startLine: range.startLine,
    endLine: range.endLine,
    ...(range.kind && (!kinds || kinds.includes(range.kind)) ? { kind: range.kind } : {})
  }));
}

/** Syntax requests must not wait for a semantic request or pending dependency indexing. */
export function registerFoldingRangeHandler(context: HandlerRegistrationContext, revision: () => number,
  capabilities: () => FoldingRangeClientCapabilities | undefined): void {
  const queue = createRequestHandler();
  const handle = queue(async (entry: { params: FoldingRangeParams; revision: number }, token) => {
    const validate = () => {
      throwIfCancelled(token);
      if (revision() !== entry.revision) {
        throw new ResponseError(LSPErrorCodes.ContentModified, 'Document changed during folding request.');
      }
    };
    validate();
    const document = context.documents.get(entry.params.textDocument.uri);
    if (!document || !context.analyzer.getFoldingRangesSteps) { return []; }
    const startedAt = Date.now();
    try {
      const ranges = await runAnalysisStepsAsync(context.analyzer.getFoldingRangesSteps({
        uri: document.uri, version: document.version, text: document.getText()
      }), token, validate);
      await cancellationCheckpoint(token);
      validate();
      context.logger.info?.(`[timing] operation=lsp.foldingRange uri=${document.uri} version=${document.version} durationMs=${Date.now() - startedAt}`);
      return toLspFoldingRanges(ranges, capabilities());
    } catch (error: unknown) {
      rethrowCancellation(error);
      throwIfCancelled(token);
      context.logger.error(`Folding ranges failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
  context.connection.languages.foldingRange?.on((params, token = CancellationToken.None) =>
    handle({ params, revision: revision() }, token));
}
