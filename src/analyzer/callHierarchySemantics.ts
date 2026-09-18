import type { AnalysisDeclaration, AnalysisRange } from '../types/analysis';
import type { AnalysisStep } from '../util/analysisSteps';
import { containsSourcePosition } from './systemMacros';
import { checkCompatibility } from './typeChecking/compatibility';
import { createTypeCheckingContext, expandedTypeInput, type TypeDiagnosticsInput } from './typeChecking/diagnostics';
import { lookupBinding, lookupClass, scopeFor } from './typeChecking/declarations';
import { checkCondition, compatibleOverloads, evaluateExpression } from './typeChecking/expressions';
import { sameFunctionSignature, uniquelyResolvedFunctions, type FunctionInfo, type TypeContext } from './typeChecking/model';
import { field, type TypeNode } from './typeChecking/syntax';

export interface SemanticCallData {
  calls: { range: AnalysisRange; expandedRange?: AnalysisRange; targets: AnalysisDeclaration[] }[];
  references: { range: AnalysisRange; expandedRange?: AnalysisRange; targets: AnalysisDeclaration[] }[];
  overrides: { derived: AnalysisDeclaration; base: AnalysisDeclaration }[];
}

export function* collectSemanticCallData(input: TypeDiagnosticsInput): Generator<AnalysisStep, SemanticCallData, void> {
  const semanticInput = expandedTypeInput(input);
  const root = semanticInput.analysis.typeSnapshot?.root;
  if (!root) { return {calls:[],references:[],overrides:[]}; }
  const ctx = createTypeCheckingContext(semanticInput);
  const excluded = [...semanticInput.analysis.inactiveRanges ?? [], ...semanticInput.analysis.uncertainRanges ?? []];
  let visited = 0;
  const valueReferences = new Set(semanticInput.analysis.references
    .filter(reference => !reference.call && !reference.typeReference && !reference.preprocessor)
    .map(reference => rangeKey(reference.range)));
  const references: SemanticCallData['references'] = [];

  function* visit(node: TypeNode, parent?: TypeNode): Generator<AnalysisStep, void, void> {
    if (++visited % 128 === 0) { yield; }
    if (node.kind === 'ERROR' || excluded.some(range => containsSourcePosition(range,node.range.start))) { return; }
    const scope = scopeFor(ctx,node);
    if (['identifier','field_identifier'].includes(node.kind) && valueReferences.has(rangeKey(node.range))) {
      const expression = parent && (field(parent,'field') === node || field(parent,'name') === node)
        && ['field_expression','qualified_identifier'].includes(parent.kind) ? parent : node;
      const result = evaluateExpression(ctx,expression,scope);
      if (result.type.kind === 'function') {
        const candidates = uniquelyResolvedFunctions(result.type.candidates ?? (result.type.call ? [result.type.call] : []));
        const targets = uniqueDeclarations(preferredCallTargets(input,candidates)
          .flatMap(target => declarationsForFunction(input,ctx,target)));
        if (targets.length) {
          references.push({range:sourceRange(input.analysis,node.range,semanticInput.analysis,true),
            ...(input.analysis.expandedSource ? {expandedRange:node.range} : {}),targets});
        }
      }
    }
    if (node.kind.endsWith('_expression') && node.kind !== 'expression_statement') {
      evaluateExpression(ctx,node,scope);
    }
    if (node.kind === 'init_declarator') {
      const value = field(node,'value');
      const name = declarationName(field(node,'declarator'));
      const binding = name && lookupBinding(ctx,name.text,scope,node.end);
      if (value && binding) {
        const result = evaluateExpression(ctx,value,scope);
        checkCompatibility(ctx,result.type,binding.type,'initialize',value);
      } else if (binding?.type.classInfo) {
        const args = node.children.filter(child => child !== field(node,'declarator'));
        if (args.length) { recordConstructor(ctx,name ?? node,binding.type.classInfo.methods.get(binding.type.classInfo.name) ?? [],args,scope); }
      }
    }
    if (node.kind === 'object_definition') {
      for (const declarator of node.fields.declarator ?? []) {
        if (declarator.kind === 'init_declarator' || declarator.kind.includes('function_declarator')) { continue; }
        const name = declarationName(declarator);
        const binding = name && lookupBinding(ctx,name.text,scope,node.end);
        if (name && binding?.type.classInfo) {
          recordConstructor(ctx,name,binding.type.classInfo.methods.get(binding.type.classInfo.name) ?? [],[],scope);
        }
      }
    }
    if (node.kind === 'return_statement') {
      const value = node.children[0];
      if (value && scope.fn) {
        const result = evaluateExpression(ctx,value,scope);
        checkCompatibility(ctx,result.type,scope.fn.result,'return',value);
      }
    }
    if (['if_statement','while_statement','do_statement','for_statement'].includes(node.kind)) {
      const condition = field(node,'condition');
      if (condition) { checkCondition(ctx,condition,evaluateExpression(ctx,condition,scope)); }
    }
    for (const child of node.children) {
      if (node.kind.startsWith('preproc_') && field(node,'condition') === child) { continue; }
      yield* visit(child,node);
    }
  }
  yield* visit(root);

  const calls = ctx.semanticCalls.map(call => {
    const range = sourceRange(input.analysis,call.node.range,semanticInput.analysis,true);
    const targets = uniqueDeclarations(preferredCallTargets(input,call.targets)
      .flatMap(target => declarationsForFunction(input,ctx,target)));
    return {range,...(input.analysis.expandedSource ? {expandedRange:call.node.range} : {}),targets};
  });
  const uniqueCalls = new Map<string,SemanticCallData['calls'][number]>();
  for (const call of calls) {
    const key = `${rangeKey(call.range)}:${call.expandedRange ? rangeKey(call.expandedRange) : ''}:${call.targets.map(target => target.id).sort().join('|')}`;
    uniqueCalls.set(key,call);
  }
  const overrides = collectOverrides(input,ctx);
  return {
    calls:[...uniqueCalls.values()].sort((left,right) => compareRanges(left.range,right.range)),
    references,
    overrides
  };
}

