"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInitializeResult = createInitializeResult;
const node_1 = require("vscode-languageserver/node");
const semanticTokens_1 = require("./semanticTokens");
const COMPLETION_TRIGGER_CHARACTERS = [
    '.',
    ':',
    '"',
    '<',
    '#',
    '/',
    '>',
    '_',
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
];
function createInitializeResult() {
    return {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
            hoverProvider: true,
            completionProvider: {
                triggerCharacters: COMPLETION_TRIGGER_CHARACTERS
            },
            signatureHelpProvider: {
                triggerCharacters: ['(', ',']
            },
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: {
                prepareProvider: true
            },
            codeActionProvider: {
                codeActionKinds: [node_1.CodeActionKind.QuickFix]
            },
            documentFormattingProvider: true,
            documentRangeFormattingProvider: true,
            documentSymbolProvider: true,
            semanticTokensProvider: {
                legend: semanticTokens_1.SEMANTIC_TOKEN_LEGEND,
                full: true
            },
            diagnosticProvider: {
                interFileDependencies: false,
                workspaceDiagnostics: false
            }
        }
    };
}
//# sourceMappingURL=capabilities.js.map