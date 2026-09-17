import type { AnalysisDeclaration, AnalysisPosition } from '../../types/analysis';
import { contains } from '../resolution';
import { isBuiltinDeclarationSource } from './builtinCatalog';
import { createTypeCheckingContext, type TypeDiagnosticsInput } from './diagnostics';
import { scopeFor } from './declarations';
import { compatibleOverloads, evaluateExpression } from './expressions';
import { descendants, field, type TypeNode } from './syntax';

/** Builtin calls share diagnostic compatibility; ordinary AXEL functions retain arity identity. */
export function createCallResolver(input: TypeDiagnosticsInput): (position: AnalysisPosition, allowPartialArguments?: boolean) => AnalysisDeclaration[] | undefined {
  const ctx = createTypeCheckingContext(input);
  const calls = descendants(ctx.analysis.typeSnapshot!.root, 'call_expression');
  const documents = [input.analysis, ...input.documents ?? [], ...input.loginScope?.documents ?? []];
  const cached = new Map<TypeNode, AnalysisDeclaration[] | undefined>();
  const partialCache = new Map<TypeNode, AnalysisDeclaration[] | undefined>();
  return (position, allowPartialArguments = false) => {
    const results = allowPartialArguments ? partialCache : cached;
    const expandedPosition = input.analysis.expandedSource?.expandedPosition(position) ?? position;
    const call = calls.find(call => {
      const callee = field(call, 'function');
      if (!callee) { return false; }
      const name = field(callee, 'field') ?? (callee.kind === 'qualified_identifier' ? callee.children.at(-1) : callee);
      return !!name && contains(name.range, expandedPosition);
    });
    if (!call) { return undefined; }
    if (results.has(call)) { return results.get(call); }
    const scope = scopeFor(ctx, call);
    const callee = evaluateExpression(ctx, field(call, 'function')!, scope);
    const candidates = callee.type.candidates ?? (callee.type.call ? [callee.type.call] : []);
    // Restrict type-based selection to explicitly registered analysis declarations.
    if (!candidates.length || candidates.some(fn => !isBuiltinDeclarationSource(ctx.catalog, fn.uri))) {
      results.set(call, undefined); return undefined;
    }
    const values = (field(call, 'arguments')?.children ?? []).map(arg => evaluateExpression(ctx, arg, scope));
    const {viable, uncertain} = compatibleOverloads(ctx, candidates, values, 'argument', allowPartialArguments);
    const remaining = new Set([...viable, ...uncertain]);
    const declarations = candidates.filter(fn => remaining.has(fn)).flatMap(fn => {
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
