import { fixturePath } from '../fixture';
import * as assert from 'assert';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { getHover } from '../../../analyzer/hover';
import { positionFromOffset } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';

interface HoverCase { label: string; source: string; token: string; expected: string }
const cases: HoverCase[] = JSON.parse(fs.readFileSync(fixturePath('hover-regression.expected.json'), 'utf8'));
const { createWorkspaceIndex } = useWorkspaceFixtures();
suite('GUI hover portable regression', () => {
  test('resolves all portable GUI hover scenarios from one analysis', () => {
    const sourcePath = fixturePath('hover-regression.axl');
    const text = fs.readFileSync(sourcePath, 'utf8');
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({ uri: pathToFileURL(sourcePath).toString(), version: 1, text });
    for (const entry of cases) {
      const offset = text.indexOf(entry.source);
      assert.notStrictEqual(offset, -1, entry.label);
      const tokenOffset = entry.source.indexOf(entry.token);
      assert.notStrictEqual(tokenOffset, -1, entry.label);
      const hover = getHover({ analysis, workspaceIndex: index, position: positionFromOffset(text, offset + tokenOffset) });
      assert.strictEqual(hover?.plainText.split('\n')[0], entry.expected, entry.label);
    }
  });
});
