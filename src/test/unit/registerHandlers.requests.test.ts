import * as assert from 'assert';
import { registerHandlers } from '../support/configuredHandlers';
import { createTestDocument, createHandlerConnection } from '../support/handlerFixtures';

suite('registerHandlers', () => {
  for (const scenario of [
    { name: 'empty completion list', registration: 'onCompletion', log: 'completion', expected: [] },
    { name: 'null signature help', registration: 'onSignatureHelp', log: 'signature help', expected: null },
    { name: 'empty semantic tokens', registration: 'semanticTokens', log: 'semantic tokens', expected: { data: [] } }
  ]) {
    test('returns ' + scenario.name + ' when analysis fails', async () => {
      interface Params { textDocument: { uri: string }; position: { line: number; character: number } }
      let handler!: (params: Params) => unknown;
      const errors: string[] = [];
      const capture = (value: typeof handler) => { handler = value; };
      const connection = createHandlerConnection(scenario.registration === 'semanticTokens'
        ? { languages: { diagnostics: { on() {} }, semanticTokens: { on: capture } } }
        : { [scenario.registration]: capture });
      registerHandlers({
        connection: connection as never,
        documents: { get: () => createTestDocument('broken'), onDidOpen() {}, onDidChangeContent() {}, onDidClose() {} } as never,
        analyzer: { analyzeDocument() { throw new Error('analysis exploded'); } },
        logger: { error: message => errors.push(message) }
      });
      const result = await handler({ textDocument: { uri: 'file:///main.axl' }, position: { line: 0, character: 0 } });
      assert.deepStrictEqual(result, scenario.expected);
      assert.ok(errors.some(message => message.toLowerCase().includes(scenario.log) && message.includes('analysis exploded')));
    });
  }
});
