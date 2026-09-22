import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { mock } from 'node:test';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { useWorkspaceFixtures } from '../support/workspace';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { createAxelParser } from '../../analyzer/axelParser';
import { macroReparse } from '../../analyzer/macroReparse';

suite('Startup structure', () => {
  const {createTempDir, createWorkspaceIndex} = useWorkspaceFixtures();
  test('visits a completed shared dependency once per transaction and rechecks it next time', () => {
    const root = createTempDir();
    fs.writeFileSync(path.join(root, 'leaf.h'), 'int answer;');
    fs.writeFileSync(path.join(root, 'shared.h'), '#include "leaf.h"');
    const includes: string[] = [];
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(root, 'branch' + i + '.h'), '#include "shared.h"');
      includes.push('#include "branch' + i + '.h"');
    }
    const index = createWorkspaceIndex();
    const input = {uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1, text: includes.join('\n')};
    const stat = fs.statSync;
    let reads = 0;
    const spy = mock.method(fs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
      if (String(args[0]) === path.join(root, 'leaf.h')) { reads++; }
      return stat(...args);
    });
    try {
      index.indexOpenDocument(input);
      assert.strictEqual(index.findVisibleDeclarations(input.uri, 'answer').length, 1);
      assert.ok(reads <= 2, 'Shared leaf stat calls: ' + reads);
      reads = 0;
      index.indexOpenDocument({...input, version: 2});
      assert.ok(reads > 0 && reads <= 2, 'Next transaction must recheck once, got ' + reads);
      fs.writeFileSync(path.join(root, 'leaf.h'), 'string changed;');
      index.invalidateFile(path.join(root, 'leaf.h'));
      index.indexOpenDocument({...input, version: 3});
      assert.strictEqual(index.findVisibleDeclarations(input.uri, 'changed').length, 1);
      assert.deepStrictEqual(index.findVisibleDeclarations(input.uri, 'answer'), []);
    } finally { spy.mock.restore(); }
  });
  test('rechecks a completed shared header when its inherited macro context changes', () => {
    const root = createTempDir();
    fs.writeFileSync(path.join(root, 'shared.h'), 'TYPE value;');
    fs.writeFileSync(path.join(root, 'first.h'), '#define TYPE int\n#include "shared.h"');
    fs.writeFileSync(path.join(root, 'second.h'), '#undef TYPE\n#define TYPE string\n#include "shared.h"');
    const index = createWorkspaceIndex({inheritIncludeContext: true});
    const input = {uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
      text: '#include "first.h"\n#include "second.h"'};
    index.indexOpenDocument(input);
    const header = index.getAnalyzedDocument(pathToFileURL(path.join(root, 'shared.h')).toString());
    assert.strictEqual(header?.declarations.find(d => d.name === 'value')?.typeName, 'string');
  });
  test('discards a completed subtree on cancellation and observes its replacement', async () => {
    const root = createTempDir();
    const shared = path.join(root, 'shared.h');
    const paused = path.join(root, 'paused.h');
    fs.writeFileSync(shared, 'int previous;');
    fs.writeFileSync(paused, 'int tail;');
    const index = createWorkspaceIndex();
    const input = {uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
      text: '#include "shared.h"\n#include "paused.h"'};
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const read = fs.promises.readFile.bind(fs.promises);
    const spy = mock.method(fs.promises, 'readFile', async (...args: Parameters<typeof fs.promises.readFile>) => {
      if (String(args[0]) === paused) { entered(); await waiting; }
      return read(...args);
    });
    const source = new CancellationTokenSource();
    try {
      const result = index.analyzeRequestDocument(input, source.token);
      const rejected = assert.rejects(result, {code: LSPErrorCodes.RequestCancelled});
      await ready;
      assert.ok(index.getAnalyzedDocument(pathToFileURL(shared).toString()));
      source.cancel();
      await rejected;
      index.cancelBackgroundIndexing();
      fs.writeFileSync(shared, 'string current;');
      index.invalidateFile(shared);
      spy.mock.restore(); release();
      await index.analyzeRequestDocument({...input, version: 2}, CancellationToken.None);
      assert.strictEqual(index.findVisibleDeclarations(input.uri, 'current').length, 1);
      assert.deepStrictEqual(index.findVisibleDeclarations(input.uri, 'previous'), []);
    } finally { spy.mock.restore(); release(); source.dispose(); }
  }).timeout(10000);
  test('does not clone the expanded type tree until a source-coordinate tree is requested', () => {
    const source = '#define TYPE int\nTYPE value;\n';
    const input = {uri: 'file:///projection.axl', version: 1, text: source};
    const original = new DocumentAnalyzer().analyzeDocument(input, false);
    const root = createAxelParser().parse(source).rootNode;
    let reads = 0;
    const result = macroReparse(root, source, original, original.macroDefinitions, text => {
      const expanded = new DocumentAnalyzer().analyzeDocument({...input, text}, false);
      const snapshot = expanded.typeSnapshot!;
      const syntax = snapshot.root;
      Object.defineProperty(snapshot, 'root', {get() { reads++; return syntax; }, enumerable: true});
      return expanded;
    });
    assert.strictEqual(result.declarations.find(d => d.name === 'value')?.selectionRange.start.line, 1);
    assert.strictEqual(reads, 0, 'Presentation metadata should not traverse the semantic type tree');
    assert.ok(result.typeSnapshot?.root);
    assert.strictEqual(reads, 1);
    assert.strictEqual(result.typeSnapshot!.root, result.typeSnapshot!.root);
    assert.strictEqual(reads, 1, 'The projected tree should be materialized once');
  });
});
