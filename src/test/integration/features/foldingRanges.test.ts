import * as assert from 'assert';
import { createAxelParser } from '../../../analyzer/axelParser';
import { collectFoldingRangesSteps, type FoldingRangeCandidate } from '../../../analyzer/foldingRanges';
import { runAnalysisSteps } from '../../../util/analysisSteps';

suite('Folding ranges', () => {
  function collect(text: string): FoldingRangeCandidate[] {
    const tree = createAxelParser().parse(text);
    return runAnalysisSteps(collectFoldingRangesSteps(tree.rootNode, text));
  }

  test('uses brace lines and keeps if and else bodies independent', () => {
    const text = [
      'void main() {',
      'if (ok) {',
      'first();',
      'second();',
      '} else {',
      'fallback();',
      '}',
      '}'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 6 },
      { startLine: 1, endLine: 3 },
      { startLine: 4, endLine: 5 }
    ]);
  });

  test('moves brace boundaries to their physical lines and keeps same-end nesting', () => {
    const text = [
      'void nextLine()',
      '{',
      'work();',
      '}',
      'void empty() {',
      '',
      '}',
      'void sameLine() {',
      'work(); }',
      'int nested[] = {',
      '{',
      '1',
      '}};'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 1, endLine: 2 },
      { startLine: 4, endLine: 5 },
      { startLine: 9, endLine: 11 },
      { startLine: 10, endLine: 11 }
    ]);
  });

  test('collects declaration bodies and nested initializer lists', () => {
    const text = [
      'struct S {', 'int member;', '};',
      'class C {', 'void method() {', 'work();', '}', '};',
      'union U {', 'int value;', '};',
      'enum E {', 'First,', 'Second', '};',
      'int values[] = {', '1,', '{', '2,', '3', '}', '};'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 1 },
      { startLine: 3, endLine: 6 },
      { startLine: 4, endLine: 5 },
      { startLine: 8, endLine: 9 },
      { startLine: 11, endLine: 13 },
      { startLine: 15, endLine: 20 },
      { startLine: 17, endLine: 19 }
    ]);
  });

  test('collects loop switch try catch and standalone blocks without case ranges', () => {
    const text = [
      'void flow() {',
      'switch (value) {',
      'case 1:',
      '{',
      'inside();',
      '}',
      'default:',
      'fallback();',
      '}',
      'for (;;) {',
      'repeat();',
      '}',
      'while (ready) {',
      'wait();',
      '}',
      'do {',
      'again();',
      '} while (ready);',
      'try {',
      'run();',
      '} catch (Error error) {',
      'recover();',
      '}',
      '}'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 22 },
      { startLine: 1, endLine: 7 },
      { startLine: 3, endLine: 4 },
      { startLine: 9, endLine: 10 },
      { startLine: 12, endLine: 13 },
      { startLine: 15, endLine: 16 },
      { startLine: 18, endLine: 19 },
      { startLine: 20, endLine: 21 }
    ]);
  });

  test('uses control keywords for unbraced bodies and treats else-if as one branch', () => {
    const text = [
      'void flow() {',
      'if (first)',
      'one();',
      'else if (',
      'second',
      ')',
      'two();',
      'else',
      'three();',
      'for (',
      'int i = 0;',
      'i < 1;',
      'i++',
      ')',
      'step();',
      'while (ready)',
      'wait();',
      'do',
      'again();',
      'while (ready);',
      '}'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 19 },
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 6 },
      { startLine: 7, endLine: 8 },
      { startLine: 9, endLine: 14 },
      { startLine: 15, endLine: 16 },
      { startLine: 17, endLine: 18 }
    ]);
  });

  test('keeps trailing same-line syntax visible and ignores comments before else bodies', () => {
    const text = [
      'void flow() {',
      'while (',
      'ready',
      ')',
      'wait(); next();',
      'if (first)',
      'one();',
      'else /* explanation',
      'continues */',
      'two();',
      '}'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 9 },
      { startLine: 1, endLine: 3 },
      { startLine: 5, endLine: 6 },
      { startLine: 7, endLine: 9 }
    ]);
  });

  test('ignores trailing comments but preserves actual following syntax for unbraced bodies', () => {
    const text = [
      'void flow() {',
      'if (first)',
      'one(); // note',
      'if (second)',
      'two(); /* note */',
      'if (third)',
      'three(); next();',
      '}'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 6 },
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 4 }
    ]);
  });

  test('omits an unbraced body whose terminal semicolon is missing', () => {
    const text = [
      'void main() {',
      'if (ready)',
      'action()',
      '}'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 2 }
    ]);
  });

  test('collects GUI containers and event bodies but not scalar attributes', () => {
    const text = [
      'class Dialog : public GCDialog {',
      'GCVBoxLayout {',
      'GCGroupBox group {',
      'GCText input;',
      'GCPushButton button {',
      'OnPush() {',
      'action();',
      '}',
      '};',
      '};',
      '};',
      '};'
    ].join('\n');
    const tree = createAxelParser().parse(text);
    assert.strictEqual(tree.rootNode.hasError, false, tree.rootNode.toString());
    assert.deepStrictEqual(runAnalysisSteps(collectFoldingRangesSteps(tree.rootNode, text)), [
      { startLine: 0, endLine: 10 },
      { startLine: 1, endLine: 9 },
      { startLine: 2, endLine: 8 },
      { startLine: 4, endLine: 7 },
      { startLine: 5, endLine: 6 }
    ]);
  });

  test('folds terminated block comments and shortens a terminator line with following code', () => {
    const text = [
      '/* 日本語',
      ' * documentation',
      ' */',
      '/* second',
      ' * middle',
      ' */ int value;',
      '/* unterminated',
      '#region false',
      '{ false }'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 2, kind: 'comment' },
      { startLine: 3, endLine: 4, kind: 'comment' }
    ]);
  });

  test('does not treat a continued line comment ending in block-comment text as a block comment', () => {
    const text = '// continued \\\nends with */';
    assert.deepStrictEqual(collect(text), []);
  });

  test('handles Japanese and astral text before comment terminators', () => {
    const text = [
      '/* first',
      ' 日本語😀 */',
      '/* second',
      ' * middle',
      ' 日本語😀 */ int value;'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 1, kind: 'comment' },
      { startLine: 2, endLine: 3, kind: 'comment' }
    ]);
  });

  test('retains preceding folds and suppresses syntax and regions inside an unterminated comment', () => {
    const text = [
      'void real() {',
      'int value;',
      '}',
      '/* unclosed',
      '#region fake',
      'void fake() {',
      'int hidden;',
      '}',
      '#endregion'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 1 }
    ]);
  });

  test('collects complete conditional groups and each later branch', () => {
    const text = [
      '#if FIRST',
      'int first;',
      '#elifdef SECOND',
      'int second;',
      '#elifndef THIRD',
      'int third;',
      '#else',
      'int fallback;',
      '#endif'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 7 },
      { startLine: 2, endLine: 3 },
      { startLine: 4, endLine: 5 },
      { startLine: 6, endLine: 7 }
    ]);
  });

  test('handles nested conditionals and omits empty branches', () => {
    const text = [
      '#ifdef OUTER',
      '#if INNER',
      'int nested;',
      '#endif',
      '#else',
      '#endif'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 4 },
      { startLine: 1, endLine: 2 }
    ]);
  });

  test('collects multiline object and function macros for LF and CRLF', () => {
    for (const newline of ['\n', '\r\n']) {
      const text = [
        '#define OBJECT one \\',
        '  two \\',
        '  three',
        '#define FUNCTION(x) x + \\',
        '  1',
        'int after;'
      ].join(newline);
      assert.deepStrictEqual(collect(text), [
        { startLine: 0, endLine: 2 },
        { startLine: 3, endLine: 4 }
      ]);
    }
  });

  test('does not extend macros through unterminated comments', () => {
    for (const text of [
      ['#define VALUE 1 /* unclosed', 'void fake() {', 'int hidden;', '}'].join('\n'),
      ['#define VALUE 1 \\', '  2 /* unclosed', 'void fake() {', 'int hidden;', '}'].join('\n')
    ]) {
      assert.deepStrictEqual(collect(text), []);
    }
  });

  test('keeps a multiline macro ending at EOF despite its missing newline token', () => {
    const text = ['#define VALUE 1 \\', '  2'].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 1 }
    ]);
  });

  test('pairs nested region directives and ignores false or unmatched markers', () => {
    const text = [
      '#region Outer label',
      'int first;',
      '#  region Inner',
      'int nested;',
      '#endregion',
      'int last;',
      '# endregion',
      '#Region wrongCase',
      'const char *text = "#region string";',
      '/* #region comment',
      '#endregion */',
      '#define VALUE #region macro',
      '#endregion',
      '#region unmatched'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 5, kind: 'region' },
      { startLine: 2, endLine: 3, kind: 'region' },
      { startLine: 9, endLine: 10, kind: 'comment' }
    ]);
  });

  test('requires region directives to start after indentation only', () => {
    const text = [
      '#region real',
      'int first;',
      'int value; #region false',
      'int last;',
      '#endregion'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 3, kind: 'region' }
    ]);
  });

  test('rejects missing terminators while retaining complete inner bodies', () => {
    const text = [
      'void broken() {',
      'if (ok) {',
      'work();',
      '}',
      '#if MISSING',
      'int value;'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 1, endLine: 2 }
    ]);
  });

  test('normalizes crossing syntax and region ranges deterministically', () => {
    const text = [
      'void function() {',
      '#region crossing',
      'inside();',
      '}',
      '{',
      'outside();',
      '}',
      '#endregion'
    ].join('\n');
    assert.deepStrictEqual(collect(text), [
      { startLine: 0, endLine: 2 },
      { startLine: 4, endLine: 5 }
    ]);
  });

  test('traverses deep nesting iteratively and yields cooperatively', () => {
    const depth = 300;
    const text = '{\n'.repeat(depth) + 'work();\n' + '}\n'.repeat(depth);
    const tree = createAxelParser().parse(text);
    const steps = collectFoldingRangesSteps(tree.rootNode, text);
    let yielded = 0;
    let next = steps.next();
    while (!next.done) { yielded += 1; next = steps.next(); }
    assert.ok(yielded > 1);
    assert.strictEqual(next.value.length, depth);
    assert.deepStrictEqual(next.value[0], { startLine: 0, endLine: depth * 2 - 1 });
    assert.deepStrictEqual(next.value.at(-1), { startLine: depth - 1, endLine: depth });
  });
});
