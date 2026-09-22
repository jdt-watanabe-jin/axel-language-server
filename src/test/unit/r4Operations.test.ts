import * as assert from 'assert';
import { CancellationToken, CancellationTokenSource, ErrorCodes, LSPErrorCodes } from 'vscode-languageserver/node';
import type { ExecuteCommandParams, ApplyWorkspaceEditParams } from 'vscode-languageserver/node';
import type { AnalyzedDocument } from '../../types/analysis';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { registerOperationHandlers } from '../../lsp/operations';

function fixture(supported = true, guardRevision = false) {
  const uri = pathToFileURL(path.resolve('r4-main.axl')).toString();
  let document = TextDocument.create(uri, 'axel', 3, 'Missing value;');
  let revision = 0, rebuilds = 0;
  const requests: {method:string;params:ApplyWorkspaceEditParams & {external?:boolean}}[] = [], notifications: unknown[] = [];
  let handler: (params:ExecuteCommandParams,token:CancellationToken)=>Promise<{applied?:boolean;success?:boolean;uri?:string}>;
  let reply: unknown = {applied:false,failureReason:'Declined'};
  let analyzeHook = () => {};
  const controller = registerOperationHandlers({
    connection: { onExecuteCommand: (value:typeof handler) => {handler=value;}, sendRequest: async (type:{method:string}|string,params:ApplyWorkspaceEditParams & {external?:boolean}) => {
      requests.push({method:typeof type === 'string' ? type : type.method,params});
      return typeof reply === 'function' ? reply() : reply;
    }, sendNotification: (...args:unknown[]) => {notifications.push(args);} },
    documents: {get:(value:string)=>value===uri ? document : undefined},
    analyzer:{findDeclarations:()=>[{name:'Missing',kind:'class',uri:pathToFileURL(path.resolve('types.h')).toString()}]},
    clientCapabilities: supported ? {workspace:{applyEdit:true,workspaceEdit:{documentChanges:true}},window:{showDocument:{support:true}}} : {},
    logger:{error:()=>{}}
  } as never, {
    request:work=>async(params,token=CancellationToken.None)=>{const before=revision;const result=await work(params,token);if(guardRevision && before!==revision){throw new Error('post-request ContentModified');}return result;},
    analyzeRequest:async()=>{analyzeHook();return {uri,diagnostics:[{message:"Unknown type 'Missing'.",range:{start:{line:0,character:0},end:{line:0,character:7}}}]} as AnalyzedDocument;},
    revision:()=>revision,rebuildIndex:async()=>{rebuilds++;return {rebuilt:true};}
  });
  return {uri,requests,notifications,controller,execute:(command:string,args?:unknown[],token=CancellationToken.None)=>handler({command,arguments:args},token),
    target:()=>[{uri,position:{line:0,character:0}}], rebuilds:()=>rebuilds,
    reply:(value:unknown)=>{reply=value;},change:()=>{revision++;document=TextDocument.create(uri,'axel',4,'Changed');},
    analyzeHook:(value:()=>void)=>{analyzeHook=value;}};
}
suite('R4 server operations',()=>{
  test('allowlists commands and rebuild arguments before invoking work',async()=>{
    const f=fixture();
    await assert.rejects(f.execute('arbitrary.command'),{code:ErrorCodes.InvalidParams});
    await assert.rejects(f.execute('axel.rebuildIndex',[{}]),{code:ErrorCodes.InvalidParams});
    assert.deepStrictEqual(await f.execute('axel.rebuildIndex'),{rebuilt:true});assert.strictEqual(f.rebuilds(),1);
  });
  test('accepts the client result when applying the edit synchronizes the changed document',async()=>{
    const f=fixture(true,true);f.reply(()=>{f.change();return {applied:true};});
    assert.deepStrictEqual(await f.execute('axel.applyQuickFix',f.target()),{applied:true});
  });
  test('uses a versioned edit and preserves declined client result',async()=>{
    const f=fixture();const result=await f.execute('axel.applyQuickFix',[{uri:f.uri,position:{character:0,line:0}}]);
    assert.deepStrictEqual(result,{applied:false,failureReason:'Declined'});
    assert.strictEqual(f.requests[0].method,'workspace/applyEdit');
    assert.deepStrictEqual(f.requests[0].params.edit.documentChanges![0],{textDocument:{uri:f.uri,version:3},edits:[{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'#include "types.h"\n'}]});
  });
  test('does not send edits to unsupported clients or after a document change',async()=>{
    const unsupported=fixture(false);assert.strictEqual((await unsupported.execute('axel.applyQuickFix',unsupported.target())).applied,false);
    assert.strictEqual(unsupported.requests.length,0);
    const stale=fixture();stale.analyzeHook(stale.change);
    await assert.rejects(stale.execute('axel.applyQuickFix',stale.target()),{code:LSPErrorCodes.ContentModified});assert.strictEqual(stale.requests.length,0);
  });
  test('rejects invalid source locations and cancellation without dispatch',async()=>{
    const f=fixture();
    for (const args of [[{uri:'https://example.com/a.axl',position:{line:0,character:0}}],[{uri:f.uri,position:{line:-1,character:0}}],[{uri:f.uri,position:{line:100,character:0}}]]) {
      await assert.rejects(f.execute('axel.applyQuickFix',args),{code:ErrorCodes.InvalidParams});
    }
    const source=new CancellationTokenSource();source.cancel();
    await assert.rejects(f.execute('axel.rebuildIndex',[],source.token),{code:LSPErrorCodes.RequestCancelled});assert.strictEqual(f.rebuilds(),0);
  });
  test('showDocument receives validated selection and unsupported clients get a destination',async()=>{
    const f=fixture();f.reply({success:true});
    const result=await f.execute('axel.showSource',f.target());assert.strictEqual(result.success,true);
    assert.strictEqual(f.requests[0].method,'window/showDocument');assert.strictEqual(f.requests[0].params.external,false);
    const fallback=fixture(false);const destination=await fallback.execute('axel.showSource',fallback.target());
    assert.strictEqual(destination.uri,fallback.uri);assert.strictEqual(destination.success,false);assert.strictEqual(fallback.requests.length,0);
  });
  test('cancellation during analysis prevents edits',async()=>{
    const f=fixture(),source=new CancellationTokenSource();f.analyzeHook(()=>source.cancel());
    await assert.rejects(f.execute('axel.applyQuickFix',f.target(),source.token),{code:LSPErrorCodes.RequestCancelled});
    assert.strictEqual(f.requests.length,0);
  });
  test('ignores stale recovery responses and retries only a current request',async()=>{
    const f=fixture();let resolve!:(value:unknown)=>void,retries=0;
    f.reply(()=>new Promise(done=>{resolve=done;}));f.controller.reportError('index','Index failed',async()=>{retries++;});
    await new Promise(done=>setImmediate(done));f.change();resolve({title:'Retry'});
    await new Promise(done=>setImmediate(done));assert.strictEqual(retries,0);
    f.reply({title:'Retry'});f.controller.reportError('index','Index failed',async()=>{retries++;});
    await new Promise(done=>setImmediate(done));assert.strictEqual(retries,1);
  });
  test('rejects malformed range and non-array arguments as InvalidParams',async()=>{
    const f=fixture();
    await assert.rejects(f.execute('axel.showSource',[{uri:f.uri,range:null}]),{code:ErrorCodes.InvalidParams});
    await assert.rejects(f.execute('axel.showSource',{0:{uri:f.uri},length:1} as unknown as unknown[]),{code:ErrorCodes.InvalidParams});
  });
  test('allows a fresh recovery prompt after generation changes',async()=>{
    const f=fixture();f.reply(undefined);
    f.controller.reportError('index','Index failed',async()=>{});
    await new Promise(done=>setImmediate(done));f.change();
    f.controller.reportError('index','Index failed again',async()=>{});
    await new Promise(done=>setImmediate(done));assert.strictEqual(f.requests.length,2);
  });
  test('deduplicates recovery prompts and ignores actions after recovery',async()=>{
    const f=fixture();let resolve!:(value:unknown)=>void,retries=0;
    f.reply(()=>new Promise(done=>{resolve=done;}));
    f.controller.reportError('configuration','Bad settings',async()=>{retries++;});
    f.controller.reportError('configuration','Bad settings',async()=>{retries++;});
    await new Promise(done=>setImmediate(done));assert.strictEqual(f.requests.length,1);
    f.controller.recover('configuration');resolve({title:'Retry'});
    await new Promise(done=>setImmediate(done));assert.strictEqual(retries,0);
    f.reply({title:'Open Settings'});f.controller.reportError('index','Bad index',async()=>{});
    await new Promise(done=>setImmediate(done));assert.strictEqual(f.notifications.length,1);
  });
});
