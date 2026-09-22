import * as assert from 'assert';
import { validateSettings } from '../../lsp/configuration';

suite('Language settings validation', () => {
  test('rejects invalid values independently for every live language feature setting', () => {
    const invalid = [
      { hover: 'invalid' }, { autocomplete: null }, { codeLens: { enabled: 'bad' } },
      { inlayHints: { parameterNames: { enabled: 'invalid' } } },
      { inlayHints: { parameterNames: { suppressWhenArgumentContainsName: 'invalid' } } },
      { errorSquiggles: 'invalid' }
    ];
    for (const settings of invalid) {
      assert.throws(() => validateSettings(settings), Error, JSON.stringify(settings));
    }
  });
});
