import type { AnalysisDeclaration, AnalysisRange, AnalysisReference, AnalyzedDocument } from '../types/analysis';
import type { AnalysisStep } from '../util/analysisSteps';
import { findNavigationTargetDeclaration, type NavigationInput, type WorkspaceNavigationIndex } from './navigation';
import { comparePositions, contains, findLocalDeclarations, isTypeDeclaration } from './resolution';
import { createTypeCheckingContext, expandedTypeInput, type TypeDiagnosticsInput } from './typeChecking/diagnostics';
import { compatibleOverloads, evaluateExpression } from './typeChecking/expressions';
import { lookupBinding, lookupClass, scopeFor } from './typeChecking/declarations';
import { dereference, uniquelyResolvedFunctions, type Binding, type ClassInfo, type FunctionInfo, type Type } from './typeChecking/model';
import { callArguments, field, type TypeNode } from './typeChecking/syntax';
import { highlightKind, rangeKey, type HighlightKind } from './documentHighlightAccess';
import { resolveImplicitGuiReference } from './guiReferenceResolution';
import { allGuiMethods } from './guiResolution';

export interface AnalysisDocumentHighlight { range: AnalysisRange; kind: HighlightKind }
interface HighlightWorkspace extends WorkspaceNavigationIndex {
  callHierarchyTypeInput?(analysis: AnalyzedDocument): TypeDiagnosticsInput;
}
interface Occurrence extends AnalysisDocumentHighlight { key: string }

interface CachedOccurrences { documents: readonly AnalyzedDocument[]; catalog: TypeDiagnosticsInput['catalog']; loginScope: TypeDiagnosticsInput['loginScope']; groups: Occurrence[][] }
const occurrenceCache = new WeakMap<AnalyzedDocument, WeakMap<object, CachedOccurrences>>();

