import * as assert from 'assert';
import { japaneseMessages } from '../../i18n/ja';
import { formatMessage } from '../../i18n/messages';

suite('message localization', () => {
  test('preserves argument text and translates nested templates without translating identifiers', () => {
    const descriptor = {
      key: "Function '{0}' expects {1}, but got {2}.",
      args: ['name{1}$&', { key: '{0} argument', args: [1] }, 0]
    };
    assert.strictEqual(formatMessage(descriptor, 'JA-jp'), "関数'name{1}$&'には引数1個が必要ですが、0個が指定されています。");
    assert.strictEqual(formatMessage(descriptor, 'fr'), "Function 'name{1}$&' expects 1 argument, but got 0.");
  });

  test('falls back to the English template for missing translations and handles prototype names as text', () => {
    assert.strictEqual(formatMessage({ key: 'Future message {0}', args: ['{2}'] }, 'ja'), 'Future message {2}');
    assert.strictEqual(formatMessage({ key: 'toString' }, 'ja'), 'toString');
    assert.strictEqual(formatMessage({ key: '__proto__' }, 'ja'), '__proto__');
    assert.strictEqual(formatMessage({ key: 'Syntax error.' }, 'japanese'), 'Syntax error.');
    assert.strictEqual(formatMessage({ key: 'Missing {0}.' }, 'ja'), '{0}がありません。');
  });

  test('translations retain the full set of substitution arguments', () => {
    const placeholders = (text: string) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort();
    for (const [key, translation] of Object.entries(japaneseMessages)) {
      assert.deepStrictEqual(placeholders(translation), placeholders(key), key);
    }
  });
});
