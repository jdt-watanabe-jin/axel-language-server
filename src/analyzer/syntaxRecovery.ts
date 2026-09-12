import type * as Parser from 'tree-sitter';
import type { AnalysisDiagnostic, AnalysisRange, AnalysisReference, AnalyzedDocument } from '../types/analysis';
import { comparePositions, findLocalDeclaration, findDeclarationMember, receiverTypeName, isTypeDeclaration } from './resolution';
import { nodeToAnalysisRange } from './syntaxTree';

export interface SyntaxRecovery {
  ranges: AnalysisRange[];
  dependentReferences: AnalysisRange[];
}

const declarations = new Set(['object_definition', 'field_declaration', 'type_definition',
  'class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier', 'function_definition']);
const scopes = new Set(['translation_unit', 'compound_statement', 'field_declaration_list']);

function isSyntaxDiagnostic(diagnostic: AnalysisDiagnostic): boolean {
  return diagnostic.severity === 'error'
    && (diagnostic.message === 'Syntax error.' || diagnostic.message.startsWith('Missing '));
}

function contains(outer: AnalysisRange, inner: AnalysisRange): boolean {
  return comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
}
function overlaps(a: AnalysisRange, b: AnalysisRange): boolean {
  return comparePositions(a.start, b.end) < 0 && comparePositions(b.start, a.end) < 0
    || contains(a, b) || contains(b, a);
}

/** Keep recovery uncertainty separate from inactive/conditional source. No native nodes escape. */
export function collectSyntaxRecovery(root: Parser.SyntaxNode, analysis: AnalyzedDocument,
  excluded: readonly AnalysisRange[]): SyntaxRecovery {
  if (!root.hasError) { return {ranges: [], dependentReferences: []}; }
  const ranges: AnalysisRange[] = [];
  const uncertain: {id: string; name: string; scope: AnalysisRange}[] = [];
  const syntaxErrors = analysis.diagnostics.filter(isSyntaxDiagnostic);
  const scopeOf = (node: Parser.SyntaxNode): AnalysisRange => {
    let current = node.parent;
    while (current && !scopes.has(current.type)) { current = current.parent; }
    return nodeToAnalysisRange(current ?? root);
  };
  function visit(node: Parser.SyntaxNode): void {
    if (!node.hasError && !node.isMissing) { return; }
    const range = nodeToAnalysisRange(node);
    if (excluded.some(item => contains(item, range))) { return; }
    if ((node.type === 'ERROR' && syntaxErrors.some(d => contains(range, d.range))) || node.isMissing) {
      let boundary = node.parent ?? node;
      while (boundary.parent && !scopes.has(boundary.type) && !declarations.has(boundary.type)
        && !boundary.type.endsWith('_statement')) { boundary = boundary.parent; }
      // Missing scope delimiters invalidate the containing scope, not just the insertion point.
      if (node.isMissing && ['{', '}'].includes(node.type)) {
        while (boundary.parent && !scopes.has(boundary.type)) { boundary = boundary.parent; }
      }
      if (boundary.type === 'field_declaration_list' && boundary.parent) { boundary = boundary.parent; }
      ranges.push(nodeToAnalysisRange(boundary));
      if (declarations.has(boundary.type)) {
        const affected = analysis.declarations.filter(d => contains(nodeToAnalysisRange(boundary), d.selectionRange));
        if (affected.length === 0) {
          // Recovery lost the declaration name: any lookup in this scope may depend on it.
          ranges.push(scopeOf(boundary));
        } else {
          for (const declaration of affected) {
            const scope = analysis.scopes.find(s => s.declarationIds.includes(declaration.id));
            uncertain.push({id: declaration.id, name: declaration.name, scope: scope?.range ?? scopeOf(boundary)});
          }
        }
      }
      return;
    }
    for (const child of node.children) { visit(child); }
  }
  visit(root);
  const depends = (name: string | undefined, range: AnalysisRange, type = false): boolean => {
    if (name === undefined || !uncertain.some(item => item.name === name && contains(item.scope, range))) { return false; }
    const resolved = type ? undefined : findLocalDeclaration(analysis, name, range.start);
    return resolved === undefined || uncertain.some(item => item.id === resolved.id);
  };
  // Propagate uncertain types to bindings so dependent member lookups are also deferred.
  const returnTypes = new Map(analysis.declarations.filter(d => d.signature).map(d => {
    const node = root.namedDescendantForPosition({row: d.range.start.line, column: d.range.start.character},
      {row: d.range.end.line, column: d.range.end.character});
    return [d.id, node.childForFieldName('type')?.text];
  }));
  const pending = new Set(analysis.declarations);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of pending) {
      if (!depends(declaration.typeName ?? returnTypes.get(declaration.id), declaration.selectionRange, true)
        && !depends(declaration.baseName, declaration.selectionRange, true)) { continue; }
      pending.delete(declaration);
      const scope = analysis.scopes.find(s => s.declarationIds.includes(declaration.id));
      uncertain.push({id: declaration.id, name: declaration.name, scope: scope?.range ?? nodeToAnalysisRange(root)});
      changed = true;
    }
  }
  const uncertainIds = new Set(uncertain.map(item => item.id));
  const uncertainTypes = new Set(analysis.declarations.filter(d => uncertainIds.has(d.id) && isTypeDeclaration(d)).map(d => d.name));
  function referenceDepends(ref: AnalysisReference): boolean {
    if (!ref.memberAccess) { return depends(ref.name, ref.range, ref.typeReference); }
    if (depends(ref.memberAccess.receiverName, ref.range)) { return true; }
    if (uncertainTypes.size === 0) { return false; }
    const input = {analysis, position: ref.range.start, workspaceIndex: {}};
    let typeName = receiverTypeName(input, ref.memberAccess.receiverName);
    for (const name of ref.memberAccess.memberNames) {
      if (!typeName) { return false; }
      if (uncertainTypes.has(typeName)) { return true; }
      const member = findDeclarationMember(input, typeName, name);
      if (member && uncertainIds.has(member.id)) { return true; }
      typeName = member?.typeName;
    }
    return typeName !== undefined && uncertainTypes.has(typeName);
  }
  return {ranges, dependentReferences: analysis.references.filter(referenceDepends).map(ref => {
    let node = root.namedDescendantForPosition({row: ref.range.start.line, column: ref.range.start.character},
      {row: ref.range.end.line, column: ref.range.end.character});
    // A recovered value taints enclosing calls/member chains and operators that consume it.
    while (node.parent?.type.endsWith('_expression')) { node = node.parent; }
    return nodeToAnalysisRange(node);
  })};
}

export function affectedBySyntaxRecovery(recovery: SyntaxRecovery | undefined, range: AnalysisRange): boolean {
  return recovery !== undefined && (recovery.ranges.some(item => overlaps(item, range))
    || recovery.dependentReferences.some(item => overlaps(item, range)));
}
