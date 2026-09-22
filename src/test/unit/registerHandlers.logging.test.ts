import * as assert from 'assert';
import { registerHandlers } from '../support/configuredHandlers';
import { createHandlerConnection, createTestDocument, emptyAnalysis } from '../support/handlerFixtures';
suite('registerHandlers', () => {

  test('logs completion request timing when logger supports info', async () => {
    let completionHandler: ((params: { textDocument: { uri: string }; position: { line: number; character: number } }) => unknown) | undefined;
    const infoMessages: string[] = [];
    const connection = createHandlerConnection({
      onCompletion: (handler: typeof completionHandler) => {
        completionHandler = handler;
      },
    });
    const documents = {
      get: () => createTestDocument('int value;'),
      onDidOpen: () => undefined,
      onDidChangeContent: () => undefined,
      onDidClose: () => undefined
    };
    const analyzer = {
      analyzeDocument: () => (emptyAnalysis({ uri: 'file:///main.axl', version: 1 })),
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

    await completionHandler?.({
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

  test('preserves logger method receiver when logging semantic token timing', async () => {
    let semanticTokensHandler: ((params: { textDocument: { uri: string } }) => { data: number[] }) | undefined;
    const sentMessages: string[] = [];
    const connection = createHandlerConnection({
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
    });
    const documents = {
      get: () => createTestDocument('int value;'),
      onDidOpen: () => undefined,
      onDidChangeContent: () => undefined,
      onDidClose: () => undefined
    };
    const analyzer = {
      analyzeDocument: () => (emptyAnalysis({ uri: 'file:///main.axl', version: 1 }))
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

    await semanticTokensHandler?.({
      textDocument: { uri: 'file:///main.axl' }
    });

    assert.strictEqual(sentMessages.length, 1);
    assert.match(sentMessages[0], /operation=lsp\.semanticTokens/);
    assert.ok(sentMessages[0].includes('uri=file:///main.axl'));
    assert.match(sentMessages[0], /durationMs=\d+/);
  });
});
