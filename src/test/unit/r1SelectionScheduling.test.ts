import * as assert from 'assert';
import { registerHandlers } from '../support/configuredHandlers';
import { createHandlerConnection, createTestDocument, emptyAnalysis } from '../support/handlerFixtures';
import type { SelectionRange, SelectionRangeParams } from 'vscode-languageserver/node';
suite('R1 selection scheduling', () => {
  test('selects current source without waiting for foreground semantic analysis', async () => {
    const document=createTestDocument('int edited;');
    let onChange!: (event:{document:typeof document}) => void;
    let select!: (params:SelectionRangeParams) => Promise<SelectionRange[]>;
    let release!: (value:ReturnType<typeof emptyAnalysis>) => void;
    const foreground=new Promise<ReturnType<typeof emptyAnalysis>>(resolve=>{release=resolve;});
    let completed=false;
    const range={start:{line:0,character:4},end:{line:0,character:10}};
    const connection=createHandlerConnection({onSelectionRanges:(handler:typeof select)=>{select=handler;},sendNotification:async()=>{}});
    registerHandlers({connection:connection as never,documents:{get:()=>document,onDidOpen:()=>{},onDidClose:()=>{},onDidChangeContent:(handler:typeof onChange)=>{onChange=handler;}} as never,
      analyzer:{analyzeDocument:()=>emptyAnalysis(),analyzeForegroundDocumentAsync:async()=>{const result=await foreground;completed=true;return result;},
        *getSelectionRangesSteps(input) { assert.strictEqual(input.text,'int edited;');yield;return [{range}]; }},logger:{error:()=>{}}});
    onChange({document});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const result=await Promise.race([select({textDocument:{uri:document.uri},positions:[{line:0,character:6}]}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Selection waited for semantic analysis')),1000);})]);
      assert.deepStrictEqual(result,[{range}]);assert.strictEqual(completed,false);
    } finally {clearTimeout(timer);release(emptyAnalysis());await new Promise(resolve=>setTimeout(resolve,30));}
  });
});
