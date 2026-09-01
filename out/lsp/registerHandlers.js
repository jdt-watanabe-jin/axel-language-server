"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerHandlers = registerHandlers;
const codeActions_1 = require("../analyzer/codeActions");
const completion_1 = require("../analyzer/completion");
const formatting_1 = require("../analyzer/formatting");
const hover_1 = require("../analyzer/hover");
const navigation_1 = require("../analyzer/navigation");
const rename_1 = require("../analyzer/rename");
const signatureHelp_1 = require("../analyzer/signatureHelp");
const semanticTokens_1 = require("../analyzer/semanticTokens");
const logger_1 = require("../util/logger");
const capabilities_1 = require("./capabilities");
const codeActions_2 = require("./codeActions");
const completion_2 = require("./completion");
const definition_1 = require("./definition");
const diagnostics_1 = require("./diagnostics");
const documentSymbols_1 = require("./documentSymbols");
const formatting_2 = require("./formatting");
const hover_2 = require("./hover");
const references_1 = require("./references");
const rename_2 = require("./rename");
const semanticTokens_2 = require("./semanticTokens");
const signatureHelp_2 = require("./signatureHelp");
function registerHandlers(context) {
    context.connection.onInitialize((params) => {
        context.analyzer.configure?.(params.initializationOptions);
        return (0, capabilities_1.createInitializeResult)();
    });
    registerDocumentLifecycleHandlers(context);
    registerWatchedFileHandlers(context);
    registerBackgroundRefreshHandlers(context);
    context.connection.languages.diagnostics.on((params) => {
        const document = context.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return (0, diagnostics_1.toDocumentDiagnosticReport)([]);
        }
        try {
            const analysis = analyzeForInteractiveRequest(context, {
                uri: document.uri,
                version: document.version,
                text: document.getText()
            });
            return (0, diagnostics_1.toDocumentDiagnosticReport)(analysis.diagnostics);
        }
        catch (error) {
            context.logger.error(`Diagnostics failed: ${getErrorMessage(error)}`);
            return (0, diagnostics_1.toDocumentDiagnosticReport)([]);
        }
    });
    context.connection.onHover((params) => {
        const document = context.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return null;
        }
        try {
            const analysis = analyzeForInteractiveRequest(context, {
                uri: document.uri,
                version: document.version,
                text: document.getText()
            });
            const hover = (0, hover_1.getHover)({
                analysis,
                position: params.position,
                workspaceIndex: context.analyzer
            });
            return hover === null ? null : (0, hover_2.toLspHover)(hover);
        }
        catch (error) {
            context.logger.error(`Hover failed: ${getErrorMessage(error)}`);
            return null;
        }
    });
    context.connection.onCompletion((params) => {
        const document = context.documents.get(params.textDocument.uri);
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
            return (0, completion_1.getCompletions)({
                analysis,
                text,
                position: params.position,
                workspaceIndex: context.analyzer
            }).map(completion_2.toLspCompletionItem);
        }
        catch (error) {
            context.logger.error(`Completion failed: ${getErrorMessage(error)}`);
            return [];
        }
    });
    context.connection.onDefinition((params) => {
        const document = context.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return [];
        }
        try {
            const analysis = analyzeForInteractiveRequest(context, {
                uri: document.uri,
                version: document.version,
                text: document.getText()
            });
            return (0, definition_1.toLspDefinitionLocations)((0, navigation_1.getDefinitions)({
                analysis,
                position: params.position,
                workspaceIndex: context.analyzer
            }));
        }
        catch (error) {
            context.logger.error(`Definition failed: ${getErrorMessage(error)}`);
            return [];
        }
    });
    context.connection.onReferences((params) => {
        const document = context.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return [];
        }
        try {
            const analysis = analyzeForInteractiveRequest(context, {
                uri: document.uri,
                version: document.version,
                text: document.getText()
            });
            return (0, references_1.toLspReferenceLocations)((0, navigation_1.getReferences)({
                analysis,
                position: params.position,
                includeDeclaration: params.context.includeDeclaration,
                workspaceIndex: context.analyzer
            }));
        }
        catch (error) {
            context.logger.error(`References failed: ${getErrorMessage(error)}`);
            return [];
        }
    });
    const refactorConnection = context.connection;
    refactorConnection.onPrepareRename?.((params) => {
        const document = context.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return null;
        }
        try {
            const analysis = analyzeForInteractiveRequest(context, {
                uri: document.uri,
                version: document.version,
                text: document.getText()
            });
            return (0, rename_1.prepareRename)({
                analysis,
                position: params.position,
                workspaceIndex: context.analyzer
            });
        }
        catch (error) {
            context.logger.error(`Prepare rename failed: ${getErrorMessage(error)}`);
            return null;
        }
    });
    refactorConnection.onRenameRequest?.((params) => {
        const document = context.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return null;
        }
        try {
            const analysis = analyzeForInteractiveRequest(context, {
                uri: document.uri,
                version: document.version,
                text: document.getText()
            });
            const result = (0, rename_1.getRenameEdits)({
                analysis,
                position: params.position,
                newName: params.newName,
                workspaceIndex: context.analyzer
            });
            return 'reason' in result ? null : (0, rename_2.toLspWorkspaceEdit)(result);
        }
        catch (error) {
            context.logger.error(`Rename failed: ${getErrorMessage(error)}`);
            return null;
        }
    });
    refactorConnection.onCodeAction?.((params) => {
        const document = context.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return [];
        }
        try {
            const analysis = analyzeForInteractiveRequest(context, {
                uri: document.uri,
                version: document.version,
                text: document.getText()
            });
            return (0, codeActions_2.toLspCodeActions)((0, codeActions_1.getCodeActions)({
                analysis,
                range: params.range,
                diagnostics: analysis.diagnostics,
                workspaceIndex: context.analyzer
            }));
        }
        catch (error) {
            context.logger.error(`Code action failed: ${getErrorMessage(error)}`);
            return [];
        }
    });
    const formattingConnection = context.connection;
    formattingConnection.onDocumentFormatting?.((params) => {
        const document = context.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return [];
        }
        try {
            return (0, formatting_2.toLspTextEdits)((0, formatting_1.getFormattingEdits)({
                text: document.getText(),
                options: {
                    insertSpaces: Boolean(params.options.insertSpaces),
                    tabSize: params.options.tabSize
                }
            }));
        }
        catch (error) {
            context.logger.error(`Formatting failed: ${getErrorMessage(error)}`);
            return [];
        }
    });
    formattingConnection.onDocumentRangeFormatting?.((params) => {
        const document = context.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return [];
        }
        try {
            return (0, formatting_2.toLspTextEdits)((0, formatting_1.getFormattingEdits)({
                text: document.getText(),
                options: {
                    insertSpaces: Boolean(params.options.insertSpaces),
                    tabSize: params.options.tabSize
                },
                range: params.range
            }));
        }
        catch (error) {
            context.logger.error(`Range formatting failed: ${getErrorMessage(error)}`);
            return [];
        }
    });
    context.connection.onSignatureHelp((params) => {
        const document = context.documents.get(params.textDocument.uri);
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
            const signatureHelp = (0, signatureHelp_1.getSignatureHelp)({
                analysis,
                text,
                position: params.position,
                workspaceIndex: context.analyzer
            });
            return signatureHelp === null ? null : (0, signatureHelp_2.toLspSignatureHelp)(signatureHelp);
        }
        catch (error) {
            context.logger.error(`Signature help failed: ${getErrorMessage(error)}`);
            return null;
        }
    });
    context.connection.onDocumentSymbol((params) => {
        const document = context.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return [];
        }
        try {
            const analysis = analyzeForInteractiveRequest(context, {
                uri: document.uri,
                version: document.version,
                text: document.getText()
            });
            return analysis.symbols.map(documentSymbols_1.toLspDocumentSymbol);
        }
        catch (error) {
            context.logger.error(`Document symbols failed: ${getErrorMessage(error)}`);
            return [];
        }
    });
    context.connection.languages.semanticTokens.on((params) => {
        const document = context.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return (0, semanticTokens_2.toLspSemanticTokens)([]);
        }
        return (0, logger_1.measureDurationMs)(toAnalysisLogger(context.logger), 'lsp.semanticTokens', { uri: document.uri }, () => {
            try {
                const analysis = analyzeForInteractiveRequest(context, {
                    uri: document.uri,
                    version: document.version,
                    text: document.getText()
                });
                return (0, semanticTokens_2.toLspSemanticTokens)((0, semanticTokens_1.collectSemanticTokens)(analysis, context.analyzer.semanticTokenWorkspaceIndex?.(document.uri) ?? context.analyzer));
            }
            catch (error) {
                context.logger.error(`Semantic tokens failed: ${getErrorMessage(error)}`);
                return (0, semanticTokens_2.toLspSemanticTokens)([]);
            }
        });
    });
}
function registerWatchedFileHandlers(context) {
    context.connection.onDidChangeWatchedFiles((event) => {
        for (const change of event.changes) {
            context.analyzer.invalidateUri?.(change.uri);
        }
    });
}
function registerDocumentLifecycleHandlers(context) {
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
function indexDocument(context, document) {
    try {
        analyzeForInteractiveRequest(context, {
            uri: document.uri,
            version: document.version,
            text: document.getText()
        });
    }
    catch (error) {
        context.logger.error(`Workspace indexing failed: ${getErrorMessage(error)}`);
    }
}
function getErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
function registerBackgroundRefreshHandlers(context) {
    context.analyzer.onBackgroundIndexingComplete?.(() => {
        context.connection.languages.semanticTokens.refresh();
    });
}
function analyzeForInteractiveRequest(context, input) {
    return context.analyzer.analyzeForegroundDocument?.(input)
        ?? context.analyzer.analyzeDocument(input);
}
function toAnalysisLogger(logger) {
    return {
        info: logger.info?.bind(logger) ?? (() => undefined),
        error: logger.error.bind(logger)
    };
}
//# sourceMappingURL=registerHandlers.js.map