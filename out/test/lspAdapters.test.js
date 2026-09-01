"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const node_1 = require("vscode-languageserver/node");
const capabilities_1 = require("../lsp/capabilities");
const completion_1 = require("../lsp/completion");
const diagnostics_1 = require("../lsp/diagnostics");
const documentSymbols_1 = require("../lsp/documentSymbols");
const navigation_1 = require("../lsp/navigation");
const codeActions_1 = require("../lsp/codeActions");
const rename_1 = require("../lsp/rename");
const signatureHelp_1 = require("../lsp/signatureHelp");
const formatting_1 = require("../lsp/formatting");
const semanticTokens_1 = require("../lsp/semanticTokens");
suite('LSP adapters', () => {
    test('advertises the hover capability', () => {
        const result = (0, capabilities_1.createInitializeResult)();
        assert.strictEqual(result.capabilities.textDocumentSync, node_1.TextDocumentSyncKind.Incremental);
        assert.strictEqual(result.capabilities.documentSymbolProvider, true);
        const triggerCharacters = result.capabilities.completionProvider?.triggerCharacters ?? [];
        assert.ok(triggerCharacters.includes('p'));
        assert.ok(triggerCharacters.includes('r'));
        assert.ok(triggerCharacters.includes('_'));
        assert.ok(triggerCharacters.includes('/'));
        assert.ok(triggerCharacters.includes('>'));
        assert.deepStrictEqual(result.capabilities.diagnosticProvider, {
            interFileDependencies: false,
            workspaceDiagnostics: false
        });
        assert.strictEqual(result.capabilities.hoverProvider, true);
        assert.strictEqual(result.capabilities.definitionProvider, true);
        assert.strictEqual(result.capabilities.referencesProvider, true);
        assert.deepStrictEqual(result.capabilities.renameProvider, {
            prepareProvider: true
        });
        assert.deepStrictEqual(result.capabilities.codeActionProvider, {
            codeActionKinds: [node_1.CodeActionKind.QuickFix]
        });
        assert.strictEqual(result.capabilities.documentFormattingProvider, true);
        assert.strictEqual(result.capabilities.documentRangeFormattingProvider, true);
        assert.deepStrictEqual(result.capabilities.signatureHelpProvider, {
            triggerCharacters: ['(', ',']
        });
        assert.deepStrictEqual(result.capabilities.semanticTokensProvider, {
            legend: semanticTokens_1.SEMANTIC_TOKEN_LEGEND,
            full: true
        });
        assert.ok(semanticTokens_1.SEMANTIC_TOKEN_LEGEND.tokenTypes.includes(node_1.SemanticTokenTypes.function));
        assert.ok(semanticTokens_1.SEMANTIC_TOKEN_LEGEND.tokenModifiers.includes(node_1.SemanticTokenModifiers.declaration));
    });
    test('converts analyzer completions to LSP completions', () => {
        const completion = {
            name: 'printf',
            kind: 'function',
            detail: 'int printf(string format, ...)',
            documentation: 'AXEL standard library output function.'
        };
        const lsp = (0, completion_1.toLspCompletionItem)(completion);
        assert.strictEqual(lsp.label, 'printf');
        assert.strictEqual(lsp.kind, node_1.CompletionItemKind.Function);
        assert.strictEqual(lsp.detail, 'int printf(string format, ...)');
        assert.strictEqual(lsp.documentation, 'AXEL standard library output function.');
    });
    test('converts analyzer signature help to LSP signature help', () => {
        const signatureHelp = {
            signatures: [{
                    label: 'void foo(int count, string name)',
                    parameters: [
                        { label: 'int count' },
                        { label: 'string name' }
                    ]
                }],
            activeSignature: 0,
            activeParameter: 1
        };
        const lsp = (0, signatureHelp_1.toLspSignatureHelp)(signatureHelp);
        assert.deepStrictEqual(lsp, {
            signatures: [{
                    label: 'void foo(int count, string name)',
                    parameters: [
                        { label: 'int count' },
                        { label: 'string name' }
                    ]
                }],
            activeSignature: 0,
            activeParameter: 1
        });
    });
    test('preserves include path completion insertion metadata', () => {
        const completion = {
            name: 'button.h',
            kind: 'include',
            detail: 'include path: ui/',
            insertText: 'button.h',
            filterText: 'ui/button.h',
            sortText: 'ui/button.h'
        };
        const lsp = (0, completion_1.toLspCompletionItem)(completion);
        assert.strictEqual(lsp.label, 'button.h');
        assert.strictEqual(lsp.kind, node_1.CompletionItemKind.File);
        assert.strictEqual(lsp.detail, 'include path: ui/');
        assert.strictEqual(lsp.insertText, 'button.h');
        assert.strictEqual(lsp.filterText, 'ui/button.h');
        assert.strictEqual(lsp.sortText, 'ui/button.h');
    });
    test('converts analyzer diagnostics to LSP diagnostics', () => {
        const diagnostic = {
            severity: 'error',
            source: 'axel',
            message: 'Syntax error.',
            range: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 4 }
            }
        };
        const lsp = (0, diagnostics_1.toLspDiagnostic)(diagnostic);
        assert.strictEqual(lsp.severity, node_1.DiagnosticSeverity.Error);
        assert.strictEqual(lsp.source, 'axel');
        assert.strictEqual(lsp.message, 'Syntax error.');
    });
    test('converts analyzer warnings to LSP warning diagnostics', () => {
        const diagnostic = {
            severity: 'warning',
            source: 'axel',
            message: 'Warning.',
            range: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 4 }
            }
        };
        const lsp = (0, diagnostics_1.toLspDiagnostic)(diagnostic);
        assert.strictEqual(lsp.severity, node_1.DiagnosticSeverity.Warning);
    });
    test('wraps diagnostics in a full document diagnostic report', () => {
        const report = (0, diagnostics_1.toDocumentDiagnosticReport)([]);
        assert.strictEqual(report.kind, node_1.DocumentDiagnosticReportKind.Full);
        assert.deepStrictEqual(report.items, []);
    });
    test('converts analyzer symbols to LSP document symbols', () => {
        const symbol = {
            name: 'main',
            kind: 'function',
            detail: 'function',
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 14 }
            },
            selectionRange: {
                start: { line: 0, character: 5 },
                end: { line: 0, character: 9 }
            }
        };
        const lsp = (0, documentSymbols_1.toLspDocumentSymbol)(symbol);
        assert.strictEqual(lsp.name, 'main');
        assert.strictEqual(lsp.kind, node_1.SymbolKind.Function);
        assert.strictEqual(lsp.detail, 'function');
    });
    test('converts enum member analyzer symbols to LSP enum members', () => {
        const symbol = {
            name: 'A',
            kind: 'enumMember',
            detail: 'enum Mode::A',
            range: {
                start: { line: 0, character: 12 },
                end: { line: 0, character: 13 }
            },
            selectionRange: {
                start: { line: 0, character: 12 },
                end: { line: 0, character: 13 }
            }
        };
        const lsp = (0, documentSymbols_1.toLspDocumentSymbol)(symbol);
        assert.strictEqual(lsp.name, 'A');
        assert.strictEqual(lsp.kind, node_1.SymbolKind.EnumMember);
        assert.strictEqual(lsp.detail, 'enum Mode::A');
    });
    test('converts analyzer locations to LSP locations', () => {
        const locations = (0, navigation_1.toLspLocations)([{
                uri: 'file:///main.axl',
                range: {
                    start: { line: 1, character: 2 },
                    end: { line: 1, character: 6 }
                }
            }]);
        assert.deepStrictEqual(locations, [
            node_1.Location.create('file:///main.axl', {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 6 }
            })
        ]);
    });
    test('converts analyzer text edits to LSP text edits', () => {
        const edits = (0, formatting_1.toLspTextEdits)([{
                range: {
                    start: { line: 1, character: 0 },
                    end: { line: 1, character: 2 }
                },
                newText: '    '
            }]);
        assert.deepStrictEqual(edits, [{
                range: {
                    start: { line: 1, character: 0 },
                    end: { line: 1, character: 2 }
                },
                newText: '    '
            }]);
    });
    test('converts analyzer workspace edits to LSP workspace edits', () => {
        const edit = (0, rename_1.toLspWorkspaceEdit)({
            changes: {
                'file:///main.axl': [{
                        range: {
                            start: { line: 1, character: 2 },
                            end: { line: 1, character: 7 }
                        },
                        newText: 'renamed'
                    }]
            }
        });
        assert.deepStrictEqual(edit, {
            changes: {
                'file:///main.axl': [{
                        range: {
                            start: { line: 1, character: 2 },
                            end: { line: 1, character: 7 }
                        },
                        newText: 'renamed'
                    }]
            }
        });
    });
    test('converts analyzer code actions to LSP code actions', () => {
        const diagnostic = {
            severity: 'error',
            source: 'axel',
            message: "Unknown type 'Widget'.",
            range: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 6 }
            }
        };
        const action = {
            title: 'Add include "types.h"',
            kind: 'quickfix',
            diagnostics: [diagnostic],
            edit: {
                changes: {
                    'file:///main.axl': [{
                            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                            newText: '#include "types.h"\n'
                        }]
                }
            }
        };
        assert.deepStrictEqual((0, codeActions_1.toLspCodeActions)([action]), [{
                title: 'Add include "types.h"',
                kind: node_1.CodeActionKind.QuickFix,
                diagnostics: [(0, diagnostics_1.toLspDiagnostic)(diagnostic)],
                edit: (0, rename_1.toLspWorkspaceEdit)(action.edit)
            }]);
    });
    test('encodes semantic tokens with relative position deltas', () => {
        const tokens = [
            semanticToken(1, 4, 8, 'function', ['declaration']),
            semanticToken(2, 2, 7, 'variable', []),
            semanticToken(2, 12, 16, 'macro', [])
        ];
        const lsp = (0, semanticTokens_1.toLspSemanticTokens)(tokens);
        assert.deepStrictEqual(lsp.data, [
            1, 4, 4, semanticTokens_1.SEMANTIC_TOKEN_LEGEND.tokenTypes.indexOf('function'), 1,
            1, 2, 5, semanticTokens_1.SEMANTIC_TOKEN_LEGEND.tokenTypes.indexOf('variable'), 0,
            0, 10, 4, semanticTokens_1.SEMANTIC_TOKEN_LEGEND.tokenTypes.indexOf('macro'), 0
        ]);
    });
});
function semanticToken(line, startCharacter, endCharacter, tokenType, modifiers) {
    return {
        range: {
            start: { line, character: startCharacter },
            end: { line, character: endCharacter }
        },
        tokenType,
        modifiers
    };
}
//# sourceMappingURL=lspAdapters.test.js.map