import * as assert from 'assert';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getDocumentHighlightsSteps } from '../../../analyzer/documentHighlights';
import { runAnalysisSteps } from '../../../util/analysisSteps';
import { useWorkspaceFixtures } from '../../support/workspace';
import { positionFromOffset } from '../../support/source';

suite('Document highlights review regressions', () => {
  const { createWorkspaceIndex, createTempDir } = useWorkspaceFixtures();
  function fixture(text: string) {
    const workspaceIndex = createWorkspaceIndex();
    const uri = pathToFileURL(path.join(createTempDir(), 'main.axl')).toString();
    const analysis = workspaceIndex.indexOpenDocument({ uri, version: 1, text });
    return (offset: number) => runAnalysisSteps(getDocumentHighlightsSteps({
      analysis, workspaceIndex, position: positionFromOffset(text, offset)
    }));
  }

  test('does not resolve another function local or a local before its declaration', () => {
    const text = 'void f(){ int x; } void g(){ x=1; int x; }';
    const highlights = fixture(text);
    assert.strictEqual(highlights(text.indexOf('x;')).length, 1);
    assert.strictEqual(highlights(text.lastIndexOf('x;')).length, 1);
    assert.deepStrictEqual(highlights(text.indexOf('x=1')), []);
  });

  test('tracks undef operands with trailing comments using only the name range', () => {
    const text = '#define FLAG 1\n#undef FLAG // reset\nint x=FLAG;';
    const highlights = fixture(text);
    assert.deepStrictEqual(highlights(text.indexOf('FLAG')).map(item => item.range), [
      { start: { line: 0, character: 8 }, end: { line: 0, character: 12 } },
      { start: { line: 1, character: 7 }, end: { line: 1, character: 11 } }
    ]);
    assert.deepStrictEqual(highlights(text.lastIndexOf('FLAG')), []);
  });

  test('includes GUI event receiver path segments resolved by existing navigation', () => {
    const text = [
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group { GCText input; };',
      '};',
      'void MyDialog::group.input::OnChanged() {}',
      'void main() { MyDialog dialog; dialog.group.input; }'
    ].join('\n');
    const highlights = fixture(text);
    const declaration = highlights(text.indexOf('input'));
    assert.strictEqual(declaration.length, 3);
    assert.deepStrictEqual(highlights(text.indexOf('input::')), declaration);
    assert.deepStrictEqual(declaration.map(item => item.range.start.line), [1, 3, 4]);
  });

  for (const directive of ['#undef FLAG', '#define FLAG 2']) {
    test(`does not bind a macro after uncertain ${directive}`, () => {
      const text = `#define FLAG 1\n#if __DATE__\n${directive}\n#endif\nint x=FLAG;`;
      const highlights = fixture(text);
      assert.strictEqual(highlights(text.indexOf('FLAG')).length, 1);
      assert.deepStrictEqual(highlights(text.lastIndexOf('FLAG')), []);
    });
  }
});
