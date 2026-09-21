import * as assert from 'assert';
import { mock } from 'node:test';
import { registerHandlers } from '../support/configuredHandlers';
import { createHandlerConnection, createTestDocument } from '../support/handlerFixtures';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { TypeHierarchyIndex } from '../../analyzer/typeHierarchy/index';
import type { Location, TextDocumentPositionParams } from 'vscode-languageserver/node';
suite('Local navigation reuse',()=>{
  test('uses the foreground analysis for declaration and type definition',async()=>{
    const document=createTestDocument('class C {}; C value;');
    const analysis=new DocumentAnalyzer().analyzeDocument({uri:document.uri,version:document.version,text:document.getText()});
    let declaration!:(params:TextDocumentPositionParams)=>Promise<Location[]>;
    let typeDefinition!:typeof declaration;
    let sharedReads=0;
    const spy=mock.method(TypeHierarchyIndex.prototype,'navigate',async()=>{throw new Error('Reparsed a private hierarchy workspace');});
    const connection=createHandlerConnection({onDeclaration:(handler:typeof declaration)=>{declaration=handler;},onTypeDefinition:(handler:typeof declaration)=>{typeDefinition=handler;},sendNotification:async()=>{}});
    try {
      registerHandlers({connection:connection as never,documents:{get:()=>document,onDidOpen:()=>{},onDidClose:()=>{},onDidChangeContent:()=>{}} as never,
        analyzer:{analyzeDocument:()=>analysis,analyzeRequestDocument:async()=>{sharedReads++;return analysis;}},logger:{error:()=>{}}});
      const params={textDocument:{uri:document.uri},position:{line:0,character:15}};
      assert.strictEqual((await declaration(params))[0]?.range.start.character,14);
      assert.strictEqual((await typeDefinition(params))[0]?.range.start.character,6);
      assert.strictEqual(sharedReads,2);assert.strictEqual(spy.mock.callCount(),0);
    }finally{spy.mock.restore();}
  });
});
