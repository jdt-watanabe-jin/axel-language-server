import * as assert from 'assert';
import { registerHandlers } from '../../lsp/registerHandlers';
import { createTestDocument, emptyAnalysis } from '../support/handlerFixtures';
suite('registerHandlers', () => {
  test('registers initialize, diagnostics, hover, completion, rename, code action, formatting, signature help, semantic tokens, document symbol, document lifecycle, and watched file handlers', () => {
    const calls: string[] = [];
    const connection = {
      onInitialize: () => calls.push('initialize'),
      onDidChangeConfiguration: () => calls.push('configuration'),
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
      analyzeDocument: () => (emptyAnalysis({ uri: 'file:///missing.axl', version: 0 }))
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
      'configuration',
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
    ].sort());
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
      analyzeDocument: () => (emptyAnalysis({ uri: 'file:///missing.axl', version: 0 })),
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
      analyzeDocument: () => (emptyAnalysis({ uri: 'file:///missing.axl', version: 0 })),
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

  test('applies changed configuration and reindexes open documents', () => {
    let configurationHandler: ((params: { settings?: unknown }) => void) | undefined;
    const configuredOptions: unknown[] = [];
    const analyzedTexts: string[] = [];
    const notifications: unknown[] = [];
    const inactiveRanges = [{
      start: { line: 3, character: 0 },
      end: { line: 3, character: 18 }
    }];
    const connection = {
      onInitialize: () => undefined,
      onDidChangeConfiguration: (handler: (params: { settings?: unknown }) => void) => {
        configurationHandler = handler;
      },
      onDidChangeWatchedFiles: () => undefined,
      sendNotification: (method: string, params: unknown) => {
        notifications.push({ method, params });
      },
      languages: {
        diagnostics: {
          on: () => undefined,
          refresh: () => notifications.push({ method: 'diagnostics/refresh' })
        },
        semanticTokens: {
          on: () => undefined,
          refresh: () => notifications.push({ method: 'semanticTokens/refresh' })
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
      all: () => [createTestDocument('#if SEMVER_TEST\nint value;\n#endif')],
      get: () => undefined,
      onDidOpen: () => undefined,
      onDidChangeContent: () => undefined,
      onDidClose: () => undefined
    };
    const analyzer = {
      analyzeDocument: () => (emptyAnalysis({ uri: 'file:///missing.axl', version: 0 })),
      analyzeForegroundDocument: (input: { text: string; uri: string; version: number }) => {
        analyzedTexts.push(input.text);
        return emptyAnalysis({ uri: input.uri, version: input.version, inactiveRanges });
      },
      configure: (options: unknown) => configuredOptions.push(options)
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
      analyzer,
      logger: { error: () => undefined }
    });

    configurationHandler?.({
      settings: {
        defines: ['SEMVER_TEST']
      }
    });

    assert.deepStrictEqual(configuredOptions, [{ defines: ['SEMVER_TEST'] }]);
    assert.deepStrictEqual(analyzedTexts, ['#if SEMVER_TEST\nint value;\n#endif']);
    assert.deepStrictEqual(notifications, [
      {
        method: 'axel/inactiveRanges',
        params: {
          uri: 'file:///main.axl',
          ranges: inactiveRanges
        }
      },
      { method: 'semanticTokens/refresh' },
      { method: 'diagnostics/refresh' }
    ]);
  });
});

