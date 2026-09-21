import { contains } from './resolution';
import { field } from './typeChecking/syntax';
import { canonicalPath, fileIdentity, filePath } from './projectScope';
import type { AnalysisDeclaration, AnalysisRange } from '../types/analysis';
import { callTargetDeclarations, findNavigationTargetDeclaration, type NavigationInput, type AnalysisLocation } from './navigation';
import { collectOverrides, declarationsForFunction } from './callHierarchySemantics';
import { createTypeTargetContext, resolveTypeTarget, typeTargetInput, typeNodeExcluded, sourceTypeRange, type TypeTargetContext } from './typeTarget';
import { classKey, classRecord } from './typeHierarchy/semantics';
import { sameFunctionSignature, type ClassInfo, type FunctionInfo, type Scope, type Type } from './typeChecking/model';

export const declarationLocation = (declaration: AnalysisDeclaration): AnalysisLocation => ({uri:declaration.uri,range:declaration.selectionRange});
const locationKeys = new WeakMap<AnalysisLocation, string>();
export function locationKey(location: AnalysisLocation): string {
  const cached=locationKeys.get(location);if(cached)return cached;
  const file=filePath(location.uri);const key=JSON.stringify([file?fileIdentity(canonicalPath(file)):location.uri,location.range]);
  locationKeys.set(location,key);return key;
}
export function uniqueLocations(locations: AnalysisLocation[]): AnalysisLocation[] {
  return [...new Map(locations.map(location=>[locationKey(location),location])).values()]
    .sort((a,b)=>a.uri.localeCompare(b.uri)||a.range.start.line-b.range.start.line||a.range.start.character-b.range.start.character);
}
export function getTypeDefinitions(input: NavigationInput, supplied?: TypeTargetContext): AnalysisLocation[] {
  const context=supplied??createTypeTargetContext(typeTargetInput(input.analysis,input.workspaceIndex));
  if(!context)return [];
  const target=resolveTypeTarget(input,context);if(!target)return [];
  let type=target.type;const seen=new Set<typeof type>();
  while(type.element&&!seen.has(type)){seen.add(type);type=type.element;}
  if(type.kind==='unknown'||type.kind==='function')return [];
  const onDeclaration=target.declaration.uri===input.analysis.uri&&contains(target.declaration.selectionRange,input.position);
  const alias=target.aliases.find(item=>!onDeclaration||item.id!==target.declaration.id);
  if(alias)return [declarationLocation(alias)];
  const record=target.classInfo && classRecord(context,target.classInfo);
  return record?[{uri:record.uri,range:record.selectionRange}]:[];
}
export interface FunctionTargets { pure?:boolean; owner?:string; signature:string; members:AnalysisLocation[]; declarations:AnalysisLocation[]; definitions:AnalysisLocation[]; bases:AnalysisLocation[] }
// Match the existing AXEL sameType rules: references and const do not distinguish overloads.
function typeShape(type:Type):unknown {
  if(type.kind==='reference'&&type.element)return typeShape(type.element);
  return [type.kind,type.classInfo?classKey(type.classInfo):type.name,type.element?typeShape(type.element):null];
}
function functionSignature(fn:FunctionInfo):string { return JSON.stringify([fn.name,fn.parameters.map(typeShape),fn.variadic,fn.instancePath]); }
function lexicalScope(fn:FunctionInfo):Scope { return fn.scope.node.kind==='function_definition' && fn.scope.parent ? fn.scope.parent : fn.scope; }
function sameOwner(a:FunctionInfo,b:FunctionInfo):boolean {
  if(a.owner||b.owner)return !!a.owner && !!b.owner && classKey(a.owner)===classKey(b.owner);
  const x=lexicalScope(a),y=lexicalScope(b);
  const local=[a,b].some(fn=>fn.node.children.some(n=>n.kind==='storage_class_specifier'&&n.text.split(/\s+/).includes('static')));
  if(!x.parent && !y.parent)return !local||a.uri===b.uri;
  return x.uri===y.uri && x.node.start===y.node.start && x.node.end===y.node.end;
}
/** Compact callable declaration/body/override relations; no expression evaluation or native trees retained. */
export function collectFunctionTargets(context:TypeTargetContext):FunctionTargets[] {
  const groups=new Map<string,{functions:FunctionInfo[];record:FunctionTargets}[]>();
  const edges=collectOverrides(context.input,context.types);
  const owners=new Map<ClassInfo,boolean>();
  const validOwner=(owner:ClassInfo):boolean=>{
    if(!owners.has(owner))owners.set(owner,!!classRecord(context,owner));
    return owners.get(owner)!;
  };
  for(const fn of context.types.functions){
    if(typeNodeExcluded(context,fn.uri,fn.declarator.range)||(fn.owner&&!validOwner(fn.owner)))continue;
    const signature=functionSignature(fn);
    const declarations=declarationsForFunction(context.input,context.types,fn).map(declarationLocation);
    if(!declarations.length)continue;
    const bucket=groups.get(fn.name)??[];
    let group=bucket.find(g=>sameOwner(g.functions[0],fn)&&sameFunctionSignature(g.functions[0],fn)
      &&g.record.signature===signature);
    if(!group){group={functions:[],record:{owner:fn.owner?classKey(fn.owner):undefined,signature,members:[],declarations:[],definitions:[],bases:[]}};bucket.push(group);groups.set(fn.name,bucket);}
    group.functions.push(fn);group.record.members.push(...declarations);
    const pure=fn.node.children.some(node=>node.kind==='init_declarator'
      && field(node,'value')?.kind==='integer_literal' && field(node,'value')?.text==='0'
      && !!field(node,'declarator') && contains(field(node,'declarator')!.range,fn.declarator.range.start));
    if(pure)group.record.pure=true;
    (fn.node.kind==='function_definition'?group.record.definitions:group.record.declarations).push(...declarations);
  }
  const records=[...groups.values()].flatMap(groups=>groups.map(g=>g.record));
  const byMember=new Map(records.flatMap(record=>record.members.map(member=>[locationKey(member),record] as const)));
  for(const edge of edges){
    const derived=byMember.get(locationKey(declarationLocation(edge.derived)));
    const base=byMember.get(locationKey(declarationLocation(edge.base)));
    if(derived&&base&&derived.signature===base.signature)derived.bases.push(declarationLocation(edge.base));
  }
  for(const record of records)for(const key of ['members','declarations','definitions','bases'] as const)record[key]=uniqueLocations(record[key]);
  return records;
}
export function navigationTargets(input:NavigationInput):AnalysisDeclaration[] {
  if([...input.analysis.inactiveRanges??[],...input.analysis.uncertainRanges??[],...input.analysis.completionExcludedRanges??[],...input.analysis.syntaxRecovery?.ranges??[]].some(range=>contains(range,input.position)))return [];
  const calls=callTargetDeclarations(input);if(calls!==undefined)return calls;
  const target=findNavigationTargetDeclaration(input);return target?[target]:[];
}
export function getDeclarations(input:NavigationInput,supplied?:TypeTargetContext, suppliedRecords?:FunctionTargets[]):AnalysisLocation[] {
  const targets=navigationTargets(input);if(!targets.length)return [];
  const context=supplied??createTypeTargetContext(typeTargetInput(input.analysis,input.workspaceIndex));
  const records=suppliedRecords??(context?collectFunctionTargets(context):[]);
  if(context && targets.length===1 && ['class','struct','union'].includes(targets[0].kind)){
    const info=resolveTypeTarget(input,context)?.classInfo;
    if(info){
      const forward:AnalysisLocation[]=[];
      for(const [node,scope] of context.types.nodeScopes){
        const name=field(node,'name');
        if(node.kind!==info.node.kind||field(node,'body')||name?.text!==info.name||typeNodeExcluded(context,scope.uri,node.range))continue;
        if(scope!==info.scope.parent && (scope.parent||info.scope.parent?.parent))continue;
        forward.push({uri:scope.uri,range:sourceTypeRange(context,scope.uri,name.range)});
      }
      if(forward.length)return uniqueLocations(forward);
    }
  }
  return uniqueLocations(targets.flatMap(target=>{
    const record=records.find(record=>record.members.some(member=>locationKey(member)===locationKey(declarationLocation(target))));
    return record?.declarations.length?record.declarations:[declarationLocation(target)];
  }));
}
export function rangeContains(outer:AnalysisRange,inner:AnalysisRange):boolean {
  const cmp=(a:AnalysisRange['start'],b:AnalysisRange['start'])=>a.line-b.line||a.character-b.character;
  return cmp(outer.start,inner.start)<=0&&cmp(inner.end,outer.end)<=0;
}

