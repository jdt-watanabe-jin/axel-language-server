import * as assert from 'assert';
import { createAxelParser } from '../../analyzer/axelParser';
import { collectMacroDefinitions } from '../../analyzer/macroIndex';
import { expandMacroInvocationText, type MacroLookup } from '../../analyzer/macroExpansion';
import type { AnalysisMacroDefinition } from '../../types/analysis';

suite('macroExpansion', () => {

  test('expands ordinary arguments before forwarding to a stringifying macro', () => {
    const value = {...macro('VALUE', [], '42'), parameters: undefined};
    const lookup = lookupFrom([value, macro('STR', ['x'], '#x'), macro('WRAP', ['x'], 'STR(x)')]);
    assert.strictEqual(expandMacroInvocationText('STR(VALUE)', lookup).expandedText, '"VALUE"');
    assert.strictEqual(expandMacroInvocationText('WRAP(VALUE)', lookup).expandedText, '"42"');
    assert.strictEqual(expandMacroInvocationText('WRAP(x + y)', lookup).expandedText, '"x + y"');
  });

  test('handles line continuation after the stringification operator', () => {
    const lookup = lookupFrom([macro('STR', ['x'], '# \\\n x')]);
    assert.strictEqual(expandMacroInvocationText('STR(value)', lookup).expandedText, '"value"');
  });

  test('does not evaluate runtime macros used only in stringified arguments', () => {
    const lookup = lookupFrom([macro('STR', ['x'], '#x')]);
    const result = expandMacroInvocationText('STR(__DATE__)', lookup, {
      systemContext: {uri: 'file:///test.axl', position: {line: 0, character: 0}}
    });
    assert.strictEqual(result.expandedText, '"__DATE__"');
    assert.deepStrictEqual(result.runtimeMacros, []);
  });

  test('stringifies expressions and escapes quoted argument text', () => {
    const lookup = lookupFrom([macro('STR', ['value'], '#value')]);
    for (const [argument, expected] of [
      ['v0.m_major', 'v0.m_major'],
      ['0', '0'],
      [' a  + /* comment */ b ', 'a + b'],
      ['/**/', ''],
      ['"a  b\\c"', '"a  b\\c"'],
      ['a\\\nb', 'ab']
    ]) {
      const result = expandMacroInvocationText(`STR(${argument})`, lookup);
      assert.deepStrictEqual(result.diagnostics, []);
      assert.strictEqual(result.expandedText, JSON.stringify(expected));
    }
  });

  test('keeps raw arguments for stringification while expanding ordinary occurrences', () => {
    const lookup = lookupFrom([
      macro('VALUE', [], '42'),
      macro('BOTH', ['value'], '#value, value')
    ]);
    const options = {systemContext: {uri: 'file:///test.axl', position: {line: 9, character: 0}}};
    assert.strictEqual(expandMacroInvocationText('BOTH(VALUE())', lookup, options).expandedText, '"VALUE()", 42');
    assert.strictEqual(expandMacroInvocationText('BOTH(__LINE__)', lookup, options).expandedText, '"__LINE__", 10');
  });

  test('recognizes spaced stringification without changing hashes in literals or token pasting', () => {
    const lookup = lookupFrom([macro('STR', ['value'], '# /* comment */ value, "#value", value ## value')]);
    assert.strictEqual(expandMacroInvocationText('STR(name)', lookup).expandedText, '"name", "#value", name ## name');
  });

  test('expands nested function-like macros', () => {
    const source = '#define define_stringMAP_oneBase(p_class) stringMAP mMapL; \\\npublic: \\\r\nint Add(string key, p_class value) { return 1; }\n'
      + '#define define_stringMAP_one(p_class) define_stringMAP_oneBase(p_class) \\\np_class *Find(string key) { return NULL; }\n';
    const tree = createAxelParser().parse(source);
    const lookup = lookupFrom(collectMacroDefinitions(tree.rootNode, 'file:///macros.h'));

    const result = expandMacroInvocationText('define_stringMAP_one(int)', lookup);

    assert.strictEqual(result.truncated, false);
    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.expandedText, [
      'stringMAP mMapL;',
      'public:',
      'int Add(string key, int value) { return 1; }',
      'int *Find(string key) { return NULL; }'
    ].join('\n'));
  });

  test('does not substitute parameters inside strings or comments', () => {
    const lookup = lookupFrom([
      macro('LOG', ['value'], 'printf("value"); /* value */ value')
    ]);

    const result = expandMacroInvocationText('LOG(count)', lookup);

    assert.strictEqual(result.expandedText, 'printf("value"); /* value */ count');
  });

  test('returns diagnostics for nested wrong arity', () => {
    const lookup = lookupFrom([
      macro('ONE', ['value'], 'value'),
      macro('WRAP', ['value'], 'ONE(value, extra)')
    ]);

    const result = expandMacroInvocationText('WRAP(count)', lookup);

    assert.deepStrictEqual(result.diagnostics.map((diagnostic) => diagnostic.message), [
      "Macro 'ONE' expects 1 argument but got 2."
    ]);
  });

  test('ignores comments while matching nested invocation parentheses', () => {
    const lookup = lookupFrom([
      macro('INNER', ['value'], 'value'),
      macro('OUTER', ['value'], 'before INNER(value /* ) */) after')
    ]);

    const result = expandMacroInvocationText('OUTER(count)', lookup);

    assert.strictEqual(result.expandedText, 'before count /* ) */ after');
  });

  test('applies the depth limit to deeply nested argument invocations', () => {
    const lookup = lookupFrom([macro('ID', ['x'], 'x')]);
    const input = 'ID('.repeat(10) + '1' + ')'.repeat(10);
    assert.strictEqual(expandMacroInvocationText(input, lookup, {maxDepth: 3}).truncated, true);
    assert.strictEqual(expandMacroInvocationText('ID(ID(1))', lookup).expandedText, '1');
  });

  test('bounds recursion through ordinary macro arguments', () => {
    const lookup = lookupFrom([macro('A', ['x'], 'B(A(x))'), macro('B', ['x'], 'x'),
      macro('STR', ['x'], '#x'), macro('WRAP', ['x'], 'STR(x)')]);
    for (const systemContext of [undefined, {uri: 'file:///test.axl', position: {line: 0, character: 0}}]) {
      const result = expandMacroInvocationText('A(1)', lookup, {maxDepth: 3, systemContext});
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(expandMacroInvocationText('WRAP(A(1))', lookup, {maxDepth: 3, systemContext}).truncated, true);
    }
  });

  test('truncates recursive macro expansion', () => {
    const lookup = lookupFrom([
      macro('A', ['x'], 'A(x)')
    ]);

    const result = expandMacroInvocationText('A(value)', lookup, { maxDepth: 3 });

    assert.strictEqual(result.truncated, true);
  });
});

function macro(name: string, parameters: string[], replacementText: string): AnalysisMacroDefinition {
  return {
    name,
    uri: 'file:///macros.h',
    range: range(),
    selectionRange: range(),
    detail: `#define ${name}(${parameters.join(', ')}) ${replacementText}`,
    parameters: parameters.map((label) => ({ label })),
    replacementText
  };
}

function lookupFrom(macros: AnalysisMacroDefinition[]): MacroLookup {
  return {
    findMacro: (name) => macros
      .filter((macro) => macro.name === name)
      .at(-1)
  };
}

function range() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 }
  };
}
