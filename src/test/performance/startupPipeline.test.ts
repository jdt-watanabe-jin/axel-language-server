import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver/node';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Startup pipeline', () => {
  const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
  test('retains startup, macro and transitive declarations without repeating completed analysis', async () => {
    const root = createTempDir();
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin/_login.axl'), '#include "startup.h"\nint startupValue;');
    fs.writeFileSync(path.join(root, 'bin/startup.h'), 'class Startup { public: int value; };');
    const forced = path.join(root, 'forced.h');
    fs.writeFileSync(forced, '#define TYPE int\nclass GCDialog {};');
    const header = path.join(root, 'header.h');
    fs.writeFileSync(header, '#include "nested.h"\nclass Dialog : public GCDialog {};');
    fs.writeFileSync(path.join(root, 'nested.h'), 'int nestedValue;');
    const events: string[] = [];
    const index = createWorkspaceIndex({ sxmHome: root, includeRoots: [root], forcedIncludeFiles: [forced],
      logger: { info: () => undefined, error: error => assert.fail(error), timing: event => events.push(event) } });
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
      text: '#include "header.h"\nvoid main(){ TYPE local = nestedValue; startupValue = local; }' };
    const result = await index.analyzeRequestDocument(input, CancellationToken.None);
    assert.deepStrictEqual(result.diagnostics, []);
    assert.ok(result.declarations.some(d => d.name === 'main'));
    assert.ok(index.listVisibleDocuments(input.uri).some(d => d.uri === pathToFileURL(header).toString()));
    assert.strictEqual(index.findVisibleDeclarations(input.uri, 'startupValue').length, 1);
    assert.strictEqual(index.findVisibleDeclarations(input.uri, 'nestedValue').length, 1);
    const calls = events.filter(e => e.includes('operation=document.analyze')).length;
    assert.strictEqual(await index.analyzeRequestDocument(input, CancellationToken.None), result);
    assert.strictEqual(events.filter(e => e.includes('operation=document.analyze')).length, calls);
    console.log(`    analysisCallsIncludingNested=${calls} visibleDocuments=${index.listVisibleDocuments(input.uri).length}`);
  });
});
