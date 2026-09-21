import * as assert from 'assert';
import { CancellationToken, LSPErrorCodes, type TypeHierarchySubtypesParams } from 'vscode-languageserver/node';
import { registerTypeHierarchyHandlers } from '../../lsp/typeHierarchy';
import { WorkProgress } from '../../lsp/workProgress';
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
suite('R4 type hierarchy progress',()=>{
  test('all hierarchy methods use delayed managed progress and supplied token cancellation',async()=>{
    const handlers=new Map<string,(params:unknown,token:CancellationToken)=>Promise<unknown>>();
    const events:{token:string|number;kind:string}[]=[];
    let fallbackRegistrations=0,created=0;
    const progress=new WorkProgress({supported:()=>true,create:async()=>{created++;},send:(token,value)=>{events.push({token,kind:value.kind});},error:assert.fail},5);
    const index={prepare:async()=>[],supertypes:async()=>[],subtypes:async(_data:unknown,token:CancellationToken,report:(completed:number,total:number)=>void)=>{
      await delay(20);report(1,2);assert.ok(token.isCancellationRequested);return [];
    }};
    registerTypeHierarchyHandlers({progress,connection:{onRequest:(method:string,handler:(params:unknown,token:CancellationToken)=>Promise<unknown>)=>handlers.set(method,handler),languages:{typeHierarchy:{
      onPrepare:()=>{fallbackRegistrations++;},onSupertypes:()=>{fallbackRegistrations++;},onSubtypes:()=>{fallbackRegistrations++;}
    }}},logger:{error:assert.fail}} as never,index as never,{request:work=>(params,token=CancellationToken.None)=>work(params,token)});
    assert.strictEqual(fallbackRegistrations,0);
    assert.deepStrictEqual([...handlers.keys()],['textDocument/prepareTypeHierarchy','typeHierarchy/supertypes','typeHierarchy/subtypes']);
    const range={start:{line:0,character:0},end:{line:0,character:1}};
    const params:TypeHierarchySubtypesParams={item:{name:'A',kind:5,uri:'file:///A.axl',range,selectionRange:range},workDoneToken:'hierarchy'};
    const pending=handlers.get('typeHierarchy/subtypes')!(params,CancellationToken.None);
    await delay(10);progress.cancel('hierarchy');
    await assert.rejects(pending,{code:LSPErrorCodes.RequestCancelled});
    assert.strictEqual(created,0);assert.deepStrictEqual(events.map(e=>e.kind),['begin','report','end']);
    assert.ok(events.every(e=>e.token==='hierarchy'));progress.dispose();
  });
});
