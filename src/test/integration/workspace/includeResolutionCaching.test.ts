import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as includeResolver from '../../../analyzer/includeResolver';
import { mock } from 'node:test';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
suite('include resolution transaction cache', () => {
  test('resolves each include once across dependency analysis and diagnostics', () => {
    const root = createTempDir();
    const header = path.join(root, 'library.h');
    fs.writeFileSync(header, '#define ENABLED 1\nint answer;');
    const index = createWorkspaceIndex();
    const resolve = includeResolver.resolveInclude;
    let probes = 0;
    const spy = mock.method(includeResolver, 'resolveInclude', (input: includeResolver.ResolveIncludeInput) => {
      if (input.includeText === '"library.h"') { probes++; }
      return resolve(input);
    });
    try {
      const analysis = index.indexOpenDocument({ uri: pathToFileURL(path.join(root, 'main.axl')).toString(),
        version: 1, text: '#include "library.h"\nint main(){ return answer; }' });
      assert.deepStrictEqual(analysis.diagnostics, []);
      assert.strictEqual(probes, 1, 'repeated analysis passes must share include resolution');
    } finally { spy.mock.restore(); }
  });

  test('rechecks missing files on the next analysis without a watcher notification', () => {
    const root = createTempDir();
    const index = createWorkspaceIndex();
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(),
      version: 1, text: '#include "created.h"\nint main(){ return answer; }' };
    assert.ok(index.indexOpenDocument(input).diagnostics.some(d => d.message.includes('Include file not found')));
    fs.writeFileSync(path.join(root, 'created.h'), 'int answer;');
    assert.deepStrictEqual(index.indexOpenDocument({ ...input, version: 2 }).diagnostics, []);
  });
});