/** Collect only this document's occurrences; external documents supply declaration identity. */
export function* getDocumentHighlightsSteps(input: NavigationInput): Generator<AnalysisStep, AnalysisDocumentHighlight[], void> {
  yield;
  const workspace = input.workspaceIndex as HighlightWorkspace;
  const source = input.analysis;
  const typeInput = workspace.callHierarchyTypeInput?.(source)
    ?? {analysis:source,documents:workspace.listVisibleDocuments?.(source.uri) ?? []};
  const dependencies = [typeInput.analysis, ...typeInput.documents ?? [], ...typeInput.loginScope?.documents ?? []];
  const cache = occurrenceCache.get(source);
  const previous = cache?.get(workspace);
  if (previous && previous.catalog === typeInput.catalog && previous.loginScope === typeInput.loginScope
    && dependencies.length === previous.documents.length && dependencies.every((document, i) => previous.documents[i] === document)) {
    return selectOccurrences(previous.groups, input.position);
  }
  const semanticInput = expandedTypeInput(typeInput);
  const analysis = semanticInput.analysis;
  const root = analysis.typeSnapshot?.root;
  if (!root) { return []; }
  const ctx = createTypeCheckingContext(semanticInput);
  const documents = [...new Map([analysis,...semanticInput.documents ?? [],...semanticInput.loginScope?.documents ?? []]
    .map(doc=>[doc.uri,doc])).values()];
  const allDeclarations = documents.flatMap(doc=>doc.declarations);
  const externalGlobalIds = new Set(documents.filter(doc=>doc.uri !== analysis.uri)
    .flatMap(doc=>doc.scopes.filter(scope=>!scope.parentId).flatMap(scope=>scope.declarationIds)));
  const byName = new Map<string, AnalysisDeclaration[]>();
  for (const declaration of allDeclarations) {
    const entries = byName.get(declaration.name) ?? [];
    entries.push(declaration); byName.set(declaration.name, entries);
  }
  const parents = new Map<TypeNode,TypeNode>();
  const nodes = new Map<string,TypeNode>();
  const excluded = [...analysis.inactiveRanges ?? [], ...analysis.uncertainRanges ?? []];
  let visited = 0;
  function* indexNodes(node: TypeNode, parent?: TypeNode): Generator<AnalysisStep,void,void> {
    if (++visited % 128 === 0) { yield; }
    if (parent) { parents.set(node,parent); }
    if (node.kind === 'ERROR' || excluded.some(r=>contains(r,node.range.start))) { return; }
    nodes.set(rangeKey(node.range),node);
    for (const child of node.children) { yield* indexNodes(child,node); }
  }
  yield* indexNodes(root);
  const declarationKeys = new Map<string,string>();
  const functionKeys = new Map<FunctionInfo,string>();
  const typeKey = (type: Type): string => type.element ? `${type.kind}(${typeKey(type.element)})`
    : type.classInfo?.id ?? `${type.kind}:${type.name}`;
  const functionsByKey = new Map<string,FunctionInfo[]>();
  for (const fn of ctx.functions) {
    const key = JSON.stringify(['function',fn.owner?.id ?? '',fn.instancePath ?? '',fn.name,
      fn.parameters.map(typeKey),fn.variadic,
      fn.node.children.some(n=>n.kind === 'storage_class_specifier' && n.text === 'static') && !fn.owner ? fn.uri : '']);
    functionKeys.set(fn,key);
    const group = functionsByKey.get(key) ?? [];
    group.push(fn); functionsByKey.set(key,group);
  }
  for (const group of functionsByKey.values()) {
    const definitions = new Set(group.filter(fn=>fn.node.kind === 'function_definition').map(fn=>`${fn.uri}:${rangeKey(fn.declarator.range)}`));
    if (definitions.size > 1) {
      for (const fn of group) { functionKeys.set(fn,`${functionKeys.get(fn)}:${fn.uri}:${rangeKey(fn.declarator.range)}`); }
    }
  }
  for (const fn of ctx.functions) {
    const key = functionKeys.get(fn)!;
    for (const declaration of byName.get(fn.name) ?? []) {
      if (declaration.uri === fn.uri && declaration.signature && contains(fn.declarator.range,declaration.selectionRange.start)) {
        declarationKeys.set(declaration.id,key);
      }
    }
  }
  const keyOf = (declaration: AnalysisDeclaration): string => declarationKeys.get(declaration.id) ?? declaration.id;
  const declarationsByKey = new Map<string, AnalysisDeclaration>();
  for (const declaration of allDeclarations) { const key = keyOf(declaration); if (!declarationsByKey.has(key)) declarationsByKey.set(key, declaration); }
  const unique = (candidates: AnalysisDeclaration[]): AnalysisDeclaration | undefined => {
    const keys = new Set(candidates.map(keyOf));
    return keys.size === 1 ? candidates[0] : undefined;
  };
  const semanticWorkspace: WorkspaceNavigationIndex = {
    ...workspace,
    listVisibleDocuments: () => documents,
    listVisibleDeclarations: () => allDeclarations,
    findVisibleDeclarations: (_uri,name) => (byName.get(name) ?? []).filter(d=>externalGlobalIds.has(d.id)),
    findGuiClass: (uri,name) => workspace.findGuiClass?.(uri,name)
  };
  function memberBindings(owner: ClassInfo | undefined, name: string, seen = new Set<string>()): Binding[] {
    if (!owner || seen.has(owner.id)) { return []; }
    seen.add(owner.id);
    const direct = owner.fields.get(name);
    if (direct) { return [direct]; }
    return (owner.baseNames ?? (owner.baseName ? [owner.baseName] : []))
      .flatMap(base=>memberBindings(lookupClass(ctx,base,owner.scope),name,seen));
  }
  function bindingDeclarations(bindings: Binding[]): AnalysisDeclaration[] {
    return bindings.flatMap(binding=>(byName.get(binding.name) ?? []).filter(d=>d.uri === binding.uri
      && contains(binding.node.range,d.selectionRange.start)));
  }
  // The generic symbol index labels nested function declarators as functions, including pointer storage.
  // Resolve this distinction once from semantic types instead of rescanning bindings for every occurrence.
  const functionStorage = new Set(bindingDeclarations(ctx.bindings.filter(binding=>binding.type.kind !== 'function'))
    .filter(declaration=>declaration.kind === 'function').map(declaration=>declaration.id));
  function resolve(reference: AnalysisReference, node: TypeNode): AnalysisDeclaration | undefined {
    const parent = parents.get(node);
    const expression = parent && ((parent.kind === 'field_expression' && field(parent,'field') === node)
      || (parent.kind === 'qualified_identifier' && field(parent,'name') === node)) ? parent : node;
    const result = evaluateExpression(ctx,expression,scopeFor(ctx,expression));
    if (result.type.kind === 'function') {
      let candidates = result.type.candidates ?? (result.type.call ? [result.type.call] : []);
      const call = parents.get(expression);
      if (call?.kind === 'call_expression' && field(call,'function') === expression) {
        const args = callArguments(call);
        const matched = compatibleOverloads(ctx,candidates,args.map(arg=>evaluateExpression(ctx,arg,scopeFor(ctx,arg))),'argument');
        candidates = matched.uncertain.length ? [] : matched.viable;
      }
      const resolved = uniquelyResolvedFunctions(candidates);
      const keys = new Set(resolved.map(fn=>functionKeys.get(fn)).filter((key): key is string=>!!key));
      if (keys.size !== 1) { return undefined; }
      return declarationsByKey.get([...keys][0]);
    }
    const nav = {analysis,position:reference.range.start,workspaceIndex:semanticWorkspace};
    if (reference.memberAccess) {
      const scope = scopeFor(ctx,expression);
      let owner: ClassInfo | undefined;
      if (expression.kind === 'field_expression') {
        const receiver = field(expression,'argument');
        let type = receiver && dereference(evaluateExpression(ctx,receiver,scope).type);
        if (type?.kind === 'pointer') { type = type.element; }
        owner = type?.classInfo;
      } else if (expression.kind === 'qualified_identifier') {
        owner = lookupClass(ctx,field(expression,'scope')?.text ?? '',scope);
      }
      const bindings = memberBindings(owner,reference.name);
      if (bindings.length) { return unique(bindingDeclarations(bindings)); }
      const selected = findNavigationTargetDeclaration(nav);
      if (!selected) { return undefined; }
      return unique((byName.get(selected.name) ?? []).filter(d=>d.containerName === selected.containerName && d.kind === selected.kind));
    }
    if (!reference.typeReference) {
      const scope = scopeFor(ctx,node);
      const binding = lookupBinding(ctx,reference.name,scope,node.start);
      const localBinding = binding?.scope.parent && binding.scope !== binding.scope.owner?.scope;
      if (!localBinding) {
        const members = memberBindings(scope.thisType?.classInfo ?? scope.owner,reference.name);
        if (members.length) { return unique(bindingDeclarations(members)); }
      }
    }
    const local = findLocalDeclarations(analysis,reference.name,reference.range.start);
    let candidates = local.length ? local : (byName.get(reference.name) ?? []).filter(d=>externalGlobalIds.has(d.id));
    if (reference.typeReference) { candidates = candidates.filter(isTypeDeclaration); }
    const selected = unique(candidates);
    if (selected) { return selected; }
    // GUI names have dedicated receiver resolution; never turn an ambiguous ordinary lookup into a guess.
    if (!candidates.length) { return resolveImplicitGuiReference(nav,reference)?.declaration; }
    return undefined;
  }
  function mapped(range: AnalysisRange): AnalysisRange | undefined {
    return source.expandedSource ? source.expandedSource.highlightRange?.(range) : range;
  }
  const occurrences: Occurrence[] = [];
  const add = (declaration: AnalysisDeclaration, range: AnalysisRange, node: TypeNode | undefined, declarationSite: boolean) => {
    const sourceRange = mapped(range);
    if (!sourceRange || !node || excluded.some(r=>contains(r,range.start))
      || source.highlightExcludedRanges?.some(r=>contains(r,sourceRange.start))) { return; }
    const classified = functionStorage.has(declaration.id) ? {...declaration,kind:'variable' as const} : declaration;
    occurrences.push({range:sourceRange,key:keyOf(declaration),kind:highlightKind(node,classified,declarationSite,parents,ctx)});
  };
  for (const declaration of analysis.declarations) {
    if (++visited % 64 === 0) { yield; }
    if (declaration.kind !== 'macro') { add(declaration,declaration.selectionRange,nodes.get(rangeKey(declaration.selectionRange)),true); }
  }
  for (const reference of analysis.references) {
    if (++visited % 64 === 0) { yield; }
    const node = nodes.get(rangeKey(reference.range));
    if (!node || reference.preprocessor) { continue; }
    const declaration = resolve(reference,node);
    if (declaration && declaration.kind !== 'macro') { add(declaration,reference.range,node,false); }
  }
  for (const method of allGuiMethods(analysis)) {
    yield;
    for (const range of method.receiverPathSegmentRanges ?? []) {
      const declaration = findNavigationTargetDeclaration({analysis,position:range.start,workspaceIndex:semanticWorkspace});
      if (declaration) { add(declaration,range,nodes.get(rangeKey(range)),false); }
    }
  }
  for (const item of source.highlightMacros ?? []) {
    occurrences.push({range:item.range,key:item.target,kind:'text'});
  }
  const grouped = new Map<string,Occurrence[]>();
  for (const occurrence of occurrences) {
    const entries = grouped.get(rangeKey(occurrence.range)) ?? [];
    entries.push(occurrence); grouped.set(rangeKey(occurrence.range),entries);
  }
  const unambiguous = [...grouped.values()].filter(group=>new Set(group.map(o=>o.key)).size === 1);
  const entries = cache ?? new WeakMap<object, CachedOccurrences>();
  entries.set(workspace, {documents:dependencies, catalog:typeInput.catalog, loginScope:typeInput.loginScope, groups:unambiguous});
  occurrenceCache.set(source, entries);
  return selectOccurrences(unambiguous, input.position);
}

function selectOccurrences(unambiguous: Occurrence[][], position: AnalysisRange['start']): AnalysisDocumentHighlight[] {
  const containing = unambiguous.filter(group=>contains(group[0].range,position));
  const at = containing.length ? containing : unambiguous.filter(group=>comparePositions(group[0].range.end,position) === 0);
  const keys = new Set(at.map(group=>group[0].key));
  if (keys.size !== 1) { return []; }
  const target = [...keys][0];
  return unambiguous.filter(group=>group[0].key === target).map(group=>({range:group[0].range,
    kind:group.some(o=>o.kind === 'write') ? 'write' as const : group.every(o=>o.kind === 'read') ? 'read' as const : 'text' as const
  })).sort((a,b)=>comparePositions(a.range.start,b.range.start) || comparePositions(a.range.end,b.range.end));
}
