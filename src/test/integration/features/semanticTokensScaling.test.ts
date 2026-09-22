import * as assert from 'assert';
import { collectSemanticTokens } from '../../../analyzer/semanticTokens';
import { createVisibleEnumMemberDeclarations, createReferenceHeavyAnalysis, createGuiReferenceHeavyAnalysis } from '../../support/semanticTokenLoad';

suite('semantic token lookup scaling', () => {
  for (const [name, makeAnalysis] of [
    ['named references', createReferenceHeavyAnalysis],
    ['implicit GUI references', createGuiReferenceHeavyAnalysis]
  ] as const) {
    test(`does not repeat visible declaration scans as ${name} grow`, () => {
      function count(referenceCount: number) {
        const declarations = createVisibleEnumMemberDeclarations(500);
        const iterator = declarations[Symbol.iterator].bind(declarations);
        let scans = 0;
        let lookups = 0;
        declarations[Symbol.iterator] = function () { scans++; return iterator(); };
        const tokens = collectSemanticTokens(makeAnalysis(referenceCount), {
          listVisibleDeclarations: () => { lookups++; return declarations; }
        });
        assert.strictEqual(tokens.length, name === 'named references' ? referenceCount : 2);
        return { scans, lookups };
      }
      const small = count(20);
      const large = count(200);
      assert.ok(small.scans > 0 && small.lookups > 0, 'The fixture must exercise workspace lookup');
      assert.deepStrictEqual(large, small, 'Ten times as many references must not multiply workspace scans');
    });
  }
});
