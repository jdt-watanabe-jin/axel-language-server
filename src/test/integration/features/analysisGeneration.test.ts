import * as assert from 'assert';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import type { AnalyzeDocumentInput } from '../../../types/analysis';

suite('Analysis generation', () => {
  test('does not reuse results for different text at the same version', () => {
    const analyzer = new DocumentAnalyzer();
    const uri = 'file:///disk.h';
    analyzer.analyzeDocument({ uri, version: 0, text: 'int before;' });
    const next = analyzer.analyzeDocument({ uri, version: 0, text: 'string after;' });
    assert.ok(next.declarations.some(item => item.name === 'after'));
    assert.ok(!next.declarations.some(item => item.name === 'before'));
  });
  test('keeps changed conditional and GUI contexts equivalent to fresh analysis', () => {
    const analyzer = new DocumentAnalyzer();
    const input = { uri: 'file:///context.axl', version: 1,
      text: '#ifdef ENABLED\nint active;\n#else\nstring inactive;\n#endif\nclass Child : public Parent {};' };
    const variants: AnalyzeDocumentInput[] = [input, { ...input, preprocessorSymbols: [{ name: 'ENABLED', value: '1' }] },
      { ...input, knownGuiClasses: [{ name: 'Parent', kind: 'dialog' }] }, input];
    for (const variant of variants) {
      assert.deepStrictEqual(analyzer.analyzeDocument(variant), new DocumentAnalyzer().analyzeDocument(variant));
    }
  });
  test('rebuilds after an interrupted generator and after clear', () => {
    const analyzer = new DocumentAnalyzer();
    const input = { uri: 'file:///cancel.axl', version: 1, text: 'int value; void f(){ value++; }' };
    const steps = analyzer.analyzeDocumentSteps(input);
    for (let i = 0; i < 8; i++) { assert.strictEqual(steps.next().done, false); }
    steps.return(undefined!);
    assert.deepStrictEqual(analyzer.analyzeDocument(input), new DocumentAnalyzer().analyzeDocument(input));
    analyzer.clear(input.uri);
    const changed = { ...input, text: 'string latest;' };
    assert.deepStrictEqual(analyzer.analyzeDocument(changed), new DocumentAnalyzer().analyzeDocument(changed));
  });
});
