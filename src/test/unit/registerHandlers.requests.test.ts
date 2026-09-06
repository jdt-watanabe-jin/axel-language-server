import * as assert from 'assert';
import { registerHandlers } from '../../lsp/registerHandlers';
import { createTestDocument } from '../support/handlerFixtures';
suite('registerHandlers', () => {
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
});

