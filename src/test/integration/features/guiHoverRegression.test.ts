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
  for (const entry of cases) {
    test(entry.label, () => {
      const sourcePath = fixturePath('hover-regression.axl');
      const text = fs.readFileSync(sourcePath, 'utf8');
      const offset = text.indexOf(entry.source);
      assert.notStrictEqual(offset, -1, entry.source);
      const tokenOffset = entry.source.indexOf(entry.token);
      assert.notStrictEqual(tokenOffset, -1, entry.token);
      const index = createWorkspaceIndex();
      const analysis = index.indexOpenDocument({ uri: pathToFileURL(sourcePath).toString(), version: 1, text });
      const hover = getHover({ analysis, workspaceIndex: index, position: positionFromOffset(text, offset + tokenOffset) });
      assert.strictEqual(hover?.plainText.split('\n')[0], entry.expected);
    });
  }
});
