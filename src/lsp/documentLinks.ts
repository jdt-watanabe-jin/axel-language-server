import { randomUUID } from 'crypto';
import { CancellationToken, ErrorCodes, LSPErrorCodes, ResponseError,
  type DocumentLink, type DocumentLinkParams } from 'vscode-languageserver/node';
import type { DocumentLinkCandidate } from '../analyzer/documentLinks';
import { runAnalysisStepsAsync } from '../util/analysisSteps';
import { cancellationCheckpoint, createRequestHandler, rethrowCancellation, throwIfCancelled } from '../util/cancellation';
import type { HandlerRegistrationContext } from './registerHandlers';

interface LinkData {
  session: string;
  uri: string;
  version: number;
  configuration: number;
  source: number;
  index: number;
  kind: DocumentLinkCandidate['kind'];
}

function isLinkData(value: unknown): value is LinkData {
  if (!value || typeof value !== 'object') { return false; }
  const data = value as LinkData;
  return typeof data.session === 'string' && typeof data.uri === 'string'
    && Number.isInteger(data.version) && Number.isInteger(data.configuration) && Number.isInteger(data.source)
    && Number.isInteger(data.index) && data.index >= 0 && (data.kind === 'include' || data.kind === 'script');
}

/** Independent syntax queue: no semantic/dependency flush on link requests. */
export function registerDocumentLinkHandlers(context: HandlerRegistrationContext, revision: () => number, configuration: () => number): void {
  const session = randomUUID();
  let nextSource = 0;
  const sources = new Map<string, number>();
  const sourceGeneration = (uri: string): number => {
    let generation = sources.get(uri);
    if (generation === undefined) { generation = ++nextSource; sources.set(uri, generation); }
    return generation;
  };
  context.documents.onDidOpen(event => { sources.set(event.document.uri, ++nextSource); });
  context.documents.onDidClose(event => { sources.delete(event.document.uri); });
  const queue = createRequestHandler();
  const handle = queue(async (entry: { uri: string; revision: number; data?: LinkData }, token) => {
    const validate = () => {
      throwIfCancelled(token);
      if (entry.revision !== revision()) { throw new ResponseError(LSPErrorCodes.ContentModified, 'Document links changed.'); }
    };
    validate();
    const document = context.documents.get(entry.uri);
    if (entry.data && (!document || document.version !== entry.data.version
      || entry.data.configuration !== configuration() || entry.data.source !== sourceGeneration(entry.uri))) {
      throw new ResponseError(LSPErrorCodes.ContentModified, 'Document link source changed.');
    }
    if (!document || !context.analyzer.getDocumentLinksSteps) { return []; }
    const startedAt = Date.now();
    try {
      const candidates = await runAnalysisStepsAsync(context.analyzer.getDocumentLinksSteps({
        uri: document.uri, version: document.version, text: document.getText()
      }), token, validate);
      const resolveTarget = (candidate: DocumentLinkCandidate) => context.analyzer.resolveDocumentLink?.(document.uri, candidate);
      let result: DocumentLink[];
      if (entry.data) {
        const candidate = candidates[entry.data.index];
        if (!candidate || candidate.kind !== entry.data.kind) {
          throw new ResponseError(ErrorCodes.InvalidParams, 'Invalid document link candidate.');
        }
        const target = resolveTarget(candidate);
        result = [{ range: candidate.range, ...(target ? { target } : {}), data: entry.data }];
      } else {
        // DocumentLink has no separate resolveSupport capability. Clients advertising
        // the feature support resolveProvider; older clients get complete targets.
        const lazy = context.clientCapabilities?.textDocument?.documentLink !== undefined;
        result = [];
        for (let index = 0; index < candidates.length; index++) {
          const candidate = candidates[index];
          if (lazy) {
            result.push({ range: candidate.range, data: {
              session, uri: document.uri, version: document.version, configuration: configuration(), source: sourceGeneration(document.uri), index, kind: candidate.kind
            } satisfies LinkData });
          } else {
            const target = resolveTarget(candidate);
            if (target) { result.push({ range: candidate.range, target }); }
          }
          if (index % 64 === 0) { await cancellationCheckpoint(token); validate(); }
        }
      }
      await cancellationCheckpoint(token);
      validate();
      context.logger.info?.(`[timing] operation=lsp.${entry.data ? 'documentLinkResolve' : 'documentLink'} uri=${document.uri} version=${document.version} durationMs=${Date.now() - startedAt}`);
      return result;
    } catch (error) {
      rethrowCancellation(error);
      throwIfCancelled(token);
      if (error instanceof ResponseError) { throw error; }
      context.logger.error(`Document links failed: ${String(error)}`);
      throw new ResponseError(LSPErrorCodes.RequestFailed, 'Document links failed; see server log.');
    }
  });
  context.connection.onDocumentLinks?.(async (params: DocumentLinkParams, token = CancellationToken.None) => {
    if (typeof params?.textDocument?.uri !== 'string') {
      throw new ResponseError(ErrorCodes.InvalidParams, 'Expected document URI.');
    }
    const entry = { uri: params.textDocument.uri, revision: revision() };
    await context.configuration!.ready(token);
    return handle(entry, token);
  });
  context.connection.onDocumentLinkResolve?.(async (link: DocumentLink, token = CancellationToken.None) => {
    const data: unknown = link?.data;
    if (!isLinkData(data) || data.session !== session) {
      throw new ResponseError(ErrorCodes.InvalidParams, 'Invalid document link data.');
    }
    const entry = { uri: data.uri, revision: revision(), data };
    await context.configuration!.ready(token);
    return (await handle(entry, token))[0];
  });
}
