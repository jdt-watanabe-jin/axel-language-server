import * as assert from 'assert';
import { registerHandlers } from '../../lsp/registerHandlers';
import { createTestDocument, emptyAnalysis } from '../support/handlerFixtures';
suite('registerHandlers', () => {

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

    semanticTokensHandler?.({
      textDocument: { uri: 'file:///main.axl' }
    });

    assert.strictEqual(sentMessages.length, 1);
    assert.match(sentMessages[0], /operation=lsp\.semanticTokens/);
    assert.ok(sentMessages[0].includes('uri=file:///main.axl'));
    assert.match(sentMessages[0], /durationMs=\d+/);
  });
});

