import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CancellationToken, ErrorCodes, LSPErrorCodes, MessageType, ResponseError, ShowDocumentRequest, ShowMessageRequest, ApplyWorkspaceEditRequest, type ExecuteCommandParams, type Position, type Range } from 'vscode-languageserver/node';
import { progressRequest } from './workProgress';
import type { HandlerRegistrationContext } from './registerHandlers';
import type { AnalyzeDocumentInput, AnalyzedDocument } from '../types/analysis';
import { getCodeActions } from '../analyzer/codeActions';
import { cancellationCheckpoint, throwIfCancelled } from '../util/cancellation';

export const AXEL_COMMANDS = ['axel.rebuildIndex', 'axel.applyQuickFix', 'axel.showSource'];
export interface OperationLifecycle {
  request<P,T>(work:(params:P,token:CancellationToken)=>Promise<T>):(params:P,token?:CancellationToken)=>Promise<T>;
  analyzeRequest(token:CancellationToken,input:AnalyzeDocumentInput):Promise<AnalyzedDocument>;
  revision():number;
  rebuildIndex(token:CancellationToken):Promise<unknown>;
}
type RecoveryKind = 'configuration' | 'index';
function invalid(message:string):never { throw new ResponseError(ErrorCodes.InvalidParams,message); }
function position(value:unknown):value is Position {
  const p=value as Position | undefined;
  return !!p && Number.isSafeInteger(p.line) && p.line>=0 && Number.isSafeInteger(p.character) && p.character>=0;
}
function samePosition(a:Position,b:Position):boolean {return a.line===b.line && a.character===b.character;}
function before(a:Position,b:Position):boolean {return a.line<b.line || (a.line===b.line && a.character<=b.character);}
function target(args:unknown[]|undefined):{uri:string;position?:Position;range?:Range} {
  if (!Array.isArray(args) || args.length!==1 || !args[0] || typeof args[0]!=='object') {return invalid('Expected one source location argument.');}
  const value=args[0] as {uri:string;position?:Position;range?:Range};
  try {
    const url=new URL(value.uri);
    if (url.protocol!=='file:' || url.hostname || url.search || url.hash || !fileURLToPath(url)) {return invalid('Expected a local file URI.');}
  } catch {return invalid('Expected a local file URI.');}
  if (value.position!==undefined && !position(value.position)) {return invalid('Invalid source position.');}
  if (value.range!==undefined && (!value.range || !position(value.range.start) || !position(value.range.end) || !before(value.range.start,value.range.end))) {return invalid('Invalid source range.');}
  return value;
}

