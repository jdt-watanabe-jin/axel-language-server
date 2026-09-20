import * as assert from 'assert';
import * as path from 'path';
import { normalizeWorkspaceIndexOptions } from '../../analyzer/workspaceConfig';

suite('workspace configuration snapshots', () => {
  test('normalizes and deduplicates only the supplied paths', () => {
    const options = normalizeWorkspaceIndexOptions({ includeRoots: ['a/b'], forcedIncludeFiles: ['a.h', 'a.h'] });
    assert.deepStrictEqual(options.includeRoots, [path.normalize('a/b')]);
    assert.deepStrictEqual(options.forcedIncludeFiles, ['a.h']);
  });
  test('empty arrays clear all forced includes', () => {
    assert.deepStrictEqual(normalizeWorkspaceIndexOptions({ forcedIncludeFiles: [] }).forcedIncludeFiles, []);
  });
  test('missing fields use defaults without retaining previous values', () => {
    normalizeWorkspaceIndexOptions({ includeRoots: ['old'], forcedIncludeFiles: ['old.h'], defines: ['OLD'] });
    const options = normalizeWorkspaceIndexOptions({});
    assert.deepStrictEqual(options.includeRoots, []);
    assert.deepStrictEqual(options.forcedIncludeFiles, []);
    assert.strictEqual(options.defines, undefined);
  });
});
