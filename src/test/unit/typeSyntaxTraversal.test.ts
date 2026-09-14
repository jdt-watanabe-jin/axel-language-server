import * as assert from 'assert';
import { descendants, type TypeNode } from '../../analyzer/typeChecking/syntax';

suite('Immutable type syntax traversal', () => {
  test('reuses repeated searches while keeping new document generations independent', () => {
    let visits = 0;
    function node(kind: string, children: TypeNode[] = []): TypeNode {
      return { kind, text: '', start: 0, end: 0, fields: {},
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        get children() { visits++; return children; } };
    }
    const directive = node('preproc_call');
    const root = node('translation_unit', [directive, node('class_specifier')]);
    assert.deepStrictEqual(descendants(root, 'preproc_call'), [directive]);
    const initialVisits = visits;
    for (let n = 0; n < 20; n++) { assert.deepStrictEqual(descendants(root, 'preproc_call'), [directive]); }
    assert.strictEqual(visits, initialVisits, 'unchanged headers must not be traversed on every include');
    assert.deepStrictEqual(descendants(node('translation_unit'), 'preproc_call'), []);
    assert.deepStrictEqual(descendants(root, 'class_specifier').map(n => n.kind), ['class_specifier']);
  });
});
