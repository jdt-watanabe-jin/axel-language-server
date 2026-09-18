import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getHover } from '../../../analyzer/hover';
import { getDefinitions, getReferences } from '../../../analyzer/navigation';
import { positionFromOffset } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Method chain navigation', () => {
  const fixtures = useWorkspaceFixtures();
  for (const registered of [false, true]) {
    for (const expression of ['fdlg.GetDir().Trim()', 'fdlg.GetDir().Trim().Trim()', '(fdlg.GetDir()).Trim()']) {
      test(`resolves ${expression} with ${registered ? 'builtin' : 'ordinary'} declarations`, () => {
        const root = fixtures.createTempDir();
        const headerPath = path.join(root, 'api.h');
        fs.writeFileSync(headerPath, 'class string { public: string Trim(); int data; };\nclass GCFileDialog { public: string GetDir(); int data; };');
        if (registered) {
          fs.writeFileSync(path.join(root, 'api.analysis.json'), JSON.stringify({
            schemaVersion: 1, profile: 'axel-510', declarationFiles: ['api.h'],
            types: { string: 'api.h' }, analysisOnlyMacros: []
          }));
        }
        const workspaceIndex = fixtures.createWorkspaceIndex({forcedIncludeFiles: [headerPath]});
        const text = `main() { GCFileDialog fdlg; string dir = ${expression}; }`;
        const analysis = workspaceIndex.analyzeDocument({uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1, text});
        const position = positionFromOffset(text, text.lastIndexOf('Trim'));
        const input = {analysis, position, workspaceIndex};
        assert.ok(!analysis.diagnostics.some(d => d.severity === 'error'), JSON.stringify(analysis.diagnostics));
        assert.match(getHover(input)?.plainText ?? '', /string string::Trim\(\)/);
        assert.deepStrictEqual(getDefinitions(input), [{uri: pathToFileURL(headerPath).toString(),
          range: {start: {line: 0, character: 30}, end: {line: 0, character: 34}}}]);
        assert.ok(getReferences({...input, includeDeclaration: false}).some(ref =>
          ref.uri === analysis.uri && ref.range.start.character === position.character));
      });
    }
  }
});
