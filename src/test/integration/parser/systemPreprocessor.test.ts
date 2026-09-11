import * as assert from 'assert';
import { resolveSystemMacro } from '../../../analyzer/systemMacros';
import { createAxelParser } from '../../../analyzer/axelParser';
import { collectInactivePreprocessorRanges, evaluatePreprocessor } from '../../../analyzer/preprocessorEvaluation';

suite('system preprocessor', () => {
  test('defines tool-specific console and shared version values', () => {
    for (const [tool, consoleValue] of [['axel', 1], ['ismo', 0], ['asca', 0], ['spicechart', 0]] as const) {
      for (const [name, value] of [['__AXELCONSOLE__', consoleValue], ['__AXELVERSION__', 510], ['__AXEL__', 1]] as const) {
        const macro = resolveSystemMacro(name, 'file:///main.axl', { line: 0, character: 0 }, tool);
        assert.strictEqual(macro?.defined, true, name + ':' + tool);
        assert.strictEqual(macro?.value, value, name + ':' + tool);
      }
    }
  });

  test('ignores source and configuration overrides of reserved numeric macros', () => {
    const names = ['__AXELCONSOLE__', '__AXELVERSION__', '__AXEL__'];
    const source = names.flatMap(name => ['#define ' + name + ' 9', '#undef ' + name]).concat([
      '#if __AXELCONSOLE__ == 1 && __AXELVERSION__ == 510 && __AXEL__ == 1',
      'int active;', '#else', 'int inactive;', '#endif'
    ]).join('\n');
    const tree = createAxelParser().parse(source);
    assert.deepStrictEqual(collectInactivePreprocessorRanges(tree.rootNode, names.map(name => ({ name, value: '9' })), 'axel').map(range => range.start.line), [9]);
  });

  test('handles defined and undefined conditions for a reserved macro', () => {
    const tree = createAxelParser().parse('#ifdef __AXEL__\nint active;\n#else\nint inactive;\n#endif\n#ifndef __AXEL__\nint impossible;\n#endif');
    assert.deepStrictEqual(collectInactivePreprocessorRanges(tree.rootNode).map(range => range.start.line), [3, 6]);
  });

  test('always defines runtime macros without deciding their values', () => {
    const root = createAxelParser().parse('#ifdef __TIME__\nint active;\n#else\nint inactive;\n#endif\n').rootNode;
    assert.deepStrictEqual(collectInactivePreprocessorRanges(root).map(range => range.start.line), [3]);
  });

  test('retains both branches of runtime conditions', () => {
    const root = createAxelParser().parse('#if __TIME__\nint possible;\n#else\nint alternative;\n#endif\n').rootNode;
    assert.deepStrictEqual(collectInactivePreprocessorRanges(root), []);
  });

  for (const [tool, name] of [['ismo', '__APP_LEDIT__'], ['asca', '__APP_SEDIT__'], ['spicechart', '__APP_SCHART__']]) {
    test(`defines only the application macro for ${tool}`, () => {
      const root = createAxelParser().parse(`#if defined(${name}) && ${name} == 1\nint active;\n#else\nint inactive;\n#endif\n`).rootNode;
      assert.strictEqual(root.hasError, false);
      assert.deepStrictEqual(collectInactivePreprocessorRanges(root, [], tool).map(range => range.start.line), [3]);
      assert.deepStrictEqual(collectInactivePreprocessorRanges(root, [], 'axel').map(range => range.start.line), [1]);
    });
  }

  test('uses the physical one based line in conditions for LF and CRLF', () => {
    for (const newline of ['\n', '\r\n']) {
      const root = createAxelParser().parse(['', '#if __LINE__ == 2', 'int active;', '#else', 'int inactive;', '#endif', ''].join(newline)).rootNode;
      assert.deepStrictEqual(collectInactivePreprocessorRanges(root).map(range => range.start.line), [4]);
    }
  });

  test('ignores reserved mutations from source and configured definitions', () => {
    const root = createAxelParser().parse('#undef __TIME__\n#define __APP_LEDIT__ 1\n#if defined(__TIME__) && !defined(__APP_LEDIT__)\nint active;\n#else\nint inactive;\n#endif\n').rootNode;
    assert.deepStrictEqual(collectInactivePreprocessorRanges(root, [{ name: '__APP_LEDIT__', value: '1' }]).map(range => range.start.line), [5]);
  });

  test('merges possible definitions without choosing one as definite', () => {
    const root = createAxelParser().parse('#if __TIME__\n#define MAYBE 1\nint possible;\n#else\nint alternative;\n#endif\n#ifdef MAYBE\nint use;\n#else\nint other;\n#endif\n').rootNode;
    const result = evaluatePreprocessor(root);
    assert.deepStrictEqual(result.inactiveRanges, []);
    assert.deepStrictEqual(new Set(result.uncertainNames), new Set(['MAYBE', 'possible', 'alternative', 'use', 'other']));
    assert.ok(result.uncertainRanges.some(range => range.start.line === 7));
  });

  test('retains definite macros shared by all possible branches', () => {
    const root = createAxelParser().parse('#if __TIME__\n#define SAME 1\n#else\n#define SAME 1\n#endif\n#if SAME\nint active;\n#else\nint inactive;\n#endif\n').rootNode;
    assert.deepStrictEqual(collectInactivePreprocessorRanges(root).map(range => range.start.line), [8]);
  });

  test('keeps absent alternatives and differing values uncertain after merging', () => {
    const root = createAxelParser().parse('#define VALUE 1\n#if __TIME__\n#undef VALUE\n#endif\n#if defined(VALUE)\nint maybe;\n#else\nint other;\n#endif\n').rootNode;
    assert.deepStrictEqual(collectInactivePreprocessorRanges(root), []);
  });

  test('short circuits known logical results but leaves string comparisons unknown', () => {
    const root = createAxelParser().parse('#if __TIME__ && 0\nint inactive;\n#endif\n#if __DATE__ == __FILE__\nint maybe;\n#else\nint other;\n#endif\n').rootNode;
    assert.deepStrictEqual(collectInactivePreprocessorRanges(root).map(range => range.start.line), [1]);
  });

  test('evaluates elif in the incoming environment and merges differing values', () => {
    const root = createAxelParser().parse('#if __TIME__\n#define CHOICE 1\n#elif defined(CHOICE)\nint impossible;\n#else\n#define CHOICE 2\n#endif\n#if CHOICE == 1\nint first;\n#else\nint second;\n#endif\n').rootNode;
    assert.deepStrictEqual(collectInactivePreprocessorRanges(root).map(range => range.start.line), [3]);
  });

  test('collects each possible declaration and ignores inactive nested declarations', () => {
    const root = createAxelParser().parse('#if __TIME__\nint first, second;\n#if 0\nint impossible;\n#endif\n#endif\n').rootNode;
    const result = evaluatePreprocessor(root);
    assert.deepStrictEqual(new Set(result.uncertainNames), new Set(['first', 'second']));
    assert.deepStrictEqual(result.inactiveRanges.map(range => range.start.line), [3]);
  });
});
