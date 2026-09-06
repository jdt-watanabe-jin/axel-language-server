import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
suite('include invalidation regression', () => {
  test('rebuilds visible declarations after a header changes while the source version stays unchanged', () => {
    const directory = createTempDir();
    const header = path.join(directory, 'types.h');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const input = { uri, version: 1, text: '#include "types.h"\nvoid main() {}' };
    fs.writeFileSync(header, 'int oldValue;');
    const index = createWorkspaceIndex();
    index.indexOpenDocument(input);
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'oldValue').map(item => item.detail), ['int oldValue']);
    fs.writeFileSync(header, 'string newValue;');
    index.invalidateFile(header);
    index.indexOpenDocument(input);
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'oldValue'), []);
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'newValue').map(item => item.detail), ['string newValue']);
  });
});
