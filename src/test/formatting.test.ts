import * as assert from 'assert';
import { getFormattingEdits } from '../analyzer/formatting';

suite('getFormattingEdits', () => {
  test('formats indentation idempotently', () => {
    const text = [
      'void main() {',
      '    int value;',
      '}',
      ''
    ].join('\n');

    assert.deepStrictEqual(getFormattingEdits({
      text,
      options: { insertSpaces: true, tabSize: 4 }
    }), []);
  });

  test('indents lines after opening braces and dedents closing braces', () => {
    const text = [
      'void main() {',
      'int value;',
      'if (value) {',
      'printf("ok\\n");',
      '}',
      '}',
      ''
    ].join('\n');

    const edits = getFormattingEdits({
      text,
      options: { insertSpaces: true, tabSize: 2 }
    });

    assert.deepStrictEqual(edits, [{
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      newText: '  '
    }, {
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

  test('does not change comment text while adjusting leading indentation', () => {
    const text = [
      'void main() {',
      '// keep spacing   inside comment',
      '}',
      ''
    ].join('\n');

    const edits = getFormattingEdits({
      text,
      options: { insertSpaces: true, tabSize: 4 }
    });

    assert.deepStrictEqual(edits, [{
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      newText: '    '
    }]);
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
