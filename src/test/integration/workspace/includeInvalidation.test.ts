import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getDefinitions } from '../../../analyzer/navigation';
import { useWorkspaceFixtures } from '../../support/workspace';

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
suite('include invalidation regression', () => {
  for (const variant of ['encoded', 'drive-case']) {
    test('keeps guarded header declarations navigable through a URI alias with ' + variant + ' spelling', function () {
      if (variant === 'drive-case' && process.platform !== 'win32') { this.skip(); }
      const directory = createTempDir();
      const header = path.join(directory, 'api.h');
      const root = path.join(directory, 'builtins.h');
      const text = '#ifndef API_H\n#define API_H\nclass Dialog { public: void SetMode(int mode); };\n#endif';
      fs.writeFileSync(header, text);
      fs.writeFileSync(root, '#include "api.h"');
      const index = createWorkspaceIndex({ forcedIncludeFiles: [root] });
      index.indexOpenDocument({ uri: pathToFileURL(path.join(directory, 'main.axl')).toString(), version: 1,
        text: 'void main() { Dialog dlg; dlg.SetMode(1); }' });
      const canonical = pathToFileURL(header).toString();
      const uri = variant === 'encoded' ? canonical.replace('api.h', '%61pi.h')
        : canonical.replace(/file:\/\/\/([A-Za-z]):/, (_match, drive: string) => 'file:///' + drive.toLowerCase() + '%3A');
      const analysis = index.indexOpenDocument({ uri, version: 1, text });
      const range = { start: { line: 2, character: 40 }, end: { line: 2, character: 44 } };
      assert.deepStrictEqual(getDefinitions({ analysis, position: range.start, workspaceIndex: index }), [{ uri, range }]);
      assert.deepStrictEqual(analysis.inactiveRanges, []);
    });
  }

});
