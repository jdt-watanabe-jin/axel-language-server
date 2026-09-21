import type { AnalysisDeclaration, AnalysisPosition } from '../../types/analysis';
import { contains } from '../resolution';
import { isBuiltinDeclarationSource } from './builtinCatalog';
import { createTypeCheckingContext, type TypeDiagnosticsInput } from './diagnostics';
import { sameFunctionSignature } from './model';
import { scopeFor } from './declarations';
import { compatibleOverloads, evaluateExpression } from './expressions';
import { callArguments, descendants, field, type TypeNode } from './syntax';

/** Builtin calls share diagnostic compatibility; ordinary AXEL functions retain arity identity. */
export function createCallResolver(input: TypeDiagnosticsInput): (position: AnalysisPosition, allowPartialArguments?: boolean) => AnalysisDeclaration[] | undefined {
  const ctx = createTypeCheckingContext(input);
  const calls = descendants(ctx.analysis.typeSnapshot!.root, 'call_expression');
  const key = (position: AnalysisPosition) => position.line + ':' + position.character;
  const nameOf = (call: TypeNode) => {
    const callee = field(call,'function');
    return callee && (field(callee,'field') ?? (callee.kind === 'qualified_identifier' ? callee.children.at(-1) : callee));
  };
  const callStarts = new Map<string,TypeNode>();
  for (const call of calls) {
    const name = nameOf(call);
    if (name && !callStarts.has(key(name.range.start))) { callStarts.set(key(name.range.start),call); }
  }
  const documents = [input.analysis, ...input.documents ?? [], ...input.loginScope?.documents ?? []];
  const cached = new Map<TypeNode, AnalysisDeclaration[] | undefined>();
  const partialCache = new Map<TypeNode, AnalysisDeclaration[] | undefined>();
  return (position, allowPartialArguments = false) => {
    const results = allowPartialArguments ? partialCache : cached;
    const expandedPosition = input.analysis.expandedSource?.expandedPosition(position) ?? position;
    const call = callStarts.get(key(expandedPosition)) ?? calls.find(call => {
      const callee = field(call, 'function');
      if (!callee) { return false; }
      const name = field(callee, 'field') ?? (callee.kind === 'qualified_identifier' ? callee.children.at(-1) : callee);
      return !!name && contains(name.range, expandedPosition);
    });
    if (!call) { return undefined; }
    if (results.has(call)) { return results.get(call); }
    const scope = scopeFor(ctx, call);
    const functionNode = field(call, 'function')!;
    const callee = evaluateExpression(ctx, functionNode, scope);
    const candidates = callee.type.candidates ?? (callee.type.call ? [callee.type.call] : []);
    const builtin = candidates.every(fn => isBuiltinDeclarationSource(ctx.catalog, fn.uri));
    // Member calls use the inferred receiver type, including typedefs and expression receivers.
    // Ordinary AXEL call identity remains arity-based.
    if (!candidates.length || (!builtin && !allowPartialArguments && functionNode.kind !== 'field_expression')) {
      results.set(call, undefined); return undefined;
    }
    const values = callArguments(call).filter(arg => !(allowPartialArguments && arg.kind === 'ERROR' && arg.text === ',')).map(arg => evaluateExpression(ctx, arg, scope));
    const {viable, uncertain} = builtin
      ? compatibleOverloads(ctx, candidates, values, 'argument', allowPartialArguments)
      : {viable: candidates.filter(fn => (allowPartialArguments || values.length >= fn.required)
        && (fn.variadic || values.length <= fn.parameters.length)), uncertain: []};
    const remaining = new Set([...viable, ...uncertain]);
    const matching = candidates.filter(fn => remaining.has(fn));
    // A method prototype and its body denote one target; preserve Definition/References identity.
    const preferred = matching.filter(fn => fn.node.kind === 'function_definition' || !matching.some(other =>
      other.node.kind === 'function_definition' && other.owner === fn.owner && other.instancePath === fn.instancePath
      && other.variadic === fn.variadic && sameFunctionSignature(other, fn)));
    const declarations = preferred.flatMap(fn => {
      const document = documents.find(document => document.uri === fn.uri);
      const range = document?.expandedSource?.sourceRange(fn.node.range) ?? fn.node.range;
      return document?.declarations.filter(declaration => declaration.kind === 'function'
        && declaration.name === fn.name && contains(range, declaration.selectionRange.start)) ?? [];
    });
    const result = [...new Map(declarations.map(declaration => [declaration.id, declaration])).values()];
    results.set(call, result);
    return result;
  };
}
