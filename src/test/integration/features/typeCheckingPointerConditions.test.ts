import * as assert from 'assert';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { collectTypeDiagnostics } from '../../../analyzer/typeChecking/diagnostics';

suite('Type checking: pointer conditions', () => {
  function check(body: string) {
    const text = 'class Item { int x; int IsSelected(){return 1;} }; void f(Item *item, Item *other, int flag){' + body + '}';
    const analysis = new DocumentAnalyzer().analyzeDocument({uri: 'file:///pointer-conditions.axl', version: 1, text});
    assert.deepStrictEqual(analysis.diagnostics, []);
    return collectTypeDiagnostics({analysis});
  }

  test('accepts a pointer guarding an integer-returning member call', () => {
    assert.deepStrictEqual(check('if(item && item->IsSelected()){}'), []);
  });

  test('accepts pointer and numeric logical operands in either order with integer results', () => {
    for (const expression of ['item && flag', 'flag && item', 'item || flag', 'flag || item', 'item && other', 'item || NULL', 'NULL && flag', 'item && 1.0']) {
      assert.deepStrictEqual(check('int result = ' + expression + ';'), [], expression);
    }
  });

  test('preserves pointer conditions and negation', () => {
    assert.deepStrictEqual(check('if(item){} while(item){break;} for(;item;){break;} int result = item ? 1 : 0; if(!item){}'), []);
  });

  test('still rejects bitwise pointer operations and pointer-integer equality', () => {
    for (const expression of ['item & flag', 'item | flag', 'item == flag', 'item * flag']) {
      assert.deepStrictEqual(check(expression + ';').map(d => d.code), ['axel.type.binary_operator'], expression);
    }
  });

  test('does not accept an arbitrary class value as a logical operand', () => {
    assert.deepStrictEqual(check('Item value; item && value;').map(d => d.code), ['axel.type.binary_operator']);
  });
});
