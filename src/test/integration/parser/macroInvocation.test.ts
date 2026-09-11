import * as assert from 'assert';

import { parseMacroInvocationText } from '../../../analyzer/macroInvocation';

suite('macroInvocation', () => {

  test('splits nested and quoted arguments', () => {
    assert.deepStrictEqual(parseMacroInvocationText('M(foo(1, 2), "a,b", value /*,*/ )'), {
      name: 'M',
      arguments: ['foo(1, 2)', '"a,b"', 'value /*,*/']
    });
  });

  test('rejects text that is not exactly one macro invocation', () => {
    assert.strictEqual(parseMacroInvocationText('M(a); int x;'), undefined);
    assert.strictEqual(parseMacroInvocationText('value'), undefined);
    assert.strictEqual(parseMacroInvocationText('M('), undefined);
  });

  test('rejects malformed argument delimiters', () => {
    assert.strictEqual(parseMacroInvocationText('M(a])'), undefined);
    assert.strictEqual(parseMacroInvocationText('M(a[1)'), undefined);
  });

  test('does not close invocations with parentheses inside comments', () => {
    assert.strictEqual(parseMacroInvocationText('M(a /* )'), undefined);
    assert.strictEqual(parseMacroInvocationText('M(a // )'), undefined);
  });
});
