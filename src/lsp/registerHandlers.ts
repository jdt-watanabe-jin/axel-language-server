import { runAnalysisStepsAsync, type AnalysisStep } from '../util/analysisSteps';
import { CancellationToken, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import { createRequestHandler, isCancellationError, throwIfCancelled, rethrowCancellation, cancellationCheckpoint } from '../util/cancellation';
import { sendLoginDependencies } from './loginDependencies';
import type {
  Connection,
  CodeActionParams,
  CompletionParams,
  DefinitionParams,
  DocumentSymbolParams,
  DocumentFormattingParams,
  DocumentRangeFormattingParams,
  HoverParams,
  PrepareRenameParams,
  ReferenceParams,
  RenameParams,
  SemanticTokensParams,
  SignatureHelpParams,
  TextDocuments
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { AnalyzeDocumentInput, AnalyzedDocument, AnalysisRange } from '../types/analysis';
import { getCodeActions, type WorkspaceCodeActionIndex } from '../analyzer/codeActions';
import { getCompletions, type WorkspaceCompletionIndex } from '../analyzer/completion';
import { getFormattingEditsSteps } from '../analyzer/formatting';
import { getHover, type WorkspaceDeclarationIndex } from '../analyzer/hover';
import { getDefinitions, getReferencesSteps, type WorkspaceNavigationIndex } from '../analyzer/navigation';
import { getRenameEditsSteps, prepareRename } from '../analyzer/rename';
import type { WorkspaceDeclarationLookup } from '../analyzer/resolution';
import { getSignatureHelp } from '../analyzer/signatureHelp';
import { collectSemanticTokens } from '../analyzer/semanticTokens';
import { createInitializeResult } from './capabilities';
import { toLspCodeActions } from './codeActions';
import { toLspCompletionItemForClient } from './completion';
import { toLspDefinitionLocations } from './definition';
import { toDocumentDiagnosticReport } from './diagnostics';
import { toLspDocumentSymbol } from './documentSymbols';
import { toLspTextEdits } from './formatting';
import { toLspHover } from './hover';
import { toLspReferenceLocations } from './references';
import { toLspWorkspaceEdit } from './rename';
import { toLspSemanticTokens } from './semanticTokens';
import { toLspSignatureHelp } from './signatureHelp';
import type { IncludeResolutionStatus } from '../analyzer/includeDiagnostics';

export interface ServerLogger {
  info?(message: string): void;
  error(message: string): void;
}

export interface AnalyzerLike extends
  WorkspaceDeclarationIndex,
  WorkspaceCompletionIndex,
  WorkspaceNavigationIndex,
  WorkspaceCodeActionIndex {
  updateOpenDocument?(input: AnalyzeDocumentInput): void;
  analyzeRequestDocument?(input: AnalyzeDocumentInput, token: CancellationToken): Promise<AnalyzedDocument>;
  analyzeDocument(input: AnalyzeDocumentInput): AnalyzedDocument;
  analyzeDiagnosticDocument?(input: AnalyzeDocumentInput): AnalyzedDocument;
  getIncludeResolutionStatus?(analysis: AnalyzedDocument): IncludeResolutionStatus;
  analyzeForegroundDocumentAsync?(input: AnalyzeDocumentInput, token: CancellationToken): Promise<AnalyzedDocument>;
  analyzeForegroundDocument?(input: AnalyzeDocumentInput): AnalyzedDocument;
  indexOpenDocument?(input: AnalyzeDocumentInput): AnalyzedDocument;
  semanticTokenWorkspaceIndex?(sourceUri: string): WorkspaceDeclarationLookup;
  deleteDocument?(uri: string): void;
  configure?(options: unknown): void;
  invalidateUri?(uri: string): void;
  onBackgroundIndexingComplete?(listener: () => void): void;
  getLoginDependencies?(cachedOnly?: boolean): { generation: number; uris: string[] };
}

export interface HandlerRegistrationContext {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  analyzer: AnalyzerLike;
  logger: ServerLogger;
}

interface InactiveRangesParams {
  uri: string;
  ranges: AnalysisRange[];
}

const INACTIVE_RANGES_NOTIFICATION = 'axel/inactiveRanges';

interface FormattingHandlerConnection {
  onDocumentFormatting?(handler: (params: DocumentFormattingParams, token: CancellationToken) => unknown): void;
  onDocumentRangeFormatting?(handler: (params: DocumentRangeFormattingParams, token: CancellationToken) => unknown): void;
}

interface ConfigurationHandlerConnection {
  onDidChangeConfiguration?(handler: (params: { settings?: unknown }) => void): void;
}

interface RefactorHandlerConnection {
  onPrepareRename?(handler: (params: PrepareRenameParams, token: CancellationToken) => unknown): void;
  onRenameRequest?(handler: (params: RenameParams, token: CancellationToken) => unknown): void;
  onCodeAction?(handler: (params: CodeActionParams, token: CancellationToken) => unknown): void;
}

export function registerHandlers(context: HandlerRegistrationContext): void {
  let revision = 0;
  const invalidateRequests = () => { revision++; };
  const queue = createRequestHandler();
  let validateRequest = () => undefined as void;
  const request = <P, T>(work: (params: P, token: CancellationToken) => Promise<T>) => {
    const queued = queue(async (entry: { params: P; revision: number }, token) => {
      validateRequest = () => {
        throwIfCancelled(token);
        if (revision !== entry.revision) { throw new ResponseError(LSPErrorCodes.ContentModified, 'Workspace changed during request.'); }
      };
      try {
        validateRequest();
        const result = await work(entry.params, token);
        await cancellationCheckpoint(token);
        validateRequest();
        return result;
      } finally { validateRequest = () => undefined; }
    });
    return (params: P, token = CancellationToken.None) => queued({ params, revision }, token);
  };
  const runRequestSteps = <T>(steps: Generator<AnalysisStep, T, void>, token: CancellationToken) =>
    runAnalysisStepsAsync(steps, token, validateRequest);
  const analyzeRequest = (context: HandlerRegistrationContext, token: CancellationToken, diagnostic: boolean, input: AnalyzeDocumentInput) =>
    analyzeRequestDocument(context, token, diagnostic, input, validateRequest);
  let locale: string | undefined;
  let hoverMarkdown = false;
  let completionMarkdown = false;
  let signatureMarkdown = false;
  let featureSettings: Record<string, unknown> = {};
  const updateFeatures = (settings: unknown): void => {
    invalidateRequests();
    featureSettings = settings !== null && typeof settings === 'object' ? settings as Record<string, unknown> : {};
  };
  context.connection.onInitialize((params, token) => {
    throwIfCancelled(token);
    locale = params.locale;
    hoverMarkdown = params.capabilities?.textDocument?.hover?.contentFormat?.includes('markdown') ?? false;
    completionMarkdown = params.capabilities?.textDocument?.completion?.completionItem?.documentationFormat?.includes('markdown') ?? false;
    signatureMarkdown = params.capabilities?.textDocument?.signatureHelp?.signatureInformation?.documentationFormat?.includes('markdown') ?? false;
    updateFeatures(params.initializationOptions);
    context.analyzer.configure?.(params.initializationOptions);
    return createInitializeResult();
  });
  registerConfigurationChangeHandlers(context, updateFeatures);
  const flushPendingChanges = registerDocumentLifecycleHandlers(context, invalidateRequests);
  const measureRequest = async <T>(token: CancellationToken, operation: string, details: LogDetails, work: () => T | Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      throwIfCancelled(token);
      await flushPendingChanges();
      validateRequest();
      await cancellationCheckpoint(token);
      const result = await work();
      validateRequest();
      context.logger.info?.(`[timing] operation=${operation} ${Object.entries(details).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`).join(' ')} durationMs=${Date.now() - startedAt}`);
      return result;
    } catch (error: unknown) {
      rethrowCancellation(error);
      throw error;
    }
  };
  registerWatchedFileHandlers(context, invalidateRequests);
  registerBackgroundRefreshHandlers(context);
  context.connection.onInitialized?.(() => { sendLoginDependencies(context); });

  context.connection.languages.diagnostics.on(request(async (params, token) => {
    if (featureSettings.errorSquiggles === 'disabled') { return toDocumentDiagnosticReport([]); }
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.diagnostics', documentRequestDetails(params, document), async () => {
      if (document === undefined) {
        return toDocumentDiagnosticReport([]);
      }

      try {
        const analysis = await analyzeRequest(context, token, true, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        if (featureSettings.errorSquiggles !== 'enabled') {
          const includes = context.analyzer.getIncludeResolutionStatus?.(analysis);
          if (includes && !includes.resolved) { return toDocumentDiagnosticReport(includes.diagnostics, locale); }
        }
        return toDocumentDiagnosticReport(analysis.diagnostics, locale);
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Diagnostics failed: ${getErrorMessage(error)}`);
        return toDocumentDiagnosticReport([]);
      }
    });
  }));

  context.connection.onHover(request(async (params: HoverParams, token) => {
    if (featureSettings.hover === 'disabled') { return null; }
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.hover', positionRequestDetails(params, document), async () => {
      if (document === undefined) {
        return null;
      }

      try {
        const analysis = await analyzeRequest(context, token, false, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        const hover = getHover({
          locale,
          analysis,
          position: params.position,
          workspaceIndex: context.analyzer
        });
        return hover === null ? null : toLspHover(hover, hoverMarkdown);
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Hover failed: ${getErrorMessage(error)}`);
        return null;
      }
    });
  }));

  context.connection.onCompletion(request(async (params: CompletionParams, token) => {
    if (featureSettings.autocomplete === 'disabled') { return []; }
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.completion', positionRequestDetails(params, document), async () => {
      if (document === undefined) {
        return [];
      }

      try {
        const text = document.getText();
        const analysis = await analyzeRequest(context, token, false, {
          uri: document.uri,
          version: document.version,
          text
        });
        return getCompletions({
          locale,
          analysis,
          text,
          position: params.position,
          workspaceIndex: context.analyzer
        }).map(item => toLspCompletionItemForClient(item, completionMarkdown));
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Completion failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  }));

  context.connection.onDefinition(request(async (params: DefinitionParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.definition', positionRequestDetails(params, document), async () => {
      if (document === undefined) {
        return [];
      }

      try {
        const analysis = await analyzeRequest(context, token, false, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        return toLspDefinitionLocations(getDefinitions({
          analysis,
          position: params.position,
          workspaceIndex: context.analyzer
        }));
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Definition failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  }));

  context.connection.onReferences(request(async (params: ReferenceParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.references', {
      ...positionRequestDetails(params, document),
      includeDeclaration: params.context.includeDeclaration
    }, async () => {
      if (document === undefined) {
        return [];
      }

      try {
        const analysis = await analyzeRequest(context, token, false, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        return toLspReferenceLocations(await runRequestSteps(getReferencesSteps({
          analysis,
          position: params.position,
          includeDeclaration: params.context.includeDeclaration,
          workspaceIndex: context.analyzer
        }), token));
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`References failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  }));

  const refactorConnection = context.connection as RefactorHandlerConnection;

  refactorConnection.onPrepareRename?.(request(async (params: PrepareRenameParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.prepareRename', positionRequestDetails(params, document), async () => {
      if (document === undefined) {
        return null;
      }

      try {
        const analysis = await analyzeRequest(context, token, false, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        return prepareRename({
          analysis,
          position: params.position,
          workspaceIndex: context.analyzer
        });
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Prepare rename failed: ${getErrorMessage(error)}`);
        return null;
      }
    });
  }));

  refactorConnection.onRenameRequest?.(request(async (params: RenameParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.rename', {
      ...positionRequestDetails(params, document),
      newNameLength: params.newName.length
    }, async () => {
      if (document === undefined) {
        return null;
      }

      try {
        const analysis = await analyzeRequest(context, token, false, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        const result = await runRequestSteps(getRenameEditsSteps({
          analysis,
          position: params.position,
          newName: params.newName,
          workspaceIndex: context.analyzer
        }), token);
        return 'reason' in result ? null : toLspWorkspaceEdit(result);
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Rename failed: ${getErrorMessage(error)}`);
        return null;
      }
    });
  }));

  refactorConnection.onCodeAction?.(request(async (params: CodeActionParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.codeAction', rangeRequestDetails(params, document), async () => {
      if (document === undefined) {
        return [];
      }

      try {
        const analysis = await analyzeRequest(context, token, false, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        return toLspCodeActions(getCodeActions({
          locale,
          analysis,
          range: params.range,
          diagnostics: analysis.diagnostics,
          workspaceIndex: context.analyzer
        }), locale);
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Code action failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  }));

  const formattingConnection = context.connection as FormattingHandlerConnection;

  formattingConnection.onDocumentFormatting?.(request(async (params: DocumentFormattingParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.formatting', {
      ...documentRequestDetails(params, document),
      insertSpaces: Boolean(params.options.insertSpaces),
      tabSize: params.options.tabSize
    }, async () => {
      if (document === undefined) {
        return [];
      }

      try {
        return toLspTextEdits(await runRequestSteps(getFormattingEditsSteps({
          text: document.getText(),
          options: {
            insertSpaces: Boolean(params.options.insertSpaces),
            tabSize: params.options.tabSize
          }
        }), token));
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Formatting failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  }));

  formattingConnection.onDocumentRangeFormatting?.(request(async (params: DocumentRangeFormattingParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.rangeFormatting', {
      ...rangeRequestDetails(params, document),
      insertSpaces: Boolean(params.options.insertSpaces),
      tabSize: params.options.tabSize
    }, async () => {
      if (document === undefined) {
        return [];
      }

      try {
        return toLspTextEdits(await runRequestSteps(getFormattingEditsSteps({
          text: document.getText(),
          options: {
            insertSpaces: Boolean(params.options.insertSpaces),
            tabSize: params.options.tabSize
          },
          range: params.range
        }), token));
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Range formatting failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  }));

  context.connection.onSignatureHelp(request(async (params: SignatureHelpParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.signatureHelp', positionRequestDetails(params, document), async () => {
      if (document === undefined) {
        return null;
      }

      try {
        const text = document.getText();
        const analysis = await analyzeRequest(context, token, false, {
          uri: document.uri,
          version: document.version,
          text
        });
        const signatureHelp = getSignatureHelp({
          locale,
          analysis,
          text,
          position: params.position,
          workspaceIndex: context.analyzer
        });
        return signatureHelp === null ? null : toLspSignatureHelp(signatureHelp, signatureMarkdown);
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Signature help failed: ${getErrorMessage(error)}`);
        return null;
      }
    });
  }));

  context.connection.onDocumentSymbol(request(async (params: DocumentSymbolParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.documentSymbol', documentRequestDetails(params, document), async () => {
      if (document === undefined) {
        return [];
      }

      try {
        const analysis = await analyzeRequest(context, token, false, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        return analysis.symbols.map(toLspDocumentSymbol);
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Document symbols failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  }));

  context.connection.languages.semanticTokens.on(request(async (params: SemanticTokensParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.semanticTokens', documentRequestDetails(params, document), async () => {
      if (document === undefined) {
        return toLspSemanticTokens([]);
      }

      try {
        const analysis = await analyzeRequest(context, token, false, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        return toLspSemanticTokens(collectSemanticTokens(
          analysis,
          context.analyzer.semanticTokenWorkspaceIndex?.(document.uri) ?? context.analyzer
        ));
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Semantic tokens failed: ${getErrorMessage(error)}`);
        return toLspSemanticTokens([]);
      }
    });
  }));
}

