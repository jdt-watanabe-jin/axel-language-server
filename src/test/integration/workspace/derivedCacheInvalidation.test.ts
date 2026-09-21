import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Derived cache invalidation', () => {
  const { createWorkspaceIndex, createTempDir } = useWorkspaceFixtures();
  test('keeps derived results for an unrelated open document', () => {
    const index = createWorkspaceIndex();
    const a = { uri: 'file:///a.axl', version: 1, text: 'int a;' };
    const b = { uri: 'file:///b.axl', version: 1, text: 'int b;' };
    const first = index.indexOpenDocument(a);
    index.indexOpenDocument(b);
    const tokens = index.getSemanticTokens(first);
    const context = index.callHierarchyTypeInput(first);
    const edited = { ...b, version: 2, text: 'string b;' };
    index.updateOpenDocument(edited);
    index.indexOpenDocument(edited);
    assert.strictEqual(index.getSemanticTokens(first), tokens);
    assert.strictEqual(index.callHierarchyTypeInput(first), context);
  });
  test('invalidates transitive consumers but retains an independent source', () => {
    const root = createTempDir();
    const header = path.join(root, 'header.h');
    fs.writeFileSync(header, 'int before;');
    fs.writeFileSync(path.join(root, 'middle.h'), '#include "header.h"');
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1, text: '#include "middle.h"\nvoid main(){}' };
    const index = createWorkspaceIndex();
    index.indexOpenDocument(input);
    const independent = index.indexOpenDocument({ uri: 'file:///independent.axl', version: 1, text: 'int independent;' });
    const tokens = index.getSemanticTokens(independent);
    index.listVisibleDeclarations(input.uri);
    fs.writeFileSync(header, 'string after;');
    index.invalidateFile(header);
    const changed = index.indexOpenDocument(input);
    assert.strictEqual(index.findVisibleDeclarations(input.uri, 'after').length, 1);
    assert.deepStrictEqual(index.findVisibleDeclarations(input.uri, 'before'), []);
    assert.deepStrictEqual(changed.diagnostics, createWorkspaceIndex().indexOpenDocument(input).diagnostics);
    assert.strictEqual(index.getSemanticTokens(independent), tokens);
  });
  for (const event of ['create', 'rename', 'delete-recreate'] as const) {
    test(`refreshes missing include candidates after ${event}`, () => {
      const root = createTempDir(), header = path.join(root, 'missing.h');
      const uri = pathToFileURL(path.join(root, 'main.axl')).toString();
      const input = { uri, version: 1, text: '#include "missing.h"\nvoid main(){}' };
      const index = createWorkspaceIndex();
      index.indexOpenDocument(input);
      index.listVisibleDeclarations(uri);
      if (event === 'rename') {
        const old = path.join(root, 'old.h');
        fs.writeFileSync(old, 'int appeared;');
        fs.renameSync(old, header);
        index.invalidatePaths([pathToFileURL(old).toString(), pathToFileURL(header).toString()]);
      } else {
        fs.writeFileSync(header, 'int appeared;');
        index.invalidateFile(header);
      }
      index.indexOpenDocument(input);
      assert.strictEqual(index.findVisibleDeclarations(uri, 'appeared').length, 1);
      if (event === 'delete-recreate') {
        fs.unlinkSync(header); index.invalidateFile(header); index.indexOpenDocument(input);
        assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'appeared'), []);
        fs.writeFileSync(header, 'string replaced;'); index.invalidateFile(header); index.indexOpenDocument(input);
        assert.strictEqual(index.findVisibleDeclarations(uri, 'replaced').length, 1);
        assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'appeared'), []);
      }
    });
  }
  test('invalidates transitive forced headers globally', () => {
    const root = createTempDir(), forced = path.join(root, 'forced.h'), dependency = path.join(root, 'types.h');
    fs.writeFileSync(forced, '#include "types.h"'); fs.writeFileSync(dependency, 'int before;');
    const index = createWorkspaceIndex({ forcedIncludeFiles: [forced] });
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1, text: 'void main(){}' };
    const before = index.indexOpenDocument(input);
    const context = index.callHierarchyTypeInput(before);
    index.listVisibleDeclarations(input.uri);
    fs.writeFileSync(dependency, 'string after;'); index.invalidateFile(dependency);
    const after = index.indexOpenDocument(input);
    assert.notStrictEqual(index.callHierarchyTypeInput(after), context);
    assert.strictEqual(index.findVisibleDeclarations(input.uri, 'after').length, 1);
    assert.deepStrictEqual(index.findVisibleDeclarations(input.uri, 'before'), []);
  });
  test('does not keep a definite declaration after its last definite path disappears', () => {
    const root = createTempDir(); fs.writeFileSync(path.join(root, 'header.h'), 'int external;');
    const index = createWorkspaceIndex();
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1, text: '#include "header.h"\nvoid main(){}' };
    index.indexOpenDocument(input); assert.strictEqual(index.findVisibleDeclarations(input.uri, 'external').length, 1);
    const changed = { ...input, version: 2, text: '#if UNKNOWN_RUNTIME()\n#include "header.h"\n#endif\nvoid main(){}' };
    index.indexOpenDocument(changed);
    const fresh = createWorkspaceIndex(); fresh.indexOpenDocument(changed);
    assert.deepStrictEqual(index.listVisibleDeclarations(input.uri), fresh.listVisibleDeclarations(input.uri));
    assert.deepStrictEqual(index.findVisibleDeclarations(input.uri, 'external'), []);
  });
  test('does not expose mutable cached declaration arrays to callers', () => {
    const index = createWorkspaceIndex();
    const input = { uri: 'file:///mutable.axl', version: 1, text: 'int value;' };
    index.indexOpenDocument(input);
    index.listVisibleDeclarations(input.uri).length = 0;
    assert.strictEqual(index.listVisibleDeclarations(input.uri).filter(d => d.name === 'value').length, 1);
  });
});
