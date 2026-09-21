import * as assert from 'assert';
import { WorkspaceDerivedCache } from '../../analyzer/workspaceDerivedCache';

suite('Workspace derived cache', () => {
  test('invalidates selected entries across caches using a single-use iterable', () => {
    const a = new Map<string, unknown>([['changed', 1], ['unrelated', 2]]);
    const b = new Map<string, unknown>([['changed', 3], ['unrelated', 4]]);
    const cache = new WorkspaceDerivedCache([a, b]);
    cache.invalidate((function* () { yield 'changed'; })());
    assert.deepStrictEqual([...a], [['unrelated', 2]]);
    assert.deepStrictEqual([...b], [['unrelated', 4]]);
    cache.invalidate();
    assert.strictEqual(a.size + b.size, 0);
  });
});
