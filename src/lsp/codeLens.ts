import { randomUUID } from 'node:crypto';
import { CodeLensRefreshRequest, type CancellationToken, type CodeLens, type CodeLensParams } from 'vscode-languageserver/node';
import type { AnalyzeDocumentInput, AnalyzedDocument } from '../types/analysis';
import type { HandlerRegistrationContext } from './registerHandlers';
import type { TypeHierarchyIndex } from '../analyzer/typeHierarchy/index';
import { getCodeLensCandidates, type CodeLensCandidate } from '../analyzer/codeLens';
import { findNavigationTargetDeclaration, getReferencesSteps, type AnalysisLocation } from '../analyzer/navigation';
import { runAnalysisStepsAsync } from '../util/analysisSteps';
import { rethrowCancellation, throwIfCancelled } from '../util/cancellation';

interface Lifecycle {
  request<P,T>(work:(params:P,token:CancellationToken)=>Promise<T>):(params:P,token?:CancellationToken)=>Promise<T>;
  analyzeRequest(token:CancellationToken,input:AnalyzeDocumentInput):Promise<AnalyzedDocument>;
}
interface Entry { candidate:CodeLensCandidate; input:AnalyzeDocumentInput; revision:number; generation:number; locations?:AnalysisLocation[] }

export function registerCodeLensHandlers(context:HandlerRegistrationContext, index:TypeHierarchyIndex,
  lifecycle:Lifecycle, revision:()=>number):{refresh():void;dispose():void} {
  const entries = new Map<string,Entry>();
  const bySource = new Map<string,Set<string>>();
  let generation = 0, disposed = false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const enabled = () => !disposed && (context.configuration?.settings as {codeLens?:{enabled?:boolean}}|undefined)?.codeLens?.enabled === true;
  let wasEnabled = enabled();
  const clear = () => { generation++; entries.clear(); bySource.clear(); };
  const valid = (entry:Pick<Entry,'input'|'revision'|'generation'>) => {
    const document = context.documents.get(entry.input.uri);
    return enabled() && entry.revision === revision() && entry.generation === generation
      && document?.version === entry.input.version && document.getText() === entry.input.text;
  };
  const unresolved = (lens:CodeLens):CodeLens => ({range:lens.range,data:lens.data});
  context.connection.onCodeLens?.(lifecycle.request(async (params:CodeLensParams,token):Promise<CodeLens[]> => {
    if (!enabled()) { clear(); return []; }
    const document = context.documents.get(params.textDocument.uri);
    if (!document) { return []; }
    const input = {uri:document.uri,version:document.version,text:document.getText()};
    const snapshot = {input,revision:revision(),generation};
    const sourceIds = [...bySource.get(input.uri) ?? []];
    let sourceEntries = sourceIds.map(id => entries.get(id)!).filter(Boolean);
    // A new enumeration is not an invalidation: clients may still resolve either batch.
    if (sourceEntries.length && sourceEntries.every(valid)) {
      return sourceIds.map(id => ({range:entries.get(id)!.candidate.range,data:{id}}));
    }
    if (!sourceEntries.length || !sourceEntries.every(valid)) {
      const analysis = await lifecycle.analyzeRequest(token,input);
      throwIfCancelled(token);
      if (!valid(snapshot)) { return []; }
      sourceEntries = getCodeLensCandidates(analysis,context.analyzer).map(candidate => ({...snapshot,candidate}));
    }
    for (const id of bySource.get(input.uri) ?? []) { entries.delete(id); }
    const ids = new Set<string>(); bySource.set(input.uri,ids);
    return sourceEntries.map(entry => {
      const id = randomUUID(); ids.add(id); entries.set(id,entry);
      return {range:entry.candidate.range,data:{id}};
    });
  }));
  context.connection.onCodeLensResolve?.(lifecycle.request(async (lens:CodeLens,token):Promise<CodeLens> => {
    if (!enabled()) { clear(); return unresolved(lens); }
    const entry = typeof lens.data?.id === 'string' ? entries.get(lens.data.id) : undefined;
    if (!entry || !valid(entry) || JSON.stringify(lens.range) !== JSON.stringify(entry.candidate.range)) { return unresolved(lens); }
    try {
      let locations = entry.locations;
      if (!locations) {
        if (entry.candidate.kind === 'implementations') {
          locations = await index.navigate('implementation',entry.input.uri,entry.candidate.range.start,token);
        } else {
          const analysis = await lifecycle.analyzeRequest(token,entry.input);
          if (!valid(entry)) { return unresolved(lens); }
          const input = {analysis,position:entry.candidate.range.start,workspaceIndex:context.analyzer,includeDeclaration:false};
          if (!findNavigationTargetDeclaration(input)) { return unresolved(lens); }
          locations = await runAnalysisStepsAsync(getReferencesSteps(input),token);
        }
        throwIfCancelled(token);
        if (!valid(entry)) { return unresolved(lens); }
        entry.locations = locations;
      }
      const name = entry.candidate.kind === 'references' ? 'reference' : 'implementation';
      const scope = entry.candidate.kind === 'references' ? 'indexed scope' : 'project scope';
      return {...unresolved(lens),command:{title:`${locations.length} ${name}${locations.length === 1 ? '' : 's'} (${scope})`,
        command:'editor.action.showReferences',arguments:[entry.input.uri,entry.candidate.range.start,locations]}};
    } catch (error) {
      rethrowCancellation(error); throwIfCancelled(token);
      context.logger.error(`Code Lens resolve failed: ${String(error)}`);
      return unresolved(lens);
    }
  }));
  return {
    refresh() {
      const active = enabled(); const needed = active || wasEnabled; wasEnabled = active; clear();
      if (disposed || !needed || context.clientCapabilities?.workspace?.codeLens?.refreshSupport !== true) { return; }
      timer ??= setTimeout(() => {
        timer = undefined;
        if (!disposed) { void Promise.resolve().then(() => context.connection.sendRequest?.(CodeLensRefreshRequest.type))
          .catch(error => context.logger.error(`Code Lens refresh failed: ${String(error)}`)); }
      },40);
    },
    dispose() { disposed = true; clearTimeout(timer); timer = undefined; clear(); }
  };
}
