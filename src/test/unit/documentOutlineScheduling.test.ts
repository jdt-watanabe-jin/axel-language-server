import * as assert from 'assert';
import { registerHandlers } from '../support/configuredHandlers';
import { createHandlerConnection, createTestDocument, emptyAnalysis } from '../support/handlerFixtures';
import type { DocumentSymbol } from 'vscode-languageserver/node';
suite('Local outline scheduling', () => {
  test('returns edited outline without waiting for pending foreground analysis', async () => {
    const document=createTestDocument('int edited;');
    let onChange!: (event:{document:typeof document}) => void;
    let outline!: (params:{textDocument:{uri:string}}) => Promise<DocumentSymbol[]>;
    let release!: (value:ReturnType<typeof emptyAnalysis>) => void;
    const foreground=new Promise<ReturnType<typeof emptyAnalysis>>(resolve=>{release=resolve;});
    let completed=false;
    const connection=createHandlerConnection({onDocumentSymbol:(handler:typeof outline)=>{outline=handler;},sendNotification:async()=>{}});
    registerHandlers({connection:connection as never,documents:{get:()=>document,onDidOpen:()=>{},onDidClose:()=>{},onDidChangeContent:(handler:typeof onChange)=>{onChange=handler;}} as never,
      analyzer:{analyzeDocument:()=>emptyAnalysis(),analyzeForegroundDocumentAsync:async()=>{const result=await foreground;completed=true;return result;},
        *getDocumentSymbolsSteps(input) { assert.strictEqual(input.text,'int edited;');yield;return [{name:'edited',kind:'variable' as const,range:{start:{line:0,character:0},end:{line:0,character:11}},selectionRange:{start:{line:0,character:4},end:{line:0,character:10}}}]; }},logger:{error:()=>{}}});
    onChange({document});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const result=await Promise.race([outline({textDocument:{uri:document.uri}}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Outline waited for pending analysis')),1000);})]);
      assert.deepStrictEqual(result.map(s=>s.name),['edited']);assert.strictEqual(completed,false);
    } finally {clearTimeout(timer);release(emptyAnalysis());await new Promise(resolve=>setTimeout(resolve,30));}
  });
});
