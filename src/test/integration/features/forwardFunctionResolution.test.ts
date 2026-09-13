import * as assert from 'assert';
import { getHover } from '../../../analyzer/hover';
import { getDefinitions, getReferences } from '../../../analyzer/navigation';
import { getSignatureHelp } from '../../../analyzer/signatureHelp';
import { getCompletions } from '../../../analyzer/completion';
import { findLocalDeclaration } from '../../../analyzer/resolution';
import { analyzeMarked, positionFromOffset } from '../../support/source';

suite('Forward function resolution', () => {
  const source = 'void main(){ Sa|ve(1); }\n/*! @brief Saves a value.\n * @param value Value to save.\n */\nint Save(int value) { return value; }';
  test('shows the later function signature and documentation at its call', () => {
    const input = analyzeMarked(source);
    const hover = getHover({...input,workspaceIndex:{}});
    assert.ok(hover?.plainText.includes('int Save(int value)'));
    assert.ok(hover?.plainText.includes('Saves a value.'));
  });
  test('navigates to a later definition and finds the preceding call', () => {
    const input = analyzeMarked(source);
    const target = input.analysis.declarations.find(d => d.name === 'Save')!;
    assert.deepStrictEqual(getDefinitions({...input,workspaceIndex:{}}), [{uri:target.uri,range:target.selectionRange}]);
    const references = getReferences({...input,position:target.selectionRange.start,workspaceIndex:{},includeDeclaration:false});
    assert.strictEqual(references.length,1);
    assert.strictEqual(references[0].range.start.line,0);
  });
  test('provides signature help and completion for the later function', () => {
    const input = analyzeMarked(source);
    const position = positionFromOffset(input.text,input.text.indexOf('1'));
    const help = getSignatureHelp({...input,position,workspaceIndex:{}});
    assert.strictEqual(help?.signatures[0].label,'int Save(int value)');
    assert.ok(help?.signatures[0].parameters[0].documentation?.includes('Value to save.'));
    assert.ok(getCompletions({...input,workspaceIndex:{}}).some(item => item.name === 'Save'));
  });
  test('includes later overloads when selecting by argument count', () => {
    const input = analyzeMarked('int Save(int n);\nvoid main(){ Sa|ve(1, 2); }\nint Save(int n, int m) { return n + m; }');
    assert.ok(getHover({...input,workspaceIndex:{}})?.plainText.includes('int Save(int n, int m)'));
  });
  test('does not expose later variables or unrelated class methods', () => {
    for (const source of ['void main(){ va|lue; int value; }', 'void main(){ va|lue; } int value;', 'void main(){ Sa|ve(); } class Other { int Save(); };']) {
      const input = analyzeMarked(source);
      const name = source.includes('va|lue') ? 'value' : 'Save';
      assert.strictEqual(findLocalDeclaration(input.analysis,name,input.position),undefined);
    }
  });
  test('preserves nearer variable shadowing over a later global function', () => {
    const input = analyzeMarked('void main(){ int Save; Sa|ve; }\nint Save() { return 1; }');
    assert.strictEqual(findLocalDeclaration(input.analysis,'Save',input.position)?.kind,'variable');
  });
});
