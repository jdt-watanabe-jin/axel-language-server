import * as assert from 'assert';
import { createAxelParser } from '../../../analyzer/axelParser';
import { collectInactivePreprocessorRanges, evaluatePreprocessor } from '../../../analyzer/preprocessorEvaluation';

suite('system preprocessor', () => {
  test('always defines the console macro with the Tool value and ignores overrides', () => {
    for (const [tool, value] of [['axel', 1], ['ismo', 0], ['asca', 0], ['spicechart', 0]] as const) {
      for (const prefix of ['', '#define __AXELCONSOLE__ 9\n#undef __AXELCONSOLE__\n']) {
        for (const condition of ['#ifdef __AXELCONSOLE__', `#if defined(__AXELCONSOLE__) && __AXELCONSOLE__ == ${value}`, '#ifndef __AXELCONSOLE__']) {
          const root = createAxelParser().parse(`${prefix}${condition}\nint active;\n#else\nint inactive;\n#endif\n`).rootNode;
          assert.strictEqual(root.hasError, false);
          const offset = prefix === '' ? 0 : 2;
          assert.deepStrictEqual(collectInactivePreprocessorRanges(root, [{ name: '__AXELCONSOLE__', value: '9' }], tool).map(range => range.start.line), [offset + (condition.startsWith('#ifndef') ? 1 : 3)]);
        }
      }
    }
  });

  test('evaluates the system version as 510 and ignores overrides for every tool', () => {
    for (const tool of ['axel', 'ismo', 'asca', 'spicechart']) {
      for (const prefix of ['', '#define __AXELVERSION__ 0\n#undef __AXELVERSION__\n']) {
        for (const condition of ['#ifdef __AXELVERSION__', '#if defined(__AXELVERSION__) && __AXELVERSION__ == 510', '#ifndef __AXELVERSION__']) {
          const root = createAxelParser().parse(`${prefix}${condition}\nint active;\n#else\nint inactive;\n#endif\n`).rootNode;
          assert.strictEqual(root.hasError, false);
          const offset = prefix === '' ? 0 : 2;
          assert.deepStrictEqual(collectInactivePreprocessorRanges(root, [{ name: '__AXELVERSION__', value: '0' }], tool).map(range => range.start.line), [offset + (condition.startsWith('#ifndef') ? 1 : 3)]);
        }
      }
    }
  });

  test('defines __AXEL__ as one for every tool and ignores overrides', () => {
    for (const tool of ['axel', 'ismo', 'asca', 'spicechart']) {
      for (const prefix of ['', '#define __AXEL__ 0\n#undef __AXEL__\n']) {
        for (const condition of ['#ifdef __AXEL__', '#if defined(__AXEL__) && __AXEL__ == 1', '#ifndef __AXEL__']) {
          const root = createAxelParser().parse(`${prefix}${condition}\nint active;\n#else\nint inactive;\n#endif\n`).rootNode;
          assert.strictEqual(root.hasError, false);
          const offset = prefix === '' ? 0 : 2;
          assert.deepStrictEqual(collectInactivePreprocessorRanges(root, [{ name: '__AXEL__', value: '0' }], tool).map(range => range.start.line), [offset + (condition.startsWith('#ifndef') ? 1 : 3)]);
        }
      }
    }
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