function registerWatchedFileHandlers(context: HandlerRegistrationContext, invalidateRequests: () => void): void {
  context.connection.onDidChangeWatchedFiles((event) => {
    if (event.changes.length > 0) { invalidateRequests(); }
    for (const change of event.changes) {
      context.analyzer.invalidateUri?.(change.uri);
    }
    if (event.changes.length > 0) {
      sendLoginDependencies(context);
      context.connection.languages.semanticTokens.refresh?.();
      context.connection.languages.diagnostics.refresh();
    }
  });
}

function registerConfigurationChangeHandlers(context: HandlerRegistrationContext, updateFeatures: (settings: unknown) => void): void {
  const connection = context.connection as ConfigurationHandlerConnection;
  connection.onDidChangeConfiguration?.((params) => {
    updateFeatures(params.settings);
    context.analyzer.configure?.(params.settings);
    for (const document of context.documents.all()) {
      indexDocument(context, document);
    }
    sendLoginDependencies(context);
    context.connection.languages.semanticTokens.refresh();
    context.connection.languages.diagnostics.refresh();
  });
}

function registerDocumentLifecycleHandlers(context: HandlerRegistrationContext, invalidateRequests: () => void): () => Promise<void> {
  const pending = new Map<string, TextDocument>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const documents = [...pending.values()];
    pending.clear();
    // These updates belong to document notifications, not to the request that flushes them.
    // Cancelling that request must not discard another document's pending update.
    for (const document of documents) { await indexDocument(context, document); }
  };

  context.documents.onDidOpen((event) => {
    invalidateRequests();
    pending.delete(event.document.uri);
    indexDocument(context, event.document);
  });

  context.documents.onDidChangeContent((event) => {
    invalidateRequests();
    context.analyzer.updateOpenDocument?.({ uri: event.document.uri, version: event.document.version, text: event.document.getText() });
    pending.set(event.document.uri, event.document);
    // A fixed window bounds notification delay even during continuous typing.
    // Requests flush immediately rather than waiting for this timer.
    timer ??= setTimeout(() => { void flush(); }, 20);
  });

  context.documents.onDidClose((event) => {
    invalidateRequests();
    pending.delete(event.document.uri);
    if (pending.size === 0) { clearTimeout(timer); timer = undefined; }
    context.analyzer.deleteDocument?.(event.document.uri);
    if (sendLoginDependencies(context)) { context.connection.languages.semanticTokens.refresh?.(); }
    context.connection.languages.diagnostics.refresh?.();
  });

  context.connection.onShutdown?.(token => {
    throwIfCancelled(token);
    invalidateRequests();
    clearTimeout(timer);
    timer = undefined;
    pending.clear();
  });
  return flush;
}

