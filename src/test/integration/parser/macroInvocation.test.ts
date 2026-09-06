import * as assert from 'assert';
import { createAxelParser } from '../../../analyzer/axelParser';
import {
macroInvocationCandidateFromErrorNode,
parseMacroInvocationText
} from '../../../analyzer/macroInvocation';

suite('macroInvocation', () => {
  test('parses simple function-like macro invocation text', () => {
    assert.deepStrictEqual(parseMacroInvocationText('define_stringMAP_one(int)'), {
      name: 'define_stringMAP_one',
      arguments: ['int']
    });
  });

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

  test('detects class body ERROR macro invocation candidates', () => {
    const parser = createAxelParser();
    const tree = parser.parse('class C { define_stringMAP_one(int) };');
    const errorNode = tree.rootNode.descendantsOfType('ERROR')[0];

    const candidate = macroInvocationCandidateFromErrorNode(errorNode);

    assert.deepStrictEqual(candidate && {
      name: candidate.name,
      arguments: candidate.arguments,
      argumentCount: candidate.argumentCount,
      context: candidate.context,
      rawText: candidate.rawText
    }, {
      name: 'define_stringMAP_one',
      arguments: ['int'],
      argumentCount: 1,
      context: 'classBody',
      rawText: 'define_stringMAP_one(int)'
    });
  });
});