function preferredCallTargets(input: TypeDiagnosticsInput, candidates: FunctionInfo[]): FunctionInfo[] {
  const definitions = candidates.filter(candidate => candidate.node.kind === 'function_definition');
  const localDefinitions = definitions.filter(candidate => candidate.uri === input.analysis.uri);
  if (localDefinitions.length === 1) { return localDefinitions; }
  if (localDefinitions.length > 1) { return []; }
  if (definitions.length === 1) { return definitions; }
  if (definitions.length > 1) { return []; }
  return candidates;
}

function recordConstructor(ctx: TypeContext, site: TypeNode, candidates: FunctionInfo[], args: TypeNode[],
  scope: ReturnType<typeof scopeFor>): void {
  const values = args.map(arg => evaluateExpression(ctx,arg,scope));
  const {viable,uncertain} = compatibleOverloads(ctx,candidates,values,'argument');
  const targets = uniquelyResolvedFunctions([...viable,...uncertain]);
  ctx.semanticCalls.push({node:site,targets});
  if (targets.length) {
    args.forEach((arg,index) => {
      if (targets[0].parameters[index]) {
        checkCompatibility(ctx,values[index].type,targets[0].parameters[index],'argument',arg);
      }
    });
  }
}

function declarationName(node: TypeNode | undefined): TypeNode | undefined {
  if (!node) { return undefined; }
  if (node.kind === 'identifier' || node.kind === 'field_identifier') { return node; }
  return declarationName(field(node,'declarator'));
}

