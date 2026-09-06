import * as assert from 'assert';
import { registerHandlers } from '../../../lsp/registerHandlers';
import { createTestDocument, emptyAnalysis } from '../../support/handlerFixtures';

suite('registerHandlers', () => {
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
      analyzeDocument: () => (emptyAnalysis({ uri: 'file:///main.axl', version: 1 }))
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
});
