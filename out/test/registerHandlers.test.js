"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const registerHandlers_1 = require("../lsp/registerHandlers");
suite('registerHandlers', () => {
    test('registers initialize, diagnostics, hover, completion, rename, code action, formatting, signature help, semantic tokens, document symbol, document lifecycle, and watched file handlers', () => {
        const calls = [];
        const connection = {
            onInitialize: () => calls.push('initialize'),
            onDidChangeWatchedFiles: () => calls.push('watchedFiles'),
            languages: {
                diagnostics: {
                    on: () => calls.push('diagnostics')
                },
                semanticTokens: {
                    on: () => calls.push('semanticTokens')
                }
            },
            onHover: () => calls.push('hover'),
            onCompletion: () => calls.push('completion'),
            onDefinition: () => calls.push('definition'),
            onReferences: () => calls.push('references'),
            onPrepareRename: () => calls.push('prepareRename'),
            onRenameRequest: () => calls.push('rename'),
            onCodeAction: () => calls.push('codeAction'),
            onDocumentFormatting: () => calls.push('documentFormatting'),
            onDocumentRangeFormatting: () => calls.push('documentRangeFormatting'),
            onSignatureHelp: () => calls.push('signatureHelp'),
            onDocumentSymbol: () => calls.push('documentSymbol'),
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => undefined,
            onDidOpen: () => calls.push('open'),
            onDidChangeContent: () => calls.push('change'),
            onDidClose: () => calls.push('close')
        };
        const analyzer = {
            analyzeDocument: () => ({
                uri: 'file:///missing.axl',
                version: 0,
                diagnostics: [],
                symbols: [],
                declarations: [],
                references: [],
                scopes: [],
                includes: [],
                scriptExecutions: [],
                guiClasses: [],
                guiMethods: []
            })
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger: { error: () => undefined }
        });
        assert.deepStrictEqual(calls.sort(), [
            'change',
            'close',
            'codeAction',
            'completion',
            'definition',
            'diagnostics',
            'documentFormatting',
            'documentRangeFormatting',
            'documentSymbol',
            'hover',
            'initialize',
            'open',
            'prepareRename',
            'references',
            'rename',
            'semanticTokens',
            'signatureHelp',
            'watchedFiles'
        ]);
    });
    test('indexes opened and changed documents through foreground analysis when available', () => {
        const indexedTexts = [];
        let openHandler;
        let changeHandler;
        const connection = {
            onInitialize: () => undefined,
            onDidChangeWatchedFiles: () => undefined,
            languages: {
                diagnostics: {
                    on: () => undefined
                },
                semanticTokens: {
                    on: () => undefined
                }
            },
            onHover: () => undefined,
            onCompletion: () => undefined,
            onDefinition: () => undefined,
            onReferences: () => undefined,
            onPrepareRename: () => undefined,
            onRenameRequest: () => undefined,
            onCodeAction: () => undefined,
            onSignatureHelp: () => undefined,
            onDocumentSymbol: () => undefined,
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => undefined,
            onDidOpen: (handler) => {
                openHandler = handler;
            },
            onDidChangeContent: (handler) => {
                changeHandler = handler;
            },
            onDidClose: () => undefined
        };
        const analyzer = {
            analyzeDocument: () => ({
                uri: 'file:///missing.axl',
                version: 0,
                diagnostics: [],
                symbols: [],
                declarations: [],
                references: [],
                scopes: [],
                includes: [],
                scriptExecutions: [],
                guiClasses: [],
                guiMethods: []
            }),
            analyzeForegroundDocument: (input) => {
                indexedTexts.push(input.text);
                return {
                    uri: 'file:///main.axl',
                    version: 1,
                    diagnostics: [],
                    symbols: [],
                    declarations: [],
                    references: [],
                    scopes: [],
                    includes: [],
                    scriptExecutions: [],
                    guiClasses: [],
                    guiMethods: []
                };
            },
            indexOpenDocument: (_input) => {
                return {
                    uri: 'file:///main.axl',
                    version: 1,
                    diagnostics: [],
                    symbols: [],
                    declarations: [],
                    references: [],
                    scopes: [],
                    includes: [],
                    scriptExecutions: [],
                    guiClasses: [],
                    guiMethods: []
                };
            }
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger: { error: () => undefined }
        });
        openHandler?.({ document: createTestDocument('int opened;') });
        changeHandler?.({ document: createTestDocument('int changed;') });
        assert.deepStrictEqual(indexedTexts, ['int opened;', 'int changed;']);
    });
    test('uses foreground analysis for opened documents and semantic tokens', () => {
        const calls = [];
        let openHandler;
        let semanticTokensHandler;
        const connection = {
            onInitialize: () => undefined,
            onDidChangeWatchedFiles: () => undefined,
            languages: {
                diagnostics: {
                    on: () => undefined
                },
                semanticTokens: {
                    on: (handler) => {
                        semanticTokensHandler = handler;
                    }
                }
            },
            onHover: () => undefined,
            onCompletion: () => undefined,
            onDefinition: () => undefined,
            onReferences: () => undefined,
            onPrepareRename: () => undefined,
            onRenameRequest: () => undefined,
            onCodeAction: () => undefined,
            onSignatureHelp: () => undefined,
            onDocumentSymbol: () => undefined,
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => createTestDocument('int value;'),
            onDidOpen: (handler) => {
                openHandler = handler;
            },
            onDidChangeContent: () => undefined,
            onDidClose: () => undefined
        };
        const analyzer = {
            analyzeDocument: () => {
                calls.push('full');
                throw new Error('full indexing should not run');
            },
            analyzeForegroundDocument: () => {
                calls.push('foreground');
                return {
                    uri: 'file:///main.axl',
                    version: 1,
                    diagnostics: [],
                    symbols: [],
                    declarations: [],
                    references: [],
                    scopes: [],
                    includes: [],
                    scriptExecutions: [],
                    guiClasses: [],
                    guiMethods: []
                };
            }
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger: { error: () => undefined }
        });
        openHandler?.({ document: createTestDocument('int opened;') });
        const result = semanticTokensHandler?.({
            textDocument: { uri: 'file:///main.axl' }
        });
        assert.deepStrictEqual(result, { data: [] });
        assert.deepStrictEqual(calls, ['foreground', 'foreground']);
    });
    test('invalidates watched files through the workspace index', () => {
        const invalidatedUris = [];
        let watchedFilesHandler;
        const connection = {
            onInitialize: () => undefined,
            onDidChangeWatchedFiles: (handler) => {
                watchedFilesHandler = handler;
            },
            languages: {
                diagnostics: {
                    on: () => undefined
                },
                semanticTokens: {
                    on: () => undefined
                }
            },
            onHover: () => undefined,
            onCompletion: () => undefined,
            onDefinition: () => undefined,
            onReferences: () => undefined,
            onPrepareRename: () => undefined,
            onRenameRequest: () => undefined,
            onCodeAction: () => undefined,
            onSignatureHelp: () => undefined,
            onDocumentSymbol: () => undefined,
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => undefined,
            onDidOpen: () => undefined,
            onDidChangeContent: () => undefined,
            onDidClose: () => undefined
        };
        const analyzer = {
            analyzeDocument: () => ({
                uri: 'file:///missing.axl',
                version: 0,
                diagnostics: [],
                symbols: [],
                declarations: [],
                references: [],
                scopes: [],
                includes: [],
                scriptExecutions: [],
                guiClasses: [],
                guiMethods: []
            }),
            invalidateUri: (uri) => {
                invalidatedUris.push(uri);
            }
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger: { error: () => undefined }
        });
        watchedFilesHandler?.({ changes: [{ uri: 'file:///types.h' }] });
        assert.deepStrictEqual(invalidatedUris, ['file:///types.h']);
    });
    test('applies workspace index options from initialization options', () => {
        let initializeHandler;
        let configuredOptions;
        const connection = {
            onInitialize: (handler) => {
                initializeHandler = handler;
            },
            onDidChangeWatchedFiles: () => undefined,
            languages: {
                diagnostics: {
                    on: () => undefined
                },
                semanticTokens: {
                    on: () => undefined
                }
            },
            onHover: () => undefined,
            onCompletion: () => undefined,
            onDefinition: () => undefined,
            onReferences: () => undefined,
            onPrepareRename: () => undefined,
            onRenameRequest: () => undefined,
            onCodeAction: () => undefined,
            onSignatureHelp: () => undefined,
            onDocumentSymbol: () => undefined,
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => undefined,
            onDidOpen: () => undefined,
            onDidChangeContent: () => undefined,
            onDidClose: () => undefined
        };
        const analyzer = {
            analyzeDocument: () => ({
                uri: 'file:///missing.axl',
                version: 0,
                diagnostics: [],
                symbols: [],
                declarations: [],
                references: [],
                scopes: [],
                includes: [],
                scriptExecutions: [],
                guiClasses: [],
                guiMethods: []
            }),
            configure: (options) => {
                configuredOptions = options;
            }
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger: { error: () => undefined }
        });
        initializeHandler?.({
            initializationOptions: {
                includeRoots: ['C:\\axel'],
                forcedIncludeRoots: ['C:\\forced']
            }
        });
        assert.deepStrictEqual(configuredOptions, {
            includeRoots: ['C:\\axel'],
            forcedIncludeRoots: ['C:\\forced']
        });
    });
    test('returns empty completion list when analysis fails', () => {
        let completionHandler;
        const errors = [];
        const connection = {
            onInitialize: () => undefined,
            onDidChangeWatchedFiles: () => undefined,
            languages: {
                diagnostics: {
                    on: () => undefined
                },
                semanticTokens: {
                    on: () => undefined
                }
            },
            onHover: () => undefined,
            onCompletion: (handler) => {
                completionHandler = handler;
            },
            onDefinition: () => undefined,
            onReferences: () => undefined,
            onPrepareRename: () => undefined,
            onRenameRequest: () => undefined,
            onCodeAction: () => undefined,
            onSignatureHelp: () => undefined,
            onDocumentSymbol: () => undefined,
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => createTestDocument('broken'),
            onDidOpen: () => undefined,
            onDidChangeContent: () => undefined,
            onDidClose: () => undefined
        };
        const analyzer = {
            analyzeDocument: () => {
                throw new Error('analysis exploded');
            }
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger: { error: (message) => errors.push(message) }
        });
        const result = completionHandler?.({
            textDocument: { uri: 'file:///main.axl' },
            position: { line: 0, character: 0 }
        });
        assert.deepStrictEqual(result, []);
        assert.deepStrictEqual(errors, ['Completion failed: analysis exploded']);
    });
    test('returns null signature help when analysis fails', () => {
        let signatureHelpHandler;
        const errors = [];
        const connection = {
            onInitialize: () => undefined,
            onDidChangeWatchedFiles: () => undefined,
            languages: {
                diagnostics: {
                    on: () => undefined
                },
                semanticTokens: {
                    on: () => undefined
                }
            },
            onHover: () => undefined,
            onCompletion: () => undefined,
            onDefinition: () => undefined,
            onReferences: () => undefined,
            onPrepareRename: () => undefined,
            onRenameRequest: () => undefined,
            onCodeAction: () => undefined,
            onSignatureHelp: (handler) => {
                signatureHelpHandler = handler;
            },
            onDocumentSymbol: () => undefined,
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => createTestDocument('broken'),
            onDidOpen: () => undefined,
            onDidChangeContent: () => undefined,
            onDidClose: () => undefined
        };
        const analyzer = {
            analyzeDocument: () => {
                throw new Error('analysis exploded');
            }
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger: { error: (message) => errors.push(message) }
        });
        const result = signatureHelpHandler?.({
            textDocument: { uri: 'file:///main.axl' },
            position: { line: 0, character: 0 }
        });
        assert.strictEqual(result, null);
        assert.deepStrictEqual(errors, ['Signature help failed: analysis exploded']);
    });
    test('returns formatting edits for document and range formatting requests', () => {
        let documentFormattingHandler;
        let rangeFormattingHandler;
        const connection = {
            onInitialize: () => undefined,
            onDidChangeWatchedFiles: () => undefined,
            languages: {
                diagnostics: {
                    on: () => undefined
                },
                semanticTokens: {
                    on: () => undefined
                }
            },
            onHover: () => undefined,
            onCompletion: () => undefined,
            onDefinition: () => undefined,
            onReferences: () => undefined,
            onPrepareRename: () => undefined,
            onRenameRequest: () => undefined,
            onCodeAction: () => undefined,
            onDocumentFormatting: (handler) => {
                documentFormattingHandler = handler;
            },
            onDocumentRangeFormatting: (handler) => {
                rangeFormattingHandler = handler;
            },
            onSignatureHelp: () => undefined,
            onDocumentSymbol: () => undefined,
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => createTestDocument([
                'void main() {',
                'int value;',
                '}',
                ''
            ].join('\n')),
            onDidOpen: () => undefined,
            onDidChangeContent: () => undefined,
            onDidClose: () => undefined
        };
        const analyzer = {
            analyzeDocument: () => ({
                uri: 'file:///main.axl',
                version: 1,
                diagnostics: [],
                symbols: [],
                declarations: [],
                references: [],
                scopes: [],
                includes: [],
                scriptExecutions: [],
                guiClasses: [],
                guiMethods: []
            })
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger: { error: () => undefined }
        });
        assert.deepStrictEqual(documentFormattingHandler?.({
            textDocument: { uri: 'file:///main.axl' },
            options: { insertSpaces: true, tabSize: 2 }
        }), [{
                range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
                newText: '  '
            }]);
        assert.deepStrictEqual(rangeFormattingHandler?.({
            textDocument: { uri: 'file:///main.axl' },
            options: { insertSpaces: true, tabSize: 2 },
            range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }
        }), [{
                range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
                newText: '  '
            }]);
    });
    test('returns empty semantic tokens when analysis fails', () => {
        let semanticTokensHandler;
        const errors = [];
        const connection = {
            onInitialize: () => undefined,
            onDidChangeWatchedFiles: () => undefined,
            languages: {
                diagnostics: {
                    on: () => undefined
                },
                semanticTokens: {
                    on: (handler) => {
                        semanticTokensHandler = handler;
                    }
                }
            },
            onHover: () => undefined,
            onCompletion: () => undefined,
            onDefinition: () => undefined,
            onReferences: () => undefined,
            onSignatureHelp: () => undefined,
            onDocumentSymbol: () => undefined,
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => createTestDocument('broken'),
            onDidOpen: () => undefined,
            onDidChangeContent: () => undefined,
            onDidClose: () => undefined
        };
        const analyzer = {
            analyzeDocument: () => {
                throw new Error('analysis exploded');
            }
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger: { error: (message) => errors.push(message) }
        });
        const result = semanticTokensHandler?.({
            textDocument: { uri: 'file:///main.axl' }
        });
        assert.deepStrictEqual(result, { data: [] });
        assert.deepStrictEqual(errors, ['Semantic tokens failed: analysis exploded']);
    });
    test('logs semantic token request timing when logger supports info', () => {
        let semanticTokensHandler;
        const infoMessages = [];
        const connection = {
            onInitialize: () => undefined,
            onDidChangeWatchedFiles: () => undefined,
            languages: {
                diagnostics: {
                    on: () => undefined
                },
                semanticTokens: {
                    on: (handler) => {
                        semanticTokensHandler = handler;
                    }
                }
            },
            onHover: () => undefined,
            onCompletion: () => undefined,
            onDefinition: () => undefined,
            onReferences: () => undefined,
            onSignatureHelp: () => undefined,
            onDocumentSymbol: () => undefined,
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => createTestDocument('int value;'),
            onDidOpen: () => undefined,
            onDidChangeContent: () => undefined,
            onDidClose: () => undefined
        };
        const analyzer = {
            analyzeDocument: () => ({
                uri: 'file:///main.axl',
                version: 1,
                diagnostics: [],
                symbols: [],
                declarations: [],
                references: [],
                scopes: [],
                includes: [],
                scriptExecutions: [],
                guiClasses: [],
                guiMethods: []
            })
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger: {
                info: (message) => infoMessages.push(message),
                error: () => undefined
            }
        });
        semanticTokensHandler?.({
            textDocument: { uri: 'file:///main.axl' }
        });
        assert.ok(infoMessages.some((message) => (message.includes('operation=lsp.semanticTokens')
            && message.includes('uri=file:///main.axl')
            && /durationMs=\d+/.test(message))));
    });
    test('preserves logger method receiver when logging semantic token timing', () => {
        let semanticTokensHandler;
        const sentMessages = [];
        const connection = {
            onInitialize: () => undefined,
            onDidChangeWatchedFiles: () => undefined,
            languages: {
                diagnostics: {
                    on: () => undefined
                },
                semanticTokens: {
                    on: (handler) => {
                        semanticTokensHandler = handler;
                    }
                }
            },
            onHover: () => undefined,
            onCompletion: () => undefined,
            onDefinition: () => undefined,
            onReferences: () => undefined,
            onSignatureHelp: () => undefined,
            onDocumentSymbol: () => undefined,
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => createTestDocument('int value;'),
            onDidOpen: () => undefined,
            onDidChangeContent: () => undefined,
            onDidClose: () => undefined
        };
        const analyzer = {
            analyzeDocument: () => ({
                uri: 'file:///main.axl',
                version: 1,
                diagnostics: [],
                symbols: [],
                declarations: [],
                references: [],
                scopes: [],
                includes: [],
                scriptExecutions: [],
                guiClasses: [],
                guiMethods: []
            })
        };
        const logger = {
            send(message) {
                sentMessages.push(message);
            },
            info(message) {
                this.send(message);
            },
            error: () => undefined
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger
        });
        semanticTokensHandler?.({
            textDocument: { uri: 'file:///main.axl' }
        });
        assert.strictEqual(sentMessages.length, 1);
        assert.match(sentMessages[0], /operation=lsp\.semanticTokens/);
    });
    test('uses cached workspace lookup for semantic token resolution', () => {
        let semanticTokensHandler;
        const connection = {
            onInitialize: () => undefined,
            onDidChangeWatchedFiles: () => undefined,
            languages: {
                diagnostics: {
                    on: () => undefined
                },
                semanticTokens: {
                    on: (handler) => {
                        semanticTokensHandler = handler;
                    }
                }
            },
            onHover: () => undefined,
            onCompletion: () => undefined,
            onDefinition: () => undefined,
            onReferences: () => undefined,
            onSignatureHelp: () => undefined,
            onDocumentSymbol: () => undefined,
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => createTestDocument('Widget value;'),
            onDidOpen: () => undefined,
            onDidChangeContent: () => undefined,
            onDidClose: () => undefined
        };
        const analyzer = {
            analyzeForegroundDocument: () => ({
                uri: 'file:///main.axl',
                version: 1,
                diagnostics: [],
                symbols: [],
                declarations: [{
                        id: 'file:///main.axl#0:7:value',
                        name: 'value',
                        kind: 'variable',
                        uri: 'file:///main.axl',
                        detail: 'Widget value',
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } },
                        selectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 12 } }
                    }],
                references: [{
                        name: 'Widget',
                        uri: 'file:///main.axl',
                        typeReference: true,
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }
                    }],
                scopes: [],
                includes: [],
                scriptExecutions: [],
                guiClasses: [],
                guiMethods: []
            }),
            analyzeDocument: () => {
                throw new Error('full analysis should not run');
            },
            semanticTokenWorkspaceIndex: () => ({
                listVisibleDeclarations: () => [{
                        id: 'file:///widget.h#0:6:Widget',
                        name: 'Widget',
                        kind: 'class',
                        uri: 'file:///widget.h',
                        detail: 'class',
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 15 } },
                        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } }
                    }]
            })
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger: { error: () => undefined }
        });
        const result = semanticTokensHandler?.({
            textDocument: { uri: 'file:///main.axl' }
        });
        assert.deepStrictEqual(result?.data, [
            0, 0, 6, 0, 0,
            0, 7, 5, 10, 1
        ]);
    });
    test('refreshes semantic tokens after background indexing completes', () => {
        let backgroundComplete;
        let refreshCount = 0;
        const connection = {
            onInitialize: () => undefined,
            onDidChangeWatchedFiles: () => undefined,
            languages: {
                diagnostics: {
                    on: () => undefined
                },
                semanticTokens: {
                    on: () => undefined,
                    refresh: () => {
                        refreshCount += 1;
                    }
                }
            },
            onHover: () => undefined,
            onCompletion: () => undefined,
            onDefinition: () => undefined,
            onReferences: () => undefined,
            onSignatureHelp: () => undefined,
            onDocumentSymbol: () => undefined,
            console: {
                error: () => undefined
            }
        };
        const documents = {
            get: () => undefined,
            onDidOpen: () => undefined,
            onDidChangeContent: () => undefined,
            onDidClose: () => undefined
        };
        const analyzer = {
            analyzeDocument: () => ({
                uri: 'file:///main.axl',
                version: 1,
                diagnostics: [],
                symbols: [],
                declarations: [],
                references: [],
                scopes: [],
                includes: [],
                scriptExecutions: [],
                guiClasses: [],
                guiMethods: []
            }),
            onBackgroundIndexingComplete: (listener) => {
                backgroundComplete = listener;
            }
        };
        (0, registerHandlers_1.registerHandlers)({
            connection: connection,
            documents: documents,
            analyzer,
            logger: { error: () => undefined }
        });
        backgroundComplete?.();
        assert.strictEqual(refreshCount, 1);
    });
});
function createTestDocument(text) {
    return {
        uri: 'file:///main.axl',
        version: 1,
        getText: () => text
    };
}
//# sourceMappingURL=registerHandlers.test.js.map