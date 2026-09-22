import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { visibleDeclarationsByName, declarationsInTypeHierarchy, thisReceiverType } from '../../analyzer/resolution';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Workspace lookup scaling', () => {
  const { createWorkspaceIndex, createTempDir } = useWorkspaceFixtures();
  test('locates enclosing types without scanning unrelated variable ranges', () => {
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({uri: 'file:///owners.axl', version: 1,
      text: 'class Box { public: int member; };\n' + Array.from({length: 500}, (_, i) => 'int value' + i + ';').join('\n')});
    let reads = 0;
    for (const declaration of analysis.declarations) {
      const range = declaration.range;
      Object.defineProperty(declaration, 'range', {get() { reads++; return range; }});
    }
    const input = {analysis, position: {line: 0, character: 23}, workspaceIndex: index};
    assert.strictEqual(thisReceiverType(input), 'Box');
    reads = 0;
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(thisReceiverType(input), 'Box');
      assert.strictEqual(thisReceiverType({...input, position: {line: 100, character: 4}}), undefined);
    }
    assert.ok(reads < 100, 'Enclosing type lookup reread ' + reads + ' declaration ranges');
  });
  test('reuses name and member indexes through the real workspace adapter', () => {
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({ uri: 'file:///lookup.axl', version: 1,
      text: 'class Box { public: int member; };\n' + Array.from({length: 500}, (_, i) => 'int value' + i + ';').join('\n') });
    let reads = 0;
    for (const declaration of analysis.declarations) {
      const name = declaration.name;
      Object.defineProperty(declaration, 'name', { get() { reads++; return name; } });
    }
    const input = {analysis, position: {line: 0, character: 0}, workspaceIndex: index};
    visibleDeclarationsByName(input, 'value1');
    declarationsInTypeHierarchy(input, 'Box');
    reads = 0;
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(visibleDeclarationsByName(input, 'value1')[0]?.name, 'value1');
      assert.strictEqual(declarationsInTypeHierarchy(input, 'Box')[0]?.name, 'member');
    }
    assert.ok(reads < 100, 'Repeated lookups reread ' + reads + ' declaration names');
    index.listVisibleDeclarations(analysis.uri).length = 0;
    assert.strictEqual(visibleDeclarationsByName(input, 'value1').length, 1);
  });
  test('refreshes resolver snapshots after dependency edits at the same source version', () => {
    const root = createTempDir(), header = path.join(root, 'shared.h');
    fs.writeFileSync(header, 'class Box { public: int before; };');
    const index = createWorkspaceIndex();
    const source = {uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1, text: '#include "shared.h"'};
    const analysis = index.indexOpenDocument(source);
    const input = {analysis, position: {line: 0, character: 0}, workspaceIndex: index};
    assert.strictEqual(declarationsInTypeHierarchy(input, 'Box')[0]?.name, 'before');
    assert.strictEqual(visibleDeclarationsByName(input, 'before').length, 1);
    fs.writeFileSync(header, 'class Box { public: int after; };');
    index.invalidateFile(header); index.indexOpenDocument(source);
    assert.deepStrictEqual(visibleDeclarationsByName(input, 'before'), []);
    assert.strictEqual(visibleDeclarationsByName(input, 'after').length, 1);
    assert.strictEqual(declarationsInTypeHierarchy(input, 'Box')[0]?.name, 'after');
  });
  test('indexes external names once without exposing local declarations or mutable cached arrays', () => {
    const root = createTempDir();
    const header = path.join(root, 'shared.h');
    fs.writeFileSync(header, Array.from({length: 500}, (_, i) => 'int external' + i + ';').join('\n'));
    const index = createWorkspaceIndex();
    const input = {uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
      text: '#include "shared.h"\nint local;'};
    index.indexOpenDocument(input);
    const analysis = index.getAnalyzedDocument(pathToFileURL(header).toString())!;
    let reads = 0;
    for (const declaration of analysis.declarations) {
      const name = declaration.name;
      Object.defineProperty(declaration, 'name', { get() { reads++; return name; } });
    }
    index.findVisibleDeclarations(input.uri, 'external0');
    reads = 0;
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(index.findVisibleDeclarations(input.uri, 'external' + i).length, 1);
    }
    assert.ok(reads < 100, 'External lookups reread ' + reads + ' unrelated names');
    assert.deepStrictEqual(index.findVisibleDeclarations(input.uri, 'local'), []);
    index.findVisibleDeclarations(input.uri, 'external0').length = 0;
    assert.strictEqual(index.findVisibleDeclarations(input.uri, 'external0').length, 1);
  });
});
