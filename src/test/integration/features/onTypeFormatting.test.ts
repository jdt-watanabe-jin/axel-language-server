import * as assert from 'assert';
import { getOnTypeFormattingEdits } from '../../../analyzer/formatting';
import type { AnalysisPosition, AnalysisTextEdit } from '../../../types/analysis';

const options = { insertSpaces: true, tabSize: 2 };
const format = (text: string, position: AnalysisPosition, ch: string, settings = options): AnalysisTextEdit[] => {
  return getOnTypeFormattingEdits({ text, position, ch, options: settings });
};
const edit = (line: number, end: number, newText: string): AnalysisTextEdit[] => [{
  range: { start: { line, character: 0 }, end: { line, character: end } }, newText
}];

suite('getOnTypeFormattingEdits', () => {
  test('indents an empty new line in an unfinished block', () => {
    assert.deepStrictEqual(format('void main() {\n', { line: 1, character: 0 }, '\n'), edit(1, 0, '  '));
  });
  test('dedents only the newly typed closing brace line despite unrelated syntax errors', () => {
    assert.deepStrictEqual(format('void main() {\n  if value {\n      }\ninvalid @', { line: 2, character: 7 }, '}'), edit(2, 6, '  '));
  });
  test('honors tabs with CRLF and preserves already correct indentation', () => {
    assert.deepStrictEqual(format('void main() {\r\n  ', { line: 1, character: 2 }, '\n', { insertSpaces: false, tabSize: 4 }), edit(1, 2, '\t'));
    assert.deepStrictEqual(format('void main() {\n  ', { line: 1, character: 2 }, '\n'), []);
  });
  test('ignores braces in strings, character literals and comments', () => {
    assert.deepStrictEqual(format('void main() {\nprint("{\\"{"); char c = \'}\'; // {\n/* { } */\n', { line: 3, character: 0 }, '\n'), edit(3, 0, '  '));
  });
  test('does not edit closing braces typed inside comments or strings', () => {
    for (const line of ['  // }', '  print("}', '  /* }']) {
      assert.deepStrictEqual(format('void main() {\n' + line, { line: 1, character: line.length }, '}'), []);
    }
    assert.deepStrictEqual(format('void main() {\n/* comment\n    }', { line: 2, character: 5 }, '}'), []);
  });
  test('leaves new lines inside unterminated comments and strings alone', () => {
    for (const prefix of ['void main() {\n/* comment', 'void main() {\nprint("unterminated']) {
      assert.deepStrictEqual(format(prefix + '\n', { line: 2, character: 0 }, '\n'), []);
    }
  });
  test('ignores macro braces and leaves continued preprocessor lines alone', () => {
    assert.deepStrictEqual(format('#define OPEN {\nvoid main() {\n', { line: 2, character: 0 }, '\n'), edit(2, 0, '  '));
    assert.deepStrictEqual(format('void main() {\n#define MACRO \\\n', { line: 2, character: 0 }, '\n'), []);
    assert.deepStrictEqual(format('void main() {\n#define MACRO \\\n{\n', { line: 3, character: 0 }, '\n'), edit(3, 0, '  '));
  });
  test('ignores macro braces after leading comments, including multiline comment endings', () => {
    assert.deepStrictEqual(format('void main() {\n/* note */ #define OPEN {\n  ', { line: 2, character: 2 }, '\n'), []);
    assert.deepStrictEqual(format('void main() {\n/* note\n*/ #define OPEN {\n', { line: 3, character: 0 }, '\n'), edit(3, 0, '  '));
    assert.deepStrictEqual(format('void main() {\n/* note */ #define OPEN {', { line: 1, character: 0 }, '\n'), []);
  });
  test('preserves indentation after conditional preprocessing instead of combining branch depths', () => {
    const prefix = 'void main() {\n#if OPTION\nif (a) {\n#else\nif (b) {\n#endif\n';
    assert.deepStrictEqual(format(prefix + '    ', { line: 6, character: 4 }, '\n'), []);
    assert.deepStrictEqual(format(prefix + '    }', { line: 6, character: 5 }, '}'), []);
    assert.deepStrictEqual(format('void main() {\n/* comment */ #ifdef OPTION\n', { line: 2, character: 0 }, '\n'), []);
    assert.deepStrictEqual(format('void main() {\n/* comment\n*/ #ifndef OPTION\n', { line: 3, character: 0 }, '\n'), []);
  });
  test('preserves native continuation indentation in parentheses and brackets', () => {
    for (const text of ['void main() {\n  call(\n      ', 'void main() {\n  array[\n      ']) {
      assert.deepStrictEqual(format(text, { line: 2, character: 6 }, '\n'), []);
    }
  });
  test('does not infer indentation from unsupported backtick tokens', () => {
    assert.deepStrictEqual(format('void main() {\n  print(`{`);\n', { line: 2, character: 0 }, '\n'), []);
  });
  test('preserves block comments opened in macro replacement text', () => {
    assert.deepStrictEqual(format('void main() {\n#define VALUE /* comment\n    }', { line: 2, character: 5 }, '}'), []);
  });
  test('dedents an existing closing brace after a new line without changing its token', () => {
    assert.deepStrictEqual(format('void main() {\n  }', { line: 1, character: 2 }, '\n'), edit(1, 2, ''));
  });
  test('does not reformat after unsupported triggers or positions within code', () => {
    assert.deepStrictEqual(format('void main() {\n    work(); }', { line: 1, character: 13 }, '}'), []);
    assert.deepStrictEqual(format('void main() {\nvalue', { line: 1, character: 2 }, '\n'), []);
    assert.deepStrictEqual(format('void main() {\n', { line: 1, character: 0 }, ';'), []);
    assert.deepStrictEqual(format('void main() {\n', { line: 8, character: 0 }, '\n'), []);
  });
});
