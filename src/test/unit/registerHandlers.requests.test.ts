import * as assert from 'assert';
import { registerHandlers } from '../../lsp/registerHandlers';
import { createTestDocument, createHandlerConnection } from '../support/handlerFixtures';
suite('registerHandlers', () => {
  test('returns empty completion list when analysis fails', async () => {
    let completionHandler: ((params: { textDocument: { uri: string }; position: { line: number; character: number } }) => unknown) | undefined;
    const errors: string[] = [];
    const connection = createHandlerConnection({
      onCompletion: (handler: typeof completionHandler) => {
        completionHandler = handler;
      },
    });
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

    const result = await completionHandler?.({
      textDocument: { uri: 'file:///main.axl' },
      position: { line: 0, character: 0 }
    });

    assert.deepStrictEqual(result, []);
    assert.ok(errors.some(message => message.toLowerCase().includes('completion')
      && message.includes('analysis exploded')));
  });

  test('returns null signature help when analysis fails', async () => {
    let signatureHelpHandler: ((params: { textDocument: { uri: string }; position: { line: number; character: number } }) => unknown) | undefined;
    const errors: string[] = [];
    const connection = createHandlerConnection({
      onSignatureHelp: (handler: typeof signatureHelpHandler) => {
        signatureHelpHandler = handler;
      },
    });
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

    const result = await signatureHelpHandler?.({
      textDocument: { uri: 'file:///main.axl' },
      position: { line: 0, character: 0 }
    });

    assert.strictEqual(result, null);
    assert.ok(errors.some(message => message.toLowerCase().includes('signature help')
      && message.includes('analysis exploded')));
  });

  test('returns empty semantic tokens when analysis fails', async () => {
    let semanticTokensHandler: ((params: { textDocument: { uri: string } }) => { data: number[] }) | undefined;
    const errors: string[] = [];
    const connection = createHandlerConnection({
      languages: { diagnostics: { on: () => undefined }, semanticTokens: {
        on: (handler: typeof semanticTokensHandler) => { semanticTokensHandler = handler; }
      } }
    });
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

    const result = await semanticTokensHandler?.({
      textDocument: { uri: 'file:///main.axl' }
    });

    assert.deepStrictEqual(result, { data: [] });
    assert.ok(errors.some(message => message.toLowerCase().includes('semantic tokens')
      && message.includes('analysis exploded')));
  });
});

