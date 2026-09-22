import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { runAnalysisSteps } from '../../../util/analysisSteps';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Document link literal extraction', () => {
  const fixtures = useWorkspaceFixtures();
  test('keeps inactive literal scripts and excludes macro includes and dynamic commands', () => {
    const root = fixtures.createTempDir();
    const target = path.join(root, 'run.axl');
    fs.writeFileSync(target, '');
    const index = fixtures.createWorkspaceIndex();
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).href, version: 1,
      text: '#include HEADER\nvoid main() {\n#if 0\n@run;\n#endif\n@\x60name\x60 run;\n}' };
    const items = runAnalysisSteps(index.getDocumentLinksSteps(input));
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].range.start.line, 3);
    assert.strictEqual(index.resolveDocumentLink(input.uri, items[0]), pathToFileURL(target).href);
  });
});
