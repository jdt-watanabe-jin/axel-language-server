import * as assert from 'assert';
import { registerHandlers } from '../../lsp/registerHandlers';
import { createTestDocument, emptyAnalysis } from '../support/handlerFixtures';
suite('registerHandlers', () => {
  test('registers requests without dedicated successful handler scenarios', () => {
    const calls: string[] = [];
    const connection = {
      onInitialize: () => undefined,
      onDidChangeConfiguration: () => undefined,
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
      onReferences: () => calls.push('references'),
      onPrepareRename: () => calls.push('prepareRename'),
      onRenameRequest: () => calls.push('rename'),
      onCodeAction: () => calls.push('codeAction'),
      onDocumentFormatting: () => undefined,
      onDocumentRangeFormatting: () => undefined,
      onSignatureHelp: () => calls.push('signatureHelp'),
      onDocumentSymbol: () => calls.push('documentSymbol'),
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
      analyzeDocument: () => (emptyAnalysis({ uri: 'file:///missing.axl', version: 0 }))
    };

    registerHandlers({
      connection: connection as never,
      documents: documents as never,
      analyzer,
      logger: { error: () => undefined }
    });

    assert.deepStrictEqual(calls.sort(), ["codeAction","documentSymbol","prepareRename","references","rename","signatureHelp"].sort());
  });

  test('invalidates watched files through the workspace index', () => {
    const invalidatedUris: string[] = [];
    let diagnosticRefreshes = 0;
    let watchedFilesHandler: ((event: { changes: { uri: string }[] }) => void) | undefined;
    const connection = {
      onInitialize: () => undefined,
      onDidChangeWatchedFiles: (handler: (event: { changes: { uri: string }[] }) => void) => {
        watchedFilesHandler = handler;
      },
      languages: {
        diagnostics: {
          refresh: () => { diagnosticRefreshes++; },
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
    assert.strictEqual(diagnosticRefreshes, 1, 'Header changes must request fresh diagnostics without a source edit');
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
    assert.deepStrictEqual(new Set(notifications.map(item => JSON.stringify(item))), new Set([
      {
        method: 'axel/inactiveRanges',
        params: {
          uri: 'file:///main.axl',
          ranges: inactiveRanges
        }
      },
      { method: 'semanticTokens/refresh' },
      { method: 'diagnostics/refresh' }
    ].map(item => JSON.stringify(item))));
  });
});