/** Pure virtual obligations flow through inheritance and are removed by semantic overrides. */
export function abstractTypes(types: readonly {key:string;bases:string[]}[], functions: readonly FunctionTargets[]):Set<string> {
  const byType=new Map(types.map(type=>[type.key,type]));
  const byMember=new Map(functions.flatMap(fn=>fn.members.map(member=>[locationKey(member),fn] as const)));
  const methods=new Map<string,FunctionTargets[]>();
  for(const fn of functions)if(fn.owner){const list=methods.get(fn.owner)??[];list.push(fn);methods.set(fn.owner,list);}
  const memo=new Map<string,Set<string>>();
  const overrides=(fn:FunctionTargets,seen=new Set<FunctionTargets>()):Set<string>=>{
    if(seen.has(fn))return new Set();seen.add(fn);
    const result=new Set(fn.members.map(locationKey));
    for(const base of fn.bases){const key=locationKey(base);result.add(key);const parent=byMember.get(key);if(parent)for(const value of overrides(parent,seen))result.add(value);}
    return result;
  };
  const obligations=(key:string,visiting=new Set<string>()):Set<string>=>{
    const cached=memo.get(key);if(cached)return cached;
    if(visiting.has(key))return new Set(['cycle']);
    visiting.add(key);const result=new Set<string>();
    for(const base of byType.get(key)?.bases??[])for(const item of obligations(base,visiting))result.add(item);
    for(const fn of methods.get(key)??[]){
      for(const item of overrides(fn))result.delete(item);
      if(fn.pure)for(const member of fn.members)result.add(locationKey(member));
    }
    visiting.delete(key);memo.set(key,result);return result;
  };
  return new Set(types.filter(type=>obligations(type.key).size>0).map(type=>type.key));
}