async function indexDocument(context: HandlerRegistrationContext, document: TextDocument, token: CancellationToken = CancellationToken.None): Promise<void> {
  try {
    const input = { uri: document.uri, version: document.version, text: document.getText() };
    if (context.analyzer.analyzeForegroundDocumentAsync) {
      const analysis = await context.analyzer.analyzeForegroundDocumentAsync(input, token);
      throwIfCancelled(token);
      if (context.documents.get(input.uri)?.version !== input.version) { return; }
      sendInactiveRanges(context, analysis);
    } else { analyzeForInteractiveRequest(context, input); }
    if (sendLoginDependencies(context)) {
      context.connection.languages.semanticTokens.refresh?.();
      context.connection.languages.diagnostics.refresh?.();
    }
  } catch (error: unknown) {
    if (isCancellationError(error)) {
      if (error instanceof ResponseError && error.code === LSPErrorCodes.ContentModified && token === CancellationToken.None) {
        // A notification has no requester to retry it. Keep open documents indexed after overlapping changes.
        setImmediate(() => {
          const latest = context.documents.get(document.uri);
          if (latest) { void indexDocument(context, latest); }
        });
      }
      return;
    }
    context.logger.error(`Workspace indexing failed: ${getErrorMessage(error)}`);
  }
}

function sendInactiveRanges(context: HandlerRegistrationContext, analysis: AnalyzedDocument): void {
  const connection = context.connection as { sendNotification?(method: string, params: InactiveRangesParams): void };
  connection.sendNotification?.(INACTIVE_RANGES_NOTIFICATION, {
    uri: analysis.uri,
    ranges: analysis.inactiveRanges ?? []
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function registerBackgroundRefreshHandlers(context: HandlerRegistrationContext): void {
  context.analyzer.onBackgroundIndexingComplete?.(() => {
    sendLoginDependencies(context);
    context.connection.languages.semanticTokens.refresh();
    context.connection.languages.diagnostics.refresh();
  });
}

function analyzeForInteractiveRequest(
  context: HandlerRegistrationContext,
  input: AnalyzeDocumentInput
): AnalyzedDocument {
  const analysis = context.analyzer.analyzeForegroundDocument?.(input)
    ?? context.analyzer.analyzeDocument(input);
  sendInactiveRanges(context, analysis);
  return analysis;
}

async function analyzeRequestDocument(
  context: HandlerRegistrationContext, token: CancellationToken, diagnostic: boolean, input: AnalyzeDocumentInput, validate: () => void
): Promise<AnalyzedDocument> {
  await cancellationCheckpoint(token);
  validate();
  const analysis = context.analyzer.analyzeRequestDocument
    ? await context.analyzer.analyzeRequestDocument(input, token)
    : diagnostic ? (context.analyzer.analyzeDiagnosticDocument?.(input)
      ?? context.analyzer.analyzeForegroundDocument?.(input) ?? context.analyzer.analyzeDocument(input))
      : (context.analyzer.analyzeForegroundDocument?.(input) ?? context.analyzer.analyzeDocument(input));
  await cancellationCheckpoint(token);
  validate();
  sendInactiveRanges(context, analysis);
  return analysis;
}

type LogDetails = Record<string, string | number | boolean | undefined>;

function documentRequestDetails(
  params: { textDocument: { uri: string } },
  document: TextDocument | undefined
): LogDetails {
  return {
    uri: params.textDocument.uri,
    version: document?.version,
    documentMissing: document === undefined ? true : undefined
  };
}

function positionRequestDetails(
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
  document: TextDocument | undefined
): LogDetails {
  return {
    ...documentRequestDetails(params, document),
    line: params.position.line,
    character: params.position.character
  };
}

function rangeRequestDetails(
  params: {
    textDocument: { uri: string };
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  },
  document: TextDocument | undefined
): LogDetails {
  return {
    ...documentRequestDetails(params, document),
    startLine: params.range.start.line,
    startCharacter: params.range.start.character,
    endLine: params.range.end.line,
    endCharacter: params.range.end.character
  };
}