function collectOverrides(input: TypeDiagnosticsInput, ctx: TypeContext): SemanticCallData['overrides'] {
  const result: SemanticCallData['overrides'] = [];
  const seen = new Set<string>();
  for (const derived of ctx.functions) {
    const owner = derived.owner;
    if (!owner?.baseName) { continue; }
    const bases = overriddenBaseMethods(ctx,owner,derived,new Set());
    for (const base of bases) {
      if (!isVirtualMethod(ctx,base,new Set())) { continue; }
      for (const derivedDeclaration of declarationsForFunction(input,ctx,derived)) {
        for (const baseDeclaration of declarationsForFunction(input,ctx,base)) {
          const key = `${derivedDeclaration.id}->${baseDeclaration.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            result.push({derived:derivedDeclaration,base:baseDeclaration});
          }
        }
      }
    }
  }
  return result;
}

function overriddenBaseMethods(ctx: TypeContext, owner: NonNullable<FunctionInfo['owner']>, derived: FunctionInfo,
  seen: Set<string>): FunctionInfo[] {
  if (seen.has(owner.id)) { return []; }
  seen.add(owner.id);
  const result: FunctionInfo[] = [];
  for (const name of owner.baseNames ?? (owner.baseName ? [owner.baseName] : [])) {
    const base = lookupClass(ctx,name,owner.scope);
    if (!base) { continue; }
    const direct = base.methods.get(derived.name)?.filter(candidate => sameFunctionSignature(derived,candidate)) ?? [];
    if (direct.length) { result.push(...direct); }
    else { result.push(...overriddenBaseMethods(ctx,base,derived,seen)); }
  }
  return result;
}

function isVirtualMethod(ctx: TypeContext, fn: FunctionInfo, seen: Set<FunctionInfo>): boolean {
  if (fn.virtual) { return true; }
  if (seen.has(fn) || !fn.owner?.baseName) { return false; }
  seen.add(fn);
  return overriddenBaseMethods(ctx,fn.owner,fn,new Set()).some(candidate=>isVirtualMethod(ctx,candidate,seen));
}

function declarationsForFunction(input: TypeDiagnosticsInput, ctx: TypeContext,
  fn: FunctionInfo): AnalysisDeclaration[] {
  const documents = originalDocuments(input);
  const document = documents.find(candidate => candidate.uri === fn.uri);
  if (!document) { return []; }
  const semanticDocument = ctx.documents.find(candidate => candidate.uri === fn.uri);
  const expandedIds = semanticDocument?.declarations.filter(declaration => declaration.kind === 'function'
    && contains(fn.declarator.range,declaration.selectionRange.start)).map(declaration => declaration.id) ?? [];
  const originalById = document.declarations.filter(declaration => expandedIds.includes(declaration.id));
  if (originalById.length) { return originalById; }
  const range = sourceRange(document,fn.declarator.range,semanticDocument);
  return document.declarations.filter(declaration => declaration.kind === 'function'
    && contains(range,declaration.selectionRange.start));
}

function originalDocuments(input: TypeDiagnosticsInput) {
  return [...new Map([input.analysis,...input.documents ?? [],...input.loginScope?.documents ?? []]
    .map(document => [document.uri,document])).values()];
}

function sourceRange(original: TypeDiagnosticsInput['analysis'], range: AnalysisRange,
  semantic: TypeDiagnosticsInput['analysis'] | undefined, reference = false): AnalysisRange {
  const expanded = original.expandedSource;
  return expanded && expanded.analysis === semantic
    ? (reference && expanded.referenceRange ? expanded.referenceRange : expanded.sourceRange)(range) : range;
}

function contains(range: AnalysisRange, position: AnalysisRange['start']): boolean {
  return (range.start.line < position.line || range.start.line === position.line && range.start.character <= position.character)
    && (position.line < range.end.line || position.line === range.end.line && position.character <= range.end.character);
}

function uniqueDeclarations(declarations: AnalysisDeclaration[]): AnalysisDeclaration[] {
  return [...new Map(declarations.map(declaration => [declaration.id,declaration])).values()];
}

function rangeKey(range: AnalysisRange): string {
  return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

function compareRanges(left: AnalysisRange, right: AnalysisRange): number {
  return left.start.line-right.start.line || left.start.character-right.start.character
    || left.end.line-right.end.line || left.end.character-right.end.character;
}