/** Explicit user operations. Edits remain client-owned until normal document synchronization. */
export function registerOperationHandlers(context:HandlerRegistrationContext,lifecycle:OperationLifecycle) {
  let disposed=false;
  const errors=new Map<RecoveryKind,{message:string;revision:number}>();
  const current=(revision:number)=>{
    if (disposed || lifecycle.revision()!==revision) {throw new ResponseError(LSPErrorCodes.ContentModified,'Workspace changed during operation.');}
  };
  const execute=lifecycle.request(async(params:ExecuteCommandParams,token:CancellationToken):Promise<unknown>=>{
    throwIfCancelled(token);
    if (!AXEL_COMMANDS.includes(params.command)) {return invalid('Unknown AXEL command.');}
    // Rebuild is dispatched separately: it intentionally advances the workspace revision.
    const source=target(params.arguments), revision=lifecycle.revision();
    const document=context.documents.get(source.uri);
    if (params.command==='axel.applyQuickFix') {
      if (!document || document.languageId!=='axel' || !source.position) {return invalid('Quick Fix requires an open AXEL document and position.');}
      const offset=document.offsetAt(source.position);
      if (!samePosition(document.positionAt(offset),source.position)) {return invalid('Position is outside the document.');}
      if (context.clientCapabilities?.workspace?.applyEdit!==true || context.clientCapabilities.workspace.workspaceEdit?.documentChanges!==true) {
        return {applied:false,failureReason:'Client does not support versioned workspace edits.'};
      }
      const input={uri:document.uri,version:document.version,text:document.getText()};
      const analysis=await lifecycle.analyzeRequest(token,input);
      const diagnostics=analysis.diagnostics.filter(d=>before(d.range.start,source.position!) && before(source.position!,d.range.end)
        && !(d.range.end.line===source.position!.line && d.range.end.character===source.position!.character));
      const actions=getCodeActions({analysis,diagnostics,range:{start:source.position,end:{line:source.position.line,character:source.position.character+1}},workspaceIndex:context.analyzer});
      await cancellationCheckpoint(token);current(revision);
      const latest=context.documents.get(input.uri);
      if (latest?.version!==input.version || latest.getText()!==input.text) {throw new ResponseError(LSPErrorCodes.ContentModified,'Document changed during Quick Fix.');}
      if (actions.length!==1) {return {applied:false,failureReason:'No unambiguous Quick Fix at this position.'};}
      const action=actions[0], edits=action.edit.changes[input.uri];
      if (!edits?.length || Object.keys(action.edit.changes).length!==1) {return {applied:false,failureReason:'Quick Fix is outside the current document.'};}
      // Dispatch after leaving the analysis queue: client synchronization caused by
      // this edit is expected and must not fail the request's final revision guard.
      return () => {
        throwIfCancelled(token);current(revision);
        const currentDocument=context.documents.get(input.uri);
        if (currentDocument?.version!==input.version || currentDocument.getText()!==input.text) {
          throw new ResponseError(LSPErrorCodes.ContentModified,'Document changed before applying Quick Fix.');
        }
        return context.connection.sendRequest(ApplyWorkspaceEditRequest.type,{label:action.title,edit:{documentChanges:[{textDocument:{uri:input.uri,version:input.version},edits}]}},token);
      };
    }
    if (!document) {
      let exists=false;
      try {exists=(await stat(fileURLToPath(source.uri))).isFile();} catch { /* A missing source cannot be opened. */ }
      if (!exists) {return invalid('Source file does not exist.');}
    }
    const selection=source.range ?? (source.position ? {start:source.position,end:source.position} : undefined);
    if (document && selection && [selection.start,selection.end].some(p=>!samePosition(document.positionAt(document.offsetAt(p)),p))) {return invalid('Selection is outside the document.');}
    await cancellationCheckpoint(token);current(revision);
    if (context.clientCapabilities?.window?.showDocument?.support!==true) {return {success:false,uri:source.uri,range:selection};}
    return async () => {
      throwIfCancelled(token);current(revision);
      const result=await context.connection.sendRequest(ShowDocumentRequest.type,{uri:source.uri,external:false,takeFocus:true,selection},token);
      return {...result,uri:source.uri,range:selection};
    };
  });
  progressRequest<ExecuteCommandParams, unknown>(context, 'workspace/executeCommand', 'AXEL: Execute command',
    handler => context.connection.onExecuteCommand?.(handler), async(params:ExecuteCommandParams,token=CancellationToken.None)=>{
    throwIfCancelled(token);
    if (params.command==='axel.rebuildIndex') {
      if (params.arguments!==undefined && (!Array.isArray(params.arguments) || params.arguments.length)) {return invalid('Rebuild Index takes no arguments.');}
      if (disposed) {throw new ResponseError(LSPErrorCodes.RequestCancelled,'Server is shutting down.');}
      return lifecycle.rebuildIndex(token);
    }
    const result=await execute(params,token);
    return typeof result==='function' ? (result as () => Promise<unknown>)() : result;
  });
  return {
    reportError(kind:RecoveryKind,message:string,retry:()=>Promise<unknown>):void {
      if (disposed || errors.get(kind)?.revision===lifecycle.revision()) {return;}
      const entry={message,revision:lifecycle.revision()};errors.set(kind,entry);
      void Promise.resolve().then(()=>context.connection.sendRequest(ShowMessageRequest.type,{type:MessageType.Error,message,actions:[{title:'Retry'},{title:'Open Settings'}]})).then(async action=>{
        if (disposed || errors.get(kind)!==entry || lifecycle.revision()!==entry.revision) {return;}
        if (action?.title==='Retry') {errors.delete(kind);await retry();}
        else if (action?.title==='Open Settings') {await context.connection.sendNotification('axel/openSettings',{section:'axel'});}
      }).catch(error=>{context.logger.error(`Recovery action failed: ${String(error)}`);});
    },
    recover(kind:RecoveryKind):void {errors.delete(kind);},
    dispose():void {disposed=true;errors.clear();}
  };
}
