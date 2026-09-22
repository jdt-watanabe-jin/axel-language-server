import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as assert from 'assert';
import { mock } from 'node:test';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import * as diagnostics from '../../analyzer/typeChecking/diagnostics';
import { getDocumentHighlightsSteps } from '../../analyzer/documentHighlights';
import { runAnalysisSteps } from '../../util/analysisSteps';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Interactive analysis reuse',()=>{
  const {createWorkspaceIndex,createTempDir}=useWorkspaceFixtures();
  test('shares unchanged call input and invalidates after edits',()=>{
    const index=createWorkspaceIndex();const text='void f(int count) {} void main(){ f(1); }';
    const input={uri:'file:///reuse.axl',version:1,text};const analysis=index.indexOpenDocument(input);
    const first=index.callHierarchyTypeInput(analysis);
    assert.strictEqual(index.callHierarchyTypeInput(analysis),first);
    const next=index.indexOpenDocument({...input,version:2,text:text.replace('count','size')});
    assert.notStrictEqual(index.callHierarchyTypeInput(next),first);
  });
  test('reuses completed highlight occurrences across cursor moves but not changed dependencies',()=>{
    const analyzer=new DocumentAnalyzer();const analysis=analyzer.analyzeDocument({uri:'file:///main.axl',version:1,text:'int x; int y; void f(){x++;y++;}'});
    let dependency=analyzer.analyzeDocument({uri:'file:///dep.h',version:1,text:'int external;'});
    const workspaceIndex={listVisibleDocuments:()=>[dependency]};
    const original=diagnostics.createTypeCheckingContext;let calls=0;
    const spy=mock.method(diagnostics,'createTypeCheckingContext',(...args:Parameters<typeof original>)=>{calls++;return original(...args);});
    const at=(character:number)=>runAnalysisSteps(getDocumentHighlightsSteps({analysis,workspaceIndex,position:{line:0,character}}));
    try {
      assert.strictEqual(at(4).length,2);assert.strictEqual(at(11).length,2);assert.strictEqual(calls,1);
      dependency=analyzer.analyzeDocument({uri:dependency.uri,version:2,text:'int different;'});
      assert.strictEqual(at(4).length,2);assert.strictEqual(calls,2);
    } finally {spy.mock.restore();}
  });

  test('invalidates shared inputs and token results for external edits and configuration',()=>{
    const root=createTempDir();const header=path.join(root,'dep.h');fs.writeFileSync(header,'int external;');
    const index=createWorkspaceIndex();const input={uri:pathToFileURL(path.join(root,'main.axl')).toString(),version:1,text:'#include "dep.h"\nvoid main(){external;}'};
    const analysis=index.indexOpenDocument(input);const first=index.callHierarchyTypeInput(analysis);const tokens=index.getSemanticTokens(analysis);
    fs.writeFileSync(header,'string external;');index.invalidatePaths([pathToFileURL(header).toString()]);
    const next=index.indexOpenDocument(input);const second=index.callHierarchyTypeInput(next);
    assert.notStrictEqual(second,first);assert.notStrictEqual(index.getSemanticTokens(next),tokens);
    assert.ok(second.documents?.some(document=>document.declarations.some(declaration=>declaration.detail.includes('string external'))));
    index.configure({targetPlatform:'linux-x64'});
    const configured=index.indexOpenDocument(input);assert.notStrictEqual(index.callHierarchyTypeInput(configured),second);
  });
  test('invalidates startup contexts when login changes',()=>{
    const root=createTempDir();fs.mkdirSync(path.join(root,'bin'));const login=path.join(root,'bin/_login.axl');fs.writeFileSync(login,'int startup;');
    const index=createWorkspaceIndex({sxmHome:root});const input={uri:pathToFileURL(path.join(root,'main.axl')).toString(),version:1,text:'void main(){startup;}'};
    const analysis=index.indexOpenDocument(input);const first=index.callHierarchyTypeInput(analysis);assert.ok(first.loginScope);
    fs.writeFileSync(login,'string startup;');index.invalidatePaths([pathToFileURL(login).toString()]);
    const next=index.indexOpenDocument(input);const second=index.callHierarchyTypeInput(next);
    assert.notStrictEqual(second,first);assert.notStrictEqual(second.loginScope,first.loginScope);
    assert.ok(second.loginScope?.declarations.some(declaration=>declaration.detail.includes('string startup')));
  });

});
