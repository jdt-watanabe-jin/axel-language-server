import * as assert from 'assert';
import { registerHandlers } from '../support/configuredHandlers';
import { createHandlerConnection, createTestDocument, emptyAnalysis } from '../support/handlerFixtures';

suite('Local source scheduling', () => {
  for (const feature of ['outline', 'selection'] as const) {
    test(feature + ' uses edited source while foreground analysis is pending', async () => {
      const document = createTestDocument('int edited;');
      const range = { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } };
      let change!: (event: { document: typeof document }) => void;
      let request!: (params: { textDocument: { uri: string }; positions: { line: number; character: number }[] }) => Promise<unknown>;
      let release!: () => void;
      let entered!: () => void;
      let finished!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const completed = new Promise<void>(resolve => { finished = resolve; });
      let foregroundComplete = false;
      const connection = createHandlerConnection({
        [feature === 'outline' ? 'onDocumentSymbol' : 'onSelectionRanges']: (handler: typeof request) => { request = handler; },
        sendNotification: async () => {}
      });
      registerHandlers({
        connection: connection as never,
        documents: { get: () => document, onDidOpen() {}, onDidClose() {}, onDidChangeContent(handler: typeof change) { change = handler; } } as never,
        analyzer: {
          analyzeDocument: () => emptyAnalysis(),
          async analyzeForegroundDocumentAsync() {
            entered(); await gate; foregroundComplete = true; finished(); return emptyAnalysis();
          },
          *getDocumentSymbolsSteps(input) {
            assert.strictEqual(input.text, 'int edited;'); yield;
            return [{ name: 'edited', kind: 'variable' as const, range, selectionRange: range }];
          },
          *getSelectionRangesSteps(input) {
            assert.strictEqual(input.text, 'int edited;'); yield; return [{ range }];
          }
        },
        logger: { error: message => assert.fail(message) }
      });
      change({ document });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await started;
        const result = await Promise.race([
          request({ textDocument: { uri: document.uri }, positions: [{ line: 0, character: 6 }] }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(feature + ' waited for foreground analysis')), 1000); })
        ]);
        if (feature === 'outline') {
          assert.deepStrictEqual((result as { name: string }[]).map(symbol => symbol.name), ['edited']);
        } else {
          assert.deepStrictEqual(result, [{ range }]);
        }
        assert.strictEqual(foregroundComplete, false);
      } finally {
        clearTimeout(timer); release(); await completed;
      }
    });
  }
});
