import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Macro include lookup scaling', () => {
  const fixtures=useWorkspaceFixtures();
  test('releases syntax views for background includes as well as the open document', async () => {
    const root = fixtures.createTempDir();
    const header = path.join(root, 'background.h');
    fs.writeFileSync(header, 'int shared;');
    const released: string[] = [];
    class ReleasingAnalyzer extends DocumentAnalyzer {
      public override releaseSyntax(uri: string) {
        released.push(uri);
        super.releaseSyntax(uri);
      }
    }
    const index = new WorkspaceIndex({analyzer: new ReleasingAnalyzer()});
    const input = {uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1, text: '#include "background.h"'};
    index.analyzeForegroundDocument(input);
    await index.waitForBackgroundIndexing();
    index.indexOpenDocument(input);
    assert.ok(released.includes(pathToFileURL(header).toString()));
    assert.ok(released.includes(input.uri));
  });

  test('keeps unsaved root declarations visible through a cyclic include', () => {
    const root = fixtures.createTempDir();
    const main = path.join(root, 'main.axl');
    const header = path.join(root, 'b.h');
    fs.writeFileSync(main, '#include "b.h"\n');
    fs.writeFileSync(header, '#include "main.axl"\nvoid f(){ shared; }');
    const index = fixtures.createWorkspaceIndex();
    const uri = pathToFileURL(main).toString();
    index.analyzeDocument({ uri, version: 1, text: '#include "b.h"\nint shared;' });
    const included = index.listVisibleDocuments(uri).find(document => document.uri === pathToFileURL(header).toString());
    assert.ok(included);
    assert.ok(!included.diagnostics.some(diagnostic => diagnostic.message.includes("Unknown identifier 'shared'")));
  });

  test('resolves repeated include paths once per macro lookup without losing occurrence order', () => {
    const root=fixtures.createTempDir();
    const header=path.join(root,'value.h');
    fs.writeFileSync(header,'#define VALUE 1\n');
    const index=fixtures.createWorkspaceIndex();
    const uri=pathToFileURL(path.join(root,'main.axl')).toString();
    index.analyzeDocument({uri,version:1,text:'#include "value.h"\n'.repeat(20)});
    const descriptor=Object.getOwnPropertyDescriptor(fs,'existsSync')!;
    const exists=fs.existsSync;
    let checks=0;
    Object.defineProperty(fs,'existsSync',{...descriptor,value:(file:fs.PathLike)=>{
      if(String(file)===header) { checks++; }
      return exists(file);
    }});
    try {
      const macros=index.findVisibleMacroDefinitions(uri,'VALUE');
      assert.strictEqual(macros.length,20);
      assert.strictEqual(macros[0].visibilityStart?.line,0);
      assert.strictEqual(macros[19].visibilityStart?.line,19);
      assert.strictEqual(checks,1);
      index.findVisibleMacroDefinitions(uri,'VALUE');
      assert.strictEqual(checks,2,'A later lookup must check the current filesystem again');
    } finally { Object.defineProperty(fs,'existsSync',descriptor); }
  });
});
