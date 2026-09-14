import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
suite('dependency diagnostic scheduling', () => {
  for (const background of [false, true]) {
    test(`collects header symbols without eager body diagnostics (background=${background})`, async () => {
      const root = createTempDir();
      const header = path.join(root, 'library.h');
      const headerUri = pathToFileURL(header).toString();
      fs.writeFileSync(header, 'class C { public: int value; }; void broken(){ missing; }');
      const index = createWorkspaceIndex();
      const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
        text: '#include "library.h"\nvoid main(){ C c; c.value = 1; }' };
      if (background) {
        index.analyzeForegroundDocument(input);
        await index.waitForBackgroundIndexing();
      } else { index.indexOpenDocument(input); }
      const dependency = index.getAnalyzedDocument(headerUri)!;
      assert.ok(dependency.declarations.some(d => d.name === 'C'));
      assert.ok(dependency.typeSnapshot);
      assert.deepStrictEqual(dependency.diagnostics, [], 'unrequested header bodies must not be diagnosed');
      assert.deepStrictEqual(index.analyzeDiagnosticDocument(input).diagnostics, []);
      const explicit = index.indexDiskDocument(header);
      assert.ok(explicit.diagnostics.some(d => d.message === "Unknown identifier 'missing'."));
      assert.strictEqual(index.indexDiskDocument(header), explicit);
      const open = index.analyzeDiagnosticDocument({ uri: headerUri, version: 1,
        text: 'class C { public: int value; }; void broken(){ missingNow; }' });
      assert.ok(open.diagnostics.some(d => d.message === "Unknown identifier 'missingNow'."));
      assert.ok(!open.diagnostics.some(d => d.message === "Unknown identifier 'missing'."));
    });
  }
});
