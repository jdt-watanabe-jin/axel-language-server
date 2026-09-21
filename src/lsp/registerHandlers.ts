import { registerNavigationFeatures } from './navigationFeatures';
import { ProjectScope, normalizeProjectSettings } from '../analyzer/projectScope';
import { getInlayHintsSteps } from '../analyzer/inlayHints';
import { ConfigurationManager, configurationKeys } from './configuration';
import { registerFileOperations } from './fileOperations';
import { DidChangeConfigurationNotification, ErrorCodes } from 'vscode-languageserver/node';
import { registerWorkspaceSymbolHandler } from './workspaceSymbols';
import { normalizeInlayHintsSettings, toLspInlayHints } from './inlayHints';
import type { InlayHintParams } from 'vscode-languageserver/node';
import type { FoldingRangeCandidate } from '../analyzer/foldingRanges';
import { registerFoldingRangeHandler } from './foldingRanges';
import { runAnalysisStepsAsync, type AnalysisStep } from '../util/analysisSteps';
import { CancellationToken, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import { createRequestHandler, isCancellationError, throwIfCancelled, rethrowCancellation, cancellationCheckpoint } from '../util/cancellation';
import { sendLoginDependencies } from './loginDependencies';
import type {
  Connection,
  ClientCapabilities,
  CodeActionParams,
  CompletionParams,
  DefinitionParams,
  DocumentSymbolParams,
  FoldingRangeClientCapabilities,
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
import { registerCallHierarchyHandlers } from './callHierarchy';
import { createTypeHierarchyIndex, registerTypeHierarchyHandlers } from './typeHierarchy';
import { registerDocumentHighlightHandler } from './documentHighlights';

export interface ServerLogger {
  info?(message: string): void;
  error(message: string): void;
}

export interface AnalyzerLike extends
  WorkspaceDeclarationIndex,
  WorkspaceCompletionIndex,
  WorkspaceNavigationIndex,
  WorkspaceCodeActionIndex {
  getDocumentSymbolsSteps?(input: AnalyzeDocumentInput): Generator<AnalysisStep, import('../types/analysis').AnalysisSymbol[], void>;
  getSelectionRangesSteps?(input: AnalyzeDocumentInput, positions: readonly import('../types/analysis').AnalysisPosition[]): Generator<AnalysisStep, import('../analyzer/selectionRanges').AnalysisSelectionRange[], void>;
  getFoldingRangesSteps?(input: AnalyzeDocumentInput): Generator<AnalysisStep, FoldingRangeCandidate[], void>;
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
  setAnalysisEnabled?(enabled: boolean): void;
  setProjectScope?(scope: ProjectScope): void;
  invalidateUri?(uri: string): void;
  invalidatePaths?(uris: readonly string[]): void;
  onBackgroundIndexingComplete?(listener: () => void): void;
  getLoginDependencies?(cachedOnly?: boolean): { generation: number; uris: string[] };
  getAnalyzedDocument?(uri: string): AnalyzedDocument | undefined;
}

export interface HandlerRegistrationContext {
  clientCapabilities?: ClientCapabilities;
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  analyzer: AnalyzerLike;
  logger: ServerLogger;
  projectScope?: ProjectScope;
  configuration?: Pick<ConfigurationManager, 'start' | 'refresh' | 'ready' | 'isReady' | 'settings' | 'dispose'>;
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

interface RefactorHandlerConnection {
  onPrepareRename?(handler: (params: PrepareRenameParams, token: CancellationToken) => unknown): void;
  onRenameRequest?(handler: (params: RenameParams, token: CancellationToken) => unknown): void;
  onCodeAction?(handler: (params: CodeActionParams, token: CancellationToken) => unknown): void;
}

export function registerHandlers(context: HandlerRegistrationContext): void {
  const projectScope = context.projectScope ??= new ProjectScope(message => context.logger.error(message));
  context.analyzer.setProjectScope?.(projectScope);
  const typeHierarchy = createTypeHierarchyIndex(context);
  const fileOperations = registerFileOperations(context, uris => invalidateFiles(uris));
  const workspaceSymbols = registerWorkspaceSymbolHandler(context, roots => {
    projectScope.setRoots(roots); revision++; fileOperations.setRoots(roots); typeHierarchy.invalidate();
  });
  const updateOpenScope = () => projectScope.setOpenUris((context.documents.all?.() ?? []).map(document => document.uri));
  context.documents.onDidChangeContent(updateOpenScope);
  context.documents.onDidClose(updateOpenScope);
    let revision = 0;
  let documentsDirty = false;
  const invalidateRequests = () => { revision++; if (!context.configuration?.isReady) { documentsDirty = true; } };
  const invalidateFiles = (uris: string[]): void => {
    if (!uris.length) { return; }
    invalidateRequests(); projectScope.invalidate();
    fileOperations.invalidate(uris);
    workspaceSymbols?.invalidate(uris);
    typeHierarchy.invalidate(uris);
    if (context.analyzer.invalidatePaths) { context.analyzer.invalidatePaths(uris); }
    else { for (const uri of uris) { context.analyzer.invalidateUri?.(uri); } }
    if (!context.configuration?.isReady) { return; }
    sendLoginDependencies(context);
    refreshLanguageFeature(context, 'semanticTokens');
    refreshLanguageFeature(context, 'diagnostics');
    refreshInlayHints();
  };
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
    return async (params: P, token = CancellationToken.None) => {
      const entry = { params, revision };
      await context.configuration!.ready(token);
      return queued(entry, token);
    };
  };
  const runRequestSteps = <T>(steps: Generator<AnalysisStep, T, void>, token: CancellationToken) =>
    runAnalysisStepsAsync(steps, token, validateRequest);
  const analyzeRequest = (context: HandlerRegistrationContext, token: CancellationToken, diagnostic: boolean, input: AnalyzeDocumentInput) =>
    analyzeRequestDocument(context, token, diagnostic, input, validateRequest);
  let locale: string | undefined;
  let hoverMarkdown = false;
  let completionMarkdown = false;
  let signatureMarkdown = false;
  let foldingCapabilities: FoldingRangeClientCapabilities | undefined;
  let featureSettings: Record<string, unknown> = {};
  let inlayRefreshSupported = false;
  const refreshInlayHints = (): void => {
    if (inlayRefreshSupported) {
      void context.connection.languages.inlayHint?.refresh().catch(error => context.logger.error(`Inlay hint refresh failed: ${getErrorMessage(error)}`));
    }
  };
  const updateFeatures = (settings: unknown): void => {
    featureSettings = settings !== null && typeof settings === 'object' ? settings as Record<string, unknown> : {};
  };
  let dynamicConfiguration = false;
  let appliedKeys: ReturnType<typeof configurationKeys> | undefined;
  let analysisChanged = false;
  let featuresChanged = false;
  let filesChanged = false;
  const refresh = () => {
    if (!context.configuration!.isReady) { return; }
    context.analyzer.setAnalysisEnabled?.(true);
    if (filesChanged) { fileOperations.configure(); } else { fileOperations.resume(); }
    workspaceSymbols?.resume();
    typeHierarchy.resume();
    if (!analysisChanged && !featuresChanged && !documentsDirty) { return; }
    documentsDirty = false;
    for (const document of context.documents.all()) { void indexDocument(context, document); }
    sendLoginDependencies(context);
    refreshLanguageFeature(context, 'semanticTokens');
    refreshLanguageFeature(context, 'diagnostics');
    refreshInlayHints();
  };
  context.configuration ??= new ConfigurationManager(
    token => context.connection.sendRequest<unknown[]>('workspace/configuration', { items: [{ section: 'axel' }] }, token)
      .then(result => { if (!Array.isArray(result) || result.length !== 1) { throw new Error('Expected one configuration result.'); } return result[0]; }),
      settings => {
        projectScope.configure(normalizeProjectSettings(settings));
        const keys = configurationKeys(settings);
        const recovered = appliedKeys && JSON.stringify(keys) === JSON.stringify(appliedKeys);
        analysisChanged = !appliedKeys || keys.analysis !== appliedKeys.analysis || !!recovered;
        featuresChanged = !appliedKeys || keys.features !== appliedKeys.features;
        filesChanged = !appliedKeys || keys.files !== appliedKeys.files;
        updateFeatures(settings);
        if (analysisChanged) { context.analyzer.configure?.(settings); }
        workspaceSymbols?.configure(settings);
        typeHierarchy.configure(settings);
        appliedKeys = keys;
      },
    () => { revision++; analysisChanged = false; featuresChanged = false; filesChanged = false;
      context.analyzer.setAnalysisEnabled?.(false); workspaceSymbols?.pause(); fileOperations.pause(); typeHierarchy.pause(); },
    message => {
      context.logger.error(message);
      void context.connection.sendNotification('window/showMessage', { type: 1, message }).catch(() => {});
    },
    5_000, refresh
  );
  context.analyzer.setAnalysisEnabled?.(false);
  context.connection.onInitialize((params, token) => {
    throwIfCancelled(token);
    if (params.capabilities?.workspace?.configuration !== true) {
      throw new ResponseError(ErrorCodes.InvalidParams, 'AXEL requires workspace/configuration support.');
    }
    context.clientCapabilities = params.capabilities;
    dynamicConfiguration = params.capabilities.workspace.didChangeConfiguration?.dynamicRegistration === true;
    projectScope.setRoots(params.workspaceFolders?.map(folder => folder.uri) ?? (params.rootUri ? [params.rootUri] : []));
    workspaceSymbols?.initialize(params);
    fileOperations.initialize(params);
    locale = params.locale;
    inlayRefreshSupported = params.capabilities?.workspace?.inlayHint?.refreshSupport ?? false;
    foldingCapabilities = params.capabilities?.textDocument?.foldingRange;
    hoverMarkdown = params.capabilities?.textDocument?.hover?.contentFormat?.includes('markdown') ?? false;
    completionMarkdown = params.capabilities?.textDocument?.completion?.completionItem?.documentationFormat?.includes('markdown') ?? false;
    signatureMarkdown = params.capabilities?.textDocument?.signatureHelp?.signatureInformation?.documentationFormat?.includes('markdown') ?? false;
    return createInitializeResult(params.capabilities);
  });
  context.connection.onDidChangeConfiguration?.(() => context.configuration!.refresh());
  const flushPendingChanges = registerDocumentLifecycleHandlers(context, invalidateRequests, refreshInlayHints, () => {
    context.configuration!.dispose(); context.analyzer.setAnalysisEnabled?.(false); fileOperations.dispose();
    return Promise.all([workspaceSymbols?.dispose(), typeHierarchy.dispose()]).then(() => undefined);
  });
  const measureRequest = async <T>(token: CancellationToken, operation: string, details: LogDetails, work: () => T | Promise<T>, flushChanges = true): Promise<T> => {
    const startedAt = Date.now();
    try {
      throwIfCancelled(token);
      if (flushChanges) { await flushPendingChanges(); }
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
  context.connection.onDidChangeWatchedFiles(event => invalidateFiles(event.changes.map(change => change.uri)));
  registerBackgroundRefreshHandlers(context, refreshInlayHints);
  context.connection.onInitialized?.(() => {
    workspaceSymbols?.start();
    if (dynamicConfiguration) {
      void context.connection.client.register(DidChangeConfigurationNotification.type, undefined)
        .catch(error => context.logger.error(`Configuration registration failed: ${String(error)}`));
    }
    context.configuration!.start();
  });

  registerDocumentHighlightHandler(context, {
    request,
    measureRequest,
    runRequestSteps,
    analyzeRequest: (token, input) => analyzeRequest(context, token, false, input)
  });

  registerCallHierarchyHandlers(context, {
    request,
    measureRequest,
    runRequestSteps,
    analyzeRequest: (token, input) => analyzeRequest(context, token, false, input)
  });

  registerTypeHierarchyHandlers(context, typeHierarchy, { request });
  registerNavigationFeatures(context, typeHierarchy, { request }, () => revision);

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

  context.connection.languages.inlayHint?.on(request(async (params: InlayHintParams, token) => {
    const settings = normalizeInlayHintsSettings(featureSettings);
    if (!settings.enabled) { return []; }
    const document = context.documents.get(params.textDocument.uri);
    return measureRequest(token, 'lsp.inlayHints', rangeRequestDetails(params, document), async () => {
      if (!document) { return []; }
      try {
        const text = document.getText();
        const analysis = await analyzeRequest(context, token, false, {uri:document.uri,version:document.version,text});
        return toLspInlayHints(await runRequestSteps(getInlayHintsSteps({
          analysis,text,range:params.range,workspaceIndex:context.analyzer,
          suppressWhenArgumentContainsName:settings.suppressWhenArgumentContainsName
        }),token));
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Inlay hints failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  }));

  registerFoldingRangeHandler(context, () => revision, () => foldingCapabilities);

  context.connection.onDocumentSymbol(request(async (params: DocumentSymbolParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    const local = featureSettings.workspaceSymbols !== 'All' && !!context.analyzer.getDocumentSymbolsSteps;
    return measureRequest(token, 'lsp.documentSymbol', documentRequestDetails(params, document), async () => {
      if (document === undefined) {
        return [];
      }

      try {
        if (local) {
          const symbols = await runRequestSteps(context.analyzer.getDocumentSymbolsSteps!({
            uri: document.uri, version: document.version, text: document.getText()
          }), token);
          return symbols.map(toLspDocumentSymbol);
        }
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
    }, !local);
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

function registerDocumentLifecycleHandlers(context: HandlerRegistrationContext, invalidateRequests: () => void, refreshInlayHints: () => void,
  disposeSymbols: () => Promise<void> | undefined): () => Promise<void> {
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
    if (documents.length) { refreshInlayHints(); }
  };

  context.documents.onDidOpen((event) => {
    invalidateRequests();
    pending.delete(event.document.uri);
    void indexDocument(context, event.document).then(refreshInlayHints);
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
    refreshInlayHints();
    if (sendLoginDependencies(context)) { refreshLanguageFeature(context, 'semanticTokens'); }
    refreshLanguageFeature(context, 'diagnostics');
  });

  context.connection.onShutdown?.(async token => {
    throwIfCancelled(token);
    invalidateRequests();
    clearTimeout(timer);
    timer = undefined;
    pending.clear();
    await disposeSymbols();
  });
  return flush;
}

async function indexDocument(context: HandlerRegistrationContext, document: TextDocument, token: CancellationToken = CancellationToken.None): Promise<void> {
  if (!context.configuration?.isReady) { return; }
  try {
    const input = { uri: document.uri, version: document.version, text: document.getText() };
    if (context.analyzer.analyzeForegroundDocumentAsync) {
      const analysis = await context.analyzer.analyzeForegroundDocumentAsync(input, token);
      throwIfCancelled(token);
      if (!context.configuration.isReady || context.documents.get(input.uri)?.version !== input.version) { return; }
      sendInactiveRanges(context, analysis);
    } else { analyzeForInteractiveRequest(context, input); }
    if (sendLoginDependencies(context)) {
      refreshLanguageFeature(context, 'semanticTokens');
      refreshLanguageFeature(context, 'diagnostics');
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

function registerBackgroundRefreshHandlers(context: HandlerRegistrationContext, refreshInlayHints: () => void): void {
  context.analyzer.onBackgroundIndexingComplete?.(() => {
    if (!context.configuration?.isReady) { return; }
    refreshInlayHints();
    sendLoginDependencies(context);
    refreshLanguageFeature(context, 'semanticTokens');
    refreshLanguageFeature(context, 'diagnostics');
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

/** Optional server-to-client requests must be negotiated, including background updates. */
function refreshLanguageFeature(context: HandlerRegistrationContext, feature: 'semanticTokens' | 'diagnostics'): void {
  if (context.clientCapabilities?.workspace?.[feature]?.refreshSupport !== true) { return; }
  void Promise.resolve(context.connection.languages[feature].refresh?.())
    .catch(error => context.logger.error(`${feature} refresh failed: ${getErrorMessage(error)}`));
}
