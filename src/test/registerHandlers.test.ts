import * as assert from 'assert';
import { registerHandlers } from '../lsp/registerHandlers';

suite('registerHandlers', () => {
  test('registers initialize, diagnostics, hover, completion, rename, code action, formatting, signature help, semantic tokens, document symbol, document lifecycle, and watched file handlers', () => {
    const calls: string[] = [];
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

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
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
      analyzeForegroundDocument: (input: { text: string }) => {
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
      indexOpenDocument: (_input: { text: string }) => {
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

  test('invalidates watched files through the workspace index', () => {
    const invalidatedUris: string[] = [];
    let watchedFilesHandler: ((event: { changes: { uri: string }[] }) => void) | undefined;
    const connection = {
      onInitialize: () => undefined,
      onDidChangeWatchedFiles: (handler: (event: { changes: { uri: string }[] }) => void) => {
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
      invalidateUri: (uri: string) => {
        invalidatedUris.push(uri);
      }
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
      analyzer,
      logger: { error: () => undefined }
    });

    watchedFilesHandler?.({ changes: [{ uri: 'file:///types.h' }] });

    assert.deepStrictEqual(invalidatedUris, ['file:///types.h']);
  });

  test('applies workspace index options from initialization options', () => {
    let initializeHandler: ((params: { initializationOptions?: unknown }) => unknown) | undefined;
    let configuredOptions: unknown;
    const connection = {
      onInitialize: (handler: (params: { initializationOptions?: unknown }) => unknown) => {
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
      configure: (options: unknown) => {
        configuredOptions = options;
      }
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
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
    let completionHandler: ((params: { textDocument: { uri: string }; position: { line: number; character: number } }) => unknown) | undefined;
    const errors: string[] = [];
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
      onCompletion: (handler: typeof completionHandler) => {
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

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
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
    let signatureHelpHandler: ((params: { textDocument: { uri: string }; position: { line: number; character: number } }) => unknown) | undefined;
    const errors: string[] = [];
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
      onSignatureHelp: (handler: typeof signatureHelpHandler) => {
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

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
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
    let documentFormattingHandler: ((params: {
      textDocument: { uri: string };
      options: { insertSpaces: boolean; tabSize: number };
    }) => unknown) | undefined;
    let rangeFormattingHandler: ((params: {
      textDocument: { uri: string };
      options: { insertSpaces: boolean; tabSize: number };
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
    }) => unknown) | undefined;
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
      onDocumentFormatting: (handler: typeof documentFormattingHandler) => {
        documentFormattingHandler = handler;
      },
      onDocumentRangeFormatting: (handler: typeof rangeFormattingHandler) => {
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

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
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
    let semanticTokensHandler: ((params: { textDocument: { uri: string } }) => { data: number[] }) | undefined;
    const errors: string[] = [];
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

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
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
    let semanticTokensHandler: ((params: { textDocument: { uri: string } }) => { data: number[] }) | undefined;
    const infoMessages: string[] = [];
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

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
      analyzer,
      logger: {
        info: (message) => infoMessages.push(message),
        error: () => undefined
      }
    });

    semanticTokensHandler?.({
      textDocument: { uri: 'file:///main.axl' }
    });

    assert.ok(infoMessages.some((message) => (
      message.includes('operation=lsp.semanticTokens')
      && message.includes('uri=file:///main.axl')
      && /durationMs=\d+/.test(message)
    )));
  });

  test('logs completion request timing when logger supports info', () => {
    let completionHandler: ((params: { textDocument: { uri: string }; position: { line: number; character: number } }) => unknown) | undefined;
    const infoMessages: string[] = [];
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
      onCompletion: (handler: typeof completionHandler) => {
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
      }),
      findIncludePathCompletions: () => [],
      findScriptExecutionPathCompletions: () => [],
      listVisibleDeclarations: () => [],
      findVisibleGuiClasses: () => []
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
      analyzer,
      logger: {
        info: (message) => infoMessages.push(message),
        error: () => undefined
      }
    });

    completionHandler?.({
      textDocument: { uri: 'file:///main.axl' },
      position: { line: 0, character: 4 }
    });

    assert.ok(infoMessages.some((message) => (
      message.includes('operation=lsp.completion')
      && message.includes('uri=file:///main.axl')
      && message.includes('version=1')
      && message.includes('line=0')
      && message.includes('character=4')
      && /durationMs=\d+/.test(message)
    )));
  });

  test('preserves logger method receiver when logging semantic token timing', () => {
    let semanticTokensHandler: ((params: { textDocument: { uri: string } }) => { data: number[] }) | undefined;
    const sentMessages: string[] = [];
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
      send(message: string): void {
        sentMessages.push(message);
      },
      info(message: string): void {
        this.send(message);
      },
      error: () => undefined
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
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
      analyzeForegroundDocument: () => ({
        uri: 'file:///main.axl',
        version: 1,
        diagnostics: [],
        symbols: [],
        declarations: [{
          id: 'file:///main.axl#0:7:value',
          name: 'value',
          kind: 'variable' as const,
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

  test('refreshes semantic tokens after background indexing completes', () => {
    let backgroundComplete: (() => void) | undefined;
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

    assert.strictEqual(refreshCount, 1);
  });
});

interface TestDocument {
  uri: string;
  version: number;
  getText(): string;
}

function createTestDocument(text: string): TestDocument {
  return {
    uri: 'file:///main.axl',
    version: 1,
    getText: () => text
  };
}
