import * as assert from 'assert';
import { getHover } from '../../../analyzer/hover';
import { getCompletions } from '../../../analyzer/completion';
import { getSignatureHelp } from '../../../analyzer/signatureHelp';
import { bindDocumentation } from '../../../analyzer/documentation';
import { analyzeMarked, positionFromOffset } from '../../support/source';

suite('Doxygen cpptools compatibility', () => {
  for (const [marker, kind, target] of [
    ['@', 'none', undefined], ['\\', 'short', 'Save()'],
    ['@', 'full', 'int Save(int first, int second, int third)'], ['@', 'wrong', 'int Other(int x)']
  ] as const) {
    test(`renders adjacent documentation with ${marker}fn ${kind}`, () => {
      const body = [target === undefined ? '' : `${marker}fn ${target}`,
        'Plain description.', `${marker}param first(i) First value`,
        `${marker}param second (i) Second value`, `${marker}param third (i) Third value`,
        `${marker}return 0 Success`, `${marker}retval 1 Failure`].filter(Boolean).join('\n');
      const input = analyzeMarked(`/*!\n${body}\n*/\nint Sa|ve(int first, int second, int third) { return 0; }\nvoid main(){ Save(1,2,3); }`);
      const positions = kind === 'full'
        ? [input.position, positionFromOffset(input.text, input.text.lastIndexOf('Save'))] : [input.position];
      for (const position of positions) {
        const hover = getHover({...input,position,workspaceIndex:{}});
        assert.ok(hover?.plainText.includes('First value'));
        assert.ok(hover?.plainText.includes('first(i)'));
        assert.ok(hover?.plainText.includes('(i) Second value'));
        assert.ok(hover?.plainText.includes('0 Success'));
        assert.ok(hover?.plainText.includes('Failure'));
        assert.strictEqual(hover?.plainText.includes('Plain description.'), target === undefined);
        assert.ok(!hover?.plainText.includes('Unmatched parameters'));
        assert.ok(!hover?.plainText.includes(`${marker}fn`));
        assert.ok(!hover?.plainText.includes(`${marker}param`));
      }
      if (kind === 'full') {
        const completion = getCompletions({...input,position:positionFromOffset(input.text,input.text.lastIndexOf('Save')+2),workspaceIndex:{}}).find(item=>item.name==='Save');
        assert.ok(completion?.documentation?.includes('First value'));
        const help = getSignatureHelp({...input,position:positionFromOffset(input.text,input.text.lastIndexOf('2')),workspaceIndex:{}});
        assert.ok(help?.signatures[0].documentation?.includes('first(i)'));
        assert.strictEqual(help?.signatures[0].parameters[0].documentation,undefined);
        assert.ok(help?.signatures[0].parameters[1].documentation?.includes('(i) Second value'));
      }
      assert.ok(!input.analysis.declarations.some(d=>d.name==='Other'));
    });
  }
  test('keeps explicit brief and details after fn', () => {
    const input = analyzeMarked('/*! @fn Save()\nHidden text.\n@brief Visible summary.\n@details Visible details.\n*/\nint Sa|ve(int value) { return value; }');
    const hover = getHover({...input,workspaceIndex:{}});
    assert.ok(hover?.plainText.includes('Visible summary.'));
    assert.ok(hover?.plainText.includes('Visible details.'));
    assert.ok(!hover?.plainText.includes('Hidden text.'));
    assert.ok(input.analysis.documentationBlocks?.[0].document.source.raw.includes('Hidden text.'));
  });
  test('keeps unmatched parameter labels in their written order', () => {
    const input = analyzeMarked('/*! @param first(i) First\n@param second Second\n*/\nint Sa|ve(int first, int second);');
    const declaration = input.analysis.declarations.find(d=>d.name==='Save')!;
    const bound = bindDocumentation(input.analysis,[input.analysis],input.analysis.declarations).get(declaration.id)!;
    assert.deepStrictEqual(bound.unmatchedParameters.map(p=>p.names), [['first(i)']]);
    const text = getHover({...input,workspaceIndex:{}})!.plainText;
    assert.ok(text.indexOf('first(i)') < text.lastIndexOf('second'));
  });
  test('resumes body text after the fn paragraph ends', () => {
    for (const body of ['Hidden paragraph.\n\nVisible paragraph.', '\nVisible paragraph.']) {
      const input = analyzeMarked(`/*! @fn Save()\n${body}\n*/\nint Sa|ve();`);
      const hover = getHover({...input,workspaceIndex:{}});
      assert.ok(hover?.plainText.includes('Visible paragraph.'));
      assert.ok(!hover?.plainText.includes('Hidden paragraph.'));
    }
  });
  test('does not duplicate adjacent documentation onto an existing named target', () => {
    const source = 'int Other();\n/*! @fn int Other()\n@brief Attached to Save.\n*/\nint Save();\nvoid main(){ Other(); Save(); }';
    const input = analyzeMarked(source.replace('int Save()', 'int Sa|ve()'));
    assert.ok(getHover({...input,workspaceIndex:{}})?.plainText.includes('Attached to Save.'));
    const position = positionFromOffset(input.text,input.text.lastIndexOf('Other'));
    assert.ok(!getHover({...input,position,workspaceIndex:{}})?.plainText.includes('Attached to Save.'));
  });

});
