import { CancellationToken, ErrorCodes, LSPErrorCodes, ResponseError, type Position, type TextDocumentPositionParams, type SelectionRangeParams } from 'vscode-languageserver/node';
import type { TypeHierarchyIndex } from '../analyzer/typeHierarchy/index';
import type { HandlerRegistrationContext } from './registerHandlers';
import { cancellationCheckpoint, createRequestHandler, rethrowCancellation, throwIfCancelled } from '../util/cancellation';
import { runAnalysisStepsAsync } from '../util/analysisSteps';
interface Lifecycle {
  request<P,T>(work:(params:P,token:CancellationToken)=>Promise<T>):(params:P,token?:CancellationToken)=>Promise<T>;
}
function positionValid(position:Position):boolean { return !!position && Number.isInteger(position.line) && Number.isInteger(position.character) && position.line>=0 && position.character>=0; }
function validDocument(params:{textDocument:{uri:string}}):void {
  if(!params?.textDocument || typeof params.textDocument.uri!=='string')throw new ResponseError(ErrorCodes.InvalidParams,'Expected document URI.');
}
export function registerNavigationFeatures(context:HandlerRegistrationContext,index:TypeHierarchyIndex,lifecycle:Lifecycle,revision:()=>number):void {
  for(const [kind,register] of [ ['declaration',context.connection.onDeclaration], ['typeDefinition',context.connection.onTypeDefinition], ['implementation',context.connection.onImplementation] ] as const){
    register?.call(context.connection,lifecycle.request(async (params:TextDocumentPositionParams,token)=>{
      validDocument(params);if(!positionValid(params.position))throw new ResponseError(ErrorCodes.InvalidParams,'Expected UTF-16 position.');
      const start=Date.now();
      try { const result=await index.navigate(kind,params.textDocument.uri,params.position,token);
        context.logger.info?.(`[timing] operation=lsp.${kind} uri=${params.textDocument.uri} durationMs=${Date.now()-start}`);return result;
      } catch(error){rethrowCancellation(error);throwIfCancelled(token);if(error instanceof ResponseError)throw error;
        context.logger.error(`${kind} failed: ${String(error)}`);throw new ResponseError(LSPErrorCodes.RequestFailed,'Navigation failed; see server log.');}
    }));
  }
  // Original-source selection never waits in the semantic/dependency request queue.
  const queue=createRequestHandler();
  const select=queue(async (entry:{params:SelectionRangeParams;revision:number},token)=>{
    const validate=()=>{throwIfCancelled(token);if(entry.revision!==revision())throw new ResponseError(LSPErrorCodes.ContentModified,'Document changed during selection.');};
    validate();const {params}=entry;validDocument(params);
    if(!Array.isArray(params.positions)||!params.positions.every(positionValid))throw new ResponseError(ErrorCodes.InvalidParams,'Expected positions.');
    const document=context.documents.get(params.textDocument.uri);if(!document||!context.analyzer.getSelectionRangesSteps)return [];
    const start=Date.now();
    const result=await runAnalysisStepsAsync(context.analyzer.getSelectionRangesSteps({uri:document.uri,version:document.version,text:document.getText()},params.positions),token,validate);
    await cancellationCheckpoint(token);validate();
    context.logger.info?.(`[timing] operation=lsp.selectionRange uri=${document.uri} version=${document.version} durationMs=${Date.now()-start}`);return result;
  });
  context.connection.onSelectionRanges?.(async (params,token=CancellationToken.None)=>{
    const entry={params,revision:revision()};await context.configuration!.ready(token);return select(entry,token);
  });
}
