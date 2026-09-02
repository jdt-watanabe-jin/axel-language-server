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
import { getFormattingEdits } from '../analyzer/formatting';
import { getHover, type WorkspaceDeclarationIndex } from '../analyzer/hover';
import { getDefinitions, getReferences, type WorkspaceNavigationIndex } from '../analyzer/navigation';
import { getRenameEdits, prepareRename } from '../analyzer/rename';
import type { WorkspaceDeclarationLookup } from '../analyzer/resolution';
import { getSignatureHelp } from '../analyzer/signatureHelp';
import { collectSemanticTokens } from '../analyzer/semanticTokens';
import { measureDurationMs } from '../util/logger';
import { createInitializeResult } from './capabilities';
import { toLspCodeActions } from './codeActions';
import { toLspCompletionItem } from './completion';
import { toLspDefinitionLocations } from './definition';
import { toDocumentDiagnosticReport } from './diagnostics';
import { toLspDocumentSymbol } from './documentSymbols';
import { toLspTextEdits } from './formatting';
import { toLspHover } from './hover';
import { toLspReferenceLocations } from './references';
import { toLspWorkspaceEdit } from './rename';
import { toLspSemanticTokens } from './semanticTokens';
import { toLspSignatureHelp } from './signatureHelp';

export interface ServerLogger {
  info?(message: string): void;
  error(message: string): void;
}

export interface AnalyzerLike extends
  WorkspaceDeclarationIndex,
  WorkspaceCompletionIndex,
  WorkspaceNavigationIndex,
  WorkspaceCodeActionIndex {
  analyzeDocument(input: AnalyzeDocumentInput): AnalyzedDocument;
  analyzeForegroundDocument?(input: AnalyzeDocumentInput): AnalyzedDocument;
  indexOpenDocument?(input: AnalyzeDocumentInput): AnalyzedDocument;
  semanticTokenWorkspaceIndex?(sourceUri: string): WorkspaceDeclarationLookup;
  deleteDocument?(uri: string): void;
  configure?(options: unknown): void;
  invalidateUri?(uri: string): void;
  onBackgroundIndexingComplete?(listener: () => void): void;
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
  onDocumentFormatting?(handler: (params: DocumentFormattingParams) => unknown): void;
  onDocumentRangeFormatting?(handler: (params: DocumentRangeFormattingParams) => unknown): void;
}

interface RefactorHandlerConnection {
  onPrepareRename?(handler: (params: PrepareRenameParams) => unknown): void;
  onRenameRequest?(handler: (params: RenameParams) => unknown): void;
  onCodeAction?(handler: (params: CodeActionParams) => unknown): void;
}

