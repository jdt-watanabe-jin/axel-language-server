import * as assert from 'assert';
import { registerHandlers } from '../../lsp/registerHandlers';
import { createTestDocument, emptyAnalysis, type TestDocument } from '../support/handlerFixtures';
suite('registerHandlers', () => {
  test('indexes opened and changed documents through foreground analysis when available', () => {
    const indexedTexts: string[] = [];
    let openHandler: ((event: { document: TestDocument }) => void) | undefined;
    let changeHandler: ((event: { document: TestDocument }) => void) | undefined;
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
      onDidOpen: (handler: (event: { document: TestDocument }) => void) => {
        openHandler = handler;
      },
      onDidChangeContent: (handler: (event: { document: TestDocument }) => void) => {
        changeHandler = handler;
      },
      onDidClose: () => undefined
    };
    const analyzer = {
      analyzeDocument: () => (emptyAnalysis({ uri: 'file:///missing.axl', version: 0 })),
      analyzeForegroundDocument: (input: { text: string }) => {
        indexedTexts.push(input.text);
        return emptyAnalysis({ uri: 'file:///main.axl', version: 1 });
      },
      indexOpenDocument: (_input: { text: string }) => {
        return emptyAnalysis({ uri: 'file:///main.axl', version: 1 });
      }
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
      analyzer,
      logger: { error: () => undefined }
    });

    openHandler?.({ document: createTestDocument('int opened;') });
    changeHandler?.({ document: createTestDocument('int changed;') });

    assert.deepStrictEqual(indexedTexts, ['int opened;', 'int changed;']);
  });

  test('sends inactive ranges after opened and changed documents are analyzed', () => {
    const notifications: unknown[] = [];
    let openHandler: ((event: { document: TestDocument }) => void) | undefined;
    let changeHandler: ((event: { document: TestDocument }) => void) | undefined;
    const inactiveRanges = [{
      start: { line: 2, character: 0 },
      end: { line: 3, character: 12 }
    }];
    const connection = {
      onInitialize: () => undefined,
      onDidChangeWatchedFiles: () => undefined,
      sendNotification: (method: string, params: unknown) => {
        notifications.push({ method, params });
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
      onDidOpen: (handler: (event: { document: TestDocument }) => void) => {
        openHandler = handler;
      },
      onDidChangeContent: (handler: (event: { document: TestDocument }) => void) => {
        changeHandler = handler;
      },
      onDidClose: () => undefined
    };
    const analyzer = {
      analyzeDocument: () => {
        throw new Error('full analysis should not run');
      },
      analyzeForegroundDocument: (input: { uri: string; version: number }) => (emptyAnalysis({ uri: input.uri, version: input.version, inactiveRanges }))
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
      analyzer,
      logger: { error: () => undefined }
    });

    openHandler?.({ document: createTestDocument('int opened;') });
    changeHandler?.({ document: createTestDocument('int changed;') });

    assert.deepStrictEqual(notifications, [
      { method: 'axel/inactiveRanges', params: { uri: 'file:///main.axl', ranges: inactiveRanges } },
      { method: 'axel/inactiveRanges', params: { uri: 'file:///main.axl', ranges: inactiveRanges } }
    ]);
  });

  test('sends inactive ranges after hover reanalyzes a document', () => {
    let hoverHandler: ((params: { textDocument: { uri: string }; position: { line: number; character: number } }) => unknown) | undefined;
    const inactiveRanges = [{
      start: { line: 3, character: 0 },
      end: { line: 3, character: 18 }
    }];
    const notifications: unknown[] = [];
    const connection = {
      onInitialize: () => undefined,
      onDidChangeConfiguration: () => undefined,
      onDidChangeWatchedFiles: () => undefined,
      sendNotification: (method: string, params: unknown) => {
        notifications.push({ method, params });
      },
      languages: {
        diagnostics: {
          on: () => undefined
        },
        semanticTokens: {
          on: () => undefined
        }
      },
      onHover: (handler: typeof hoverHandler) => {
        hoverHandler = handler;
      },
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
      get: () => createTestDocument('#if SEMVER_TEST\nint value;\n#endif'),
      onDidOpen: () => undefined,
      onDidChangeContent: () => undefined,
      onDidClose: () => undefined
    };
    const analyzer = {
      analyzeDocument: () => {
        throw new Error('full analysis should not run');
      },
      analyzeForegroundDocument: (input: { uri: string; version: number }) => (emptyAnalysis({ uri: input.uri, version: input.version, inactiveRanges }))
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
      analyzer,
      logger: { error: () => undefined }
    });

    hoverHandler?.({
      textDocument: { uri: 'file:///main.axl' },
      position: { line: 1, character: 4 }
    });

    assert.deepStrictEqual(notifications, [{
      method: 'axel/inactiveRanges',
      params: {
        uri: 'file:///main.axl',
        ranges: inactiveRanges
      }
    }]);
  });

  test('uses foreground analysis for document diagnostic requests', () => {
    let diagnosticsHandler: ((params: { textDocument: { uri: string } }) => unknown) | undefined;
    let fullAnalysisCalls = 0;
    let foregroundAnalysisCalls = 0;
    const foregroundDiagnostic = {
      severity: 'error' as const,
      source: 'axel' as const,
      message: 'Syntax error.',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 }
      }
    };
    const connection = {
      onInitialize: () => undefined,
      onDidChangeWatchedFiles: () => undefined,
      languages: {
        diagnostics: {
          on: (handler: typeof diagnosticsHandler) => {
            diagnosticsHandler = handler;
          }
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
      get: () => createTestDocument('#include "missing.h"'),
      onDidOpen: () => undefined,
      onDidChangeContent: () => undefined,
      onDidClose: () => undefined
    };
    const analyzer = {
      analyzeDocument: () => {
        fullAnalysisCalls += 1;
        return emptyAnalysis({ uri: 'file:///main.axl', version: 1 });
      },
      analyzeForegroundDocument: () => {
        foregroundAnalysisCalls += 1;
        return emptyAnalysis({ uri: 'file:///main.axl', version: 1, diagnostics: [foregroundDiagnostic] });
      }
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
      analyzer,
      logger: { error: () => undefined }
    });

    const result = diagnosticsHandler?.({
      textDocument: { uri: 'file:///main.axl' }
    });

    assert.deepStrictEqual(result, {
      kind: 'full',
      items: [{
        severity: 1,
        source: 'axel',
        message: 'Syntax error.',
        range: foregroundDiagnostic.range
      }]
    });
    assert.strictEqual(foregroundAnalysisCalls, 1);
    assert.strictEqual(fullAnalysisCalls, 0);
  });

  test('uses foreground analysis for opened documents and semantic tokens', () => {
    const calls: string[] = [];
    let openHandler: ((event: { document: TestDocument }) => void) | undefined;
    let semanticTokensHandler: ((params: { textDocument: { uri: string } }) => { data: number[] }) | undefined;
    const connection = {
      onInitialize: () => undefined,
      onDidChangeWatchedFiles: () => undefined,
      languages: {
        diagnostics: {
          on: () => undefined
        },
        semanticTokens: {
          on: (handler: typeof semanticTokensHandler) => {
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
      onDidOpen: (handler: (event: { document: TestDocument }) => void) => {
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
        return emptyAnalysis({ uri: 'file:///main.axl', version: 1 });
      }
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
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

  test('uses cached workspace lookup for semantic token resolution', () => {
    let semanticTokensHandler: ((params: { textDocument: { uri: string } }) => { data: number[] }) | undefined;
    const connection = {
      onInitialize: () => undefined,
      onDidChangeWatchedFiles: () => undefined,
      languages: {
        diagnostics: {
          on: () => undefined
        },
        semanticTokens: {
          on: (handler: typeof semanticTokensHandler) => {
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
      analyzeForegroundDocument: () => (emptyAnalysis({ uri: 'file:///main.axl', version: 1, declarations: [{
          id: 'file:///main.axl#0:7:value',
          name: 'value',
          kind: 'variable' as const,
          uri: 'file:///main.axl',
          detail: 'Widget value',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } },
          selectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 12 } }
        }], references: [{
          name: 'Widget',
          uri: 'file:///main.axl',
          typeReference: true,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }
        }] })),
      analyzeDocument: () => {
        throw new Error('full analysis should not run');
      },
      semanticTokenWorkspaceIndex: () => ({
        listVisibleDeclarations: () => [{
          id: 'file:///widget.h#0:6:Widget',
          name: 'Widget',
          kind: 'class' as const,
          uri: 'file:///widget.h',
          detail: 'class',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 15 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } }
        }]
      })
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
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

  test('refreshes semantic tokens and diagnostics after background indexing completes', () => {
    let backgroundComplete: (() => void) | undefined;
    let semanticTokensRefreshCount = 0;
    let diagnosticsRefreshCount = 0;
    const connection = {
      onInitialize: () => undefined,
      onDidChangeWatchedFiles: () => undefined,
      languages: {
        diagnostics: {
          on: () => undefined,
          refresh: () => {
            diagnosticsRefreshCount += 1;
          }
        },
        semanticTokens: {
          on: () => undefined,
          refresh: () => {
            semanticTokensRefreshCount += 1;
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
      analyzeDocument: () => (emptyAnalysis({ uri: 'file:///main.axl', version: 1 })),
      onBackgroundIndexingComplete: (listener: () => void) => {
        backgroundComplete = listener;
      }
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
      analyzer,
      logger: { error: () => undefined }
    });

    backgroundComplete?.();

    assert.strictEqual(semanticTokensRefreshCount, 1);
    assert.strictEqual(diagnosticsRefreshCount, 1);
  });
});

