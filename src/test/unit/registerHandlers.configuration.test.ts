import * as assert from 'assert';
import { registerHandlers } from '../support/configuredHandlers';
import { registerHandlers as registerPullHandlers } from '../../lsp/registerHandlers';
import { CancellationToken } from 'vscode-languageserver/node';
import { createHandlerConnection, createTestDocument, emptyAnalysis } from '../support/handlerFixtures';
suite('registerHandlers', () => {

  test('invalidates watched files through the workspace index', () => {
    const invalidatedUris: string[] = [];
    let diagnosticRefreshes = 0;
    let watchedFilesHandler: ((event: { changes: { uri: string }[] }) => void) | undefined;
    const connection = createHandlerConnection({
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
    });
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

  test('pulls changed configuration and ignores notification payload', async () => {
    let configurationHandler: ((params: { settings?: unknown }) => void) | undefined;
    const configuredOptions: unknown[] = [];
    const analyzedTexts: string[] = [];
    const notifications: unknown[] = [];
    const inactiveRanges = [{
      start: { line: 3, character: 0 },
      end: { line: 3, character: 18 }
    }];
    const connection = createHandlerConnection({
      sendRequest: async () => [{ defines: ['SEMVER_TEST'] }],
      window: { showErrorMessage: () => undefined },
      onDidChangeConfiguration: (handler: (params: { settings?: unknown }) => void) => {
        configurationHandler = handler;
      },
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
    });
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

    const context = {
      clientCapabilities: { workspace: { semanticTokens: { refreshSupport: true }, diagnostics: { refreshSupport: true } } },
      connection: connection as never,
      documents: documents as never,
      analyzer,
      logger: { error: () => undefined },
      configuration: undefined as import('../../lsp/registerHandlers').HandlerRegistrationContext['configuration']
    };
    registerPullHandlers(context);
    context.configuration!.start();
    await context.configuration!.ready(CancellationToken.None);

    const analysesBefore = analyzedTexts.length;
    configurationHandler?.({
      settings: {
        defines: ['IGNORED']
      }
    });

    await context.configuration!.ready(CancellationToken.None);
    assert.strictEqual(analyzedTexts.length, analysesBefore, 'unchanged settings must not reindex documents');
    assert.deepStrictEqual(configuredOptions, [{ defines: ['SEMVER_TEST'] }]);
    assert.ok(analyzedTexts.length > 0);
    assert.ok(analyzedTexts.every(text => text === '#if SEMVER_TEST\nint value;\n#endif'));
    context.configuration!.dispose();
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