export function registerHandlers(context: HandlerRegistrationContext): void {
  context.connection.onInitialize((params) => {
    context.analyzer.configure?.(params.initializationOptions);
    return createInitializeResult();
  });
  registerDocumentLifecycleHandlers(context);
  registerWatchedFileHandlers(context);
  registerBackgroundRefreshHandlers(context);

  context.connection.languages.diagnostics.on((params) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.diagnostics', documentRequestDetails(params, document), () => {
      if (document === undefined) {
        return toDocumentDiagnosticReport([]);
      }

      try {
        const analysis = analyzeForInteractiveRequest(context, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        return toDocumentDiagnosticReport(analysis.diagnostics);
      } catch (error: unknown) {
        context.logger.error(`Diagnostics failed: ${getErrorMessage(error)}`);
        return toDocumentDiagnosticReport([]);
      }
    });
  });

  context.connection.onHover((params: HoverParams) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.hover', positionRequestDetails(params, document), () => {
      if (document === undefined) {
        return null;
      }

      try {
        const analysis = analyzeForInteractiveRequest(context, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        const hover = getHover({
          analysis,
          position: params.position,
          workspaceIndex: context.analyzer
        });
        return hover === null ? null : toLspHover(hover);
      } catch (error: unknown) {
        context.logger.error(`Hover failed: ${getErrorMessage(error)}`);
        return null;
      }
    });
  });

  context.connection.onCompletion((params: CompletionParams) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.completion', positionRequestDetails(params, document), () => {
      if (document === undefined) {
        return [];
      }

      try {
        const text = document.getText();
        const analysis = analyzeForInteractiveRequest(context, {
          uri: document.uri,
          version: document.version,
          text
        });
        return getCompletions({
          analysis,
          text,
          position: params.position,
          workspaceIndex: context.analyzer
        }).map(toLspCompletionItem);
      } catch (error: unknown) {
        context.logger.error(`Completion failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  });

  context.connection.onDefinition((params: DefinitionParams) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.definition', positionRequestDetails(params, document), () => {
      if (document === undefined) {
        return [];
      }

      try {
        const analysis = analyzeForInteractiveRequest(context, {
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
        context.logger.error(`Definition failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  });

  context.connection.onReferences((params: ReferenceParams) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.references', {
      ...positionRequestDetails(params, document),
      includeDeclaration: params.context.includeDeclaration
    }, () => {
      if (document === undefined) {
        return [];
      }

      try {
        const analysis = analyzeForInteractiveRequest(context, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        return toLspReferenceLocations(getReferences({
          analysis,
          position: params.position,
          includeDeclaration: params.context.includeDeclaration,
          workspaceIndex: context.analyzer
        }));
      } catch (error: unknown) {
        context.logger.error(`References failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  });

  const refactorConnection = context.connection as RefactorHandlerConnection;

  refactorConnection.onPrepareRename?.((params: PrepareRenameParams) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.prepareRename', positionRequestDetails(params, document), () => {
      if (document === undefined) {
        return null;
      }

      try {
        const analysis = analyzeForInteractiveRequest(context, {
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
        context.logger.error(`Prepare rename failed: ${getErrorMessage(error)}`);
        return null;
      }
    });
  });

  refactorConnection.onRenameRequest?.((params: RenameParams) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.rename', {
      ...positionRequestDetails(params, document),
      newNameLength: params.newName.length
    }, () => {
      if (document === undefined) {
        return null;
      }

      try {
        const analysis = analyzeForInteractiveRequest(context, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        const result = getRenameEdits({
          analysis,
          position: params.position,
          newName: params.newName,
          workspaceIndex: context.analyzer
        });
        return 'reason' in result ? null : toLspWorkspaceEdit(result);
      } catch (error: unknown) {
        context.logger.error(`Rename failed: ${getErrorMessage(error)}`);
        return null;
      }
    });
  });

  refactorConnection.onCodeAction?.((params: CodeActionParams) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.codeAction', rangeRequestDetails(params, document), () => {
      if (document === undefined) {
        return [];
      }

      try {
        const analysis = analyzeForInteractiveRequest(context, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        return toLspCodeActions(getCodeActions({
          analysis,
          range: params.range,
          diagnostics: analysis.diagnostics,
          workspaceIndex: context.analyzer
        }));
      } catch (error: unknown) {
        context.logger.error(`Code action failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  });

  const formattingConnection = context.connection as FormattingHandlerConnection;

  formattingConnection.onDocumentFormatting?.((params: DocumentFormattingParams) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.formatting', {
      ...documentRequestDetails(params, document),
      insertSpaces: Boolean(params.options.insertSpaces),
      tabSize: params.options.tabSize
    }, () => {
      if (document === undefined) {
        return [];
      }

      try {
        return toLspTextEdits(getFormattingEdits({
          text: document.getText(),
          options: {
            insertSpaces: Boolean(params.options.insertSpaces),
            tabSize: params.options.tabSize
          }
        }));
      } catch (error: unknown) {
        context.logger.error(`Formatting failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  });

  formattingConnection.onDocumentRangeFormatting?.((params: DocumentRangeFormattingParams) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.rangeFormatting', {
      ...rangeRequestDetails(params, document),
      insertSpaces: Boolean(params.options.insertSpaces),
      tabSize: params.options.tabSize
    }, () => {
      if (document === undefined) {
        return [];
      }

      try {
        return toLspTextEdits(getFormattingEdits({
          text: document.getText(),
          options: {
            insertSpaces: Boolean(params.options.insertSpaces),
            tabSize: params.options.tabSize
          },
          range: params.range
        }));
      } catch (error: unknown) {
        context.logger.error(`Range formatting failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  });

  context.connection.onSignatureHelp((params: SignatureHelpParams) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.signatureHelp', positionRequestDetails(params, document), () => {
      if (document === undefined) {
        return null;
      }

      try {
        const text = document.getText();
        const analysis = analyzeForInteractiveRequest(context, {
          uri: document.uri,
          version: document.version,
          text
        });
        const signatureHelp = getSignatureHelp({
          analysis,
          text,
          position: params.position,
          workspaceIndex: context.analyzer
        });
        return signatureHelp === null ? null : toLspSignatureHelp(signatureHelp);
      } catch (error: unknown) {
        context.logger.error(`Signature help failed: ${getErrorMessage(error)}`);
        return null;
      }
    });
  });

  context.connection.onDocumentSymbol((params: DocumentSymbolParams) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.documentSymbol', documentRequestDetails(params, document), () => {
      if (document === undefined) {
        return [];
      }

      try {
        const analysis = analyzeForInteractiveRequest(context, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        return analysis.symbols.map(toLspDocumentSymbol);
      } catch (error: unknown) {
        context.logger.error(`Document symbols failed: ${getErrorMessage(error)}`);
        return [];
      }
    });
  });

  context.connection.languages.semanticTokens.on((params: SemanticTokensParams) => {
    const document = context.documents.get(params.textDocument.uri);
    return measureLspRequest(context, 'lsp.semanticTokens', documentRequestDetails(params, document), () => {
      if (document === undefined) {
        return toLspSemanticTokens([]);
      }

      try {
        const analysis = analyzeForInteractiveRequest(context, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        return toLspSemanticTokens(collectSemanticTokens(
          analysis,
          context.analyzer.semanticTokenWorkspaceIndex?.(document.uri) ?? context.analyzer
        ));
      } catch (error: unknown) {
        context.logger.error(`Semantic tokens failed: ${getErrorMessage(error)}`);
        return toLspSemanticTokens([]);
      }
    });
  });
}

