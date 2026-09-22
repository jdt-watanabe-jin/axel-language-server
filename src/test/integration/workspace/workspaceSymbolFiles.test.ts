import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver/node';
import { collectWorkspaceSymbolFiles } from '../../../analyzer/workspaceSymbols/files';
import { useWorkspaceFixtures } from '../../support/workspace';
const { createTempDir } = useWorkspaceFixtures();
suite('Workspace Symbol files', () => {
  test('includes unopened AXEL files across overlapping roots and excludes only configured paths and git', async () => {
    const root = createTempDir();
    for (const name of ['main.AXL', 'nested/a.hh', 'node_modules/a.h', '.git/a.axl', 'generated/a.axl', 'nested/generated/b.h', 'readme.txt']) {
      const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'int value;');
    }
    const result = await collectWorkspaceSymbolFiles([pathToFileURL(root).toString(), pathToFileURL(path.join(root, 'nested')).toString()],
      ['**/generated/**'], CancellationToken.None, error => assert.fail(error));
    assert.deepStrictEqual([...result.values()].map(file => path.relative(fs.realpathSync.native(root), file).replace(/\\/g, '/')).sort(),
      ['main.AXL', 'nested/a.hh', 'node_modules/a.h']);
  });

});
