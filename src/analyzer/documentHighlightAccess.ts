import type { AnalysisDeclaration, AnalysisRange } from '../types/analysis';
import { evaluateExpression } from './typeChecking/expressions';
import { scopeFor } from './typeChecking/declarations';
import { dereference, type TypeContext } from './typeChecking/model';
import { field, type TypeNode } from './typeChecking/syntax';

export type HighlightKind = 'text' | 'read' | 'write';
export const rangeKey = (r: AnalysisRange): string => `${r.start.line}:${r.start.character}:${r.end.line}:${r.end.character}`;

export function highlightKind(node: TypeNode | undefined, declaration: AnalysisDeclaration, isDeclaration: boolean,
  parents: Map<TypeNode, TypeNode>, ctx: TypeContext): HighlightKind {
  if (!['variable','field','parameter','enumMember'].includes(declaration.kind)) { return 'text'; }
  if (!node) { return 'text'; }
  for (let ancestor: TypeNode | undefined = node; ancestor; ancestor = parents.get(ancestor)) {
    if (ancestor.kind === 'sizeof_expression') { return 'text'; }
  }
  if (isDeclaration) {
    if (declaration.kind === 'parameter' || declaration.kind === 'enumMember') { return 'text'; }
    for (let ancestor: TypeNode | undefined = node; ancestor; ancestor = parents.get(ancestor)) {
      if (ancestor.kind === 'init_declarator') { return 'write'; }
      if (['object_definition','field_declaration','parameter_declaration','function_definition'].includes(ancestor.kind)) { break; }
    }
    return 'text';
  }
  let expression = node;
  let parent = parents.get(expression);
  // The name of a field represents the member expression, not its receiver.
  if (parent && ((parent.kind === 'field_expression' && field(parent,'field') === expression)
    || (parent.kind === 'qualified_identifier' && field(parent,'name') === expression))) {
    expression = parent; parent = parents.get(expression);
  }
  let arrayAccess: 'array' | 'pointer' | 'unknown' | undefined;
  while (parent) {
    if (parent.kind === 'parenthesized_expression') {
      expression = parent;
    } else if (parent.kind === 'subscript_expression' && field(parent,'argument') === expression) {
      const type = dereference(evaluateExpression(ctx,expression,scopeFor(ctx,expression)).type);
      if (type.kind === 'pointer') { arrayAccess = 'pointer'; }
      else if (type.kind !== 'array') { arrayAccess = 'unknown'; }
      else { arrayAccess ??= 'array'; }
      expression = parent;
    } else { break; }
    parent = parents.get(expression);
  }
  const written = parent && (parent.kind === 'assignment_expression' && field(parent,'left') === expression
    || parent.kind === 'update_expression' && field(parent,'argument') === expression);
  if (!written || arrayAccess === 'pointer') { return 'read'; }
  return arrayAccess === 'unknown' ? 'text' : 'write';
}