function registerWatchedFileHandlers(context: HandlerRegistrationContext): void {
  context.connection.onDidChangeWatchedFiles((event) => {
    for (const change of event.changes) {
      context.analyzer.invalidateUri?.(change.uri);
    }
  });
}

function registerDocumentLifecycleHandlers(context: HandlerRegistrationContext): void {
  context.documents.onDidOpen((event) => {
    indexDocument(context, event.document);
  });

  context.documents.onDidChangeContent((event) => {
    indexDocument(context, event.document);
  });

  context.documents.onDidClose((event) => {
    context.analyzer.deleteDocument?.(event.document.uri);
  });
}

function indexDocument(context: HandlerRegistrationContext, document: TextDocument): void {
  try {
    const analysis = analyzeForInteractiveRequest(context, {
      uri: document.uri,
      version: document.version,
      text: document.getText()
    });
    sendInactiveRanges(context, analysis);
  } catch (error: unknown) {
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
    context.connection.languages.semanticTokens.refresh();
  });
}

function analyzeForInteractiveRequest(
  context: HandlerRegistrationContext,
  input: AnalyzeDocumentInput
): AnalyzedDocument {
  return context.analyzer.analyzeForegroundDocument?.(input)
    ?? context.analyzer.analyzeDocument(input);
}

type LogDetails = Record<string, string | number | boolean | undefined>;

function measureLspRequest<T>(
  context: HandlerRegistrationContext,
  operation: string,
  details: LogDetails,
  work: () => T
): T {
  return measureDurationMs(toAnalysisLogger(context.logger), operation, details, work);
}

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

function toAnalysisLogger(logger: ServerLogger): { info(message: string): void; error(message: string): void } {
  return {
    info: logger.info?.bind(logger) ?? (() => undefined),
    error: logger.error.bind(logger)
  };
}
