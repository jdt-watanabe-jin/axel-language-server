import * as assert from 'assert';
import { getFormattingEdits } from '../../../analyzer/formatting';

suite('getFormattingEdits', () => {

  test('indents and dedents without changing comments and is idempotent', () => {
    const text = 'void main() {\nint value;\nif (value) {\n// keep spacing   inside comment\nprintf("ok");\n}\n}\n';
    const options = { insertSpaces: true, tabSize: 2 };
    const edits = getFormattingEdits({ text, options });
    const lines = text.split('\n');
    for (const edit of [...edits].reverse()) {
      const { start, end } = edit.range;
      assert.strictEqual(start.line, end.line);
      lines[start.line] = lines[start.line].slice(0, start.character) + edit.newText + lines[start.line].slice(end.character);
    }
    const formatted = lines.join('\n');
    assert.strictEqual(formatted, 'void main() {\n  int value;\n  if (value) {\n    // keep spacing   inside comment\n    printf("ok");\n  }\n}\n');
    assert.deepStrictEqual(getFormattingEdits({ text: formatted, options }), []);
  });

  test('returns no edits for malformed input', () => {
    const text = [
      'void main() {',
      'int value;',
      ''
    ].join('\n');

    assert.deepStrictEqual(getFormattingEdits({
      text,
      options: { insertSpaces: true, tabSize: 4 }
    }), []);
  });

  test('range formatting does not edit outside the requested range', () => {
    const text = [
      'void main() {',
      'int outer;',
      'if (outer) {',
      'printf("ok\\n");',
      '}',
      '}',
      ''
    ].join('\n');

    const edits = getFormattingEdits({
      text,
      options: { insertSpaces: true, tabSize: 2 },
      range: { start: { line: 2, character: 0 }, end: { line: 5, character: 0 } }
    });

    assert.deepStrictEqual(edits, [{
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
      newText: '  '
    }, {
      range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } },
      newText: '    '
    }, {
      range: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } },
      newText: '  '
    }]);
  });
});
