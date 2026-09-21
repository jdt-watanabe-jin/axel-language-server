import { isTypedVariadicParameter } from '../syntaxTree';
import type * as Parser from 'tree-sitter';
import type { AnalysisRange } from '../../types/analysis';

/** Immutable, document-generation-local syntax. No native tree escapes the parser. */
export interface TypeNode {
  /** Direct punctuation retained separately so expression children keep their semantic meaning. */
  argumentDelimiters?: TypeNode[];
  missing?: boolean;
  variadic?: boolean;
  kind: string;
  text: string;
  start: number;
  end: number;
  range: AnalysisRange;
  children: TypeNode[];
  fields: Record<string, TypeNode[]>;
}
export interface TypeSnapshot { uri: string; root: TypeNode }
export function buildTypeSnapshot(root: Parser.SyntaxNode, uri: string, replacements: readonly TypeNode[] = []): TypeSnapshot {
  const source = root.text;
  const sourceStart = root.startIndex;
  function copy(node: Parser.SyntaxNode): TypeNode {
    const start = node.startIndex, end = node.endIndex;
    const replacement = replacements.find(item => item.start === start && item.end >= end);
    if (replacement) { return replacement; }
    const children: TypeNode[] = [];
    const fields: Record<string, TypeNode[]> = {};
    const argumentDelimiters: TypeNode[] = [];
    const sourceChildren = node.children;
    // The binding generates this metadata from the grammar's nodeTypeInfo.
    // Unknown/recovery node classes lack it: preserve native lookup for those.
    const fieldNames = (node as Parser.SyntaxNode & { fields?: readonly string[] }).fields;
    const fieldless = Array.isArray(fieldNames) && fieldNames.length === 0;
    for (let i = 0; i < sourceChildren.length; i++) {
      const child = sourceChildren[i];
      if (replacements.some(item => item.start < child.startIndex && child.endIndex <= item.end)) { continue; }
      const name = fieldless ? undefined : node.fieldNameForChild(i);
      if (node.type === 'argument_list' && ['(', ',', ')'].includes(child.type)) { argumentDelimiters.push(copy(child)); }
      // A trailing comma in an unfinished call is retained under a recovery node.
      if (node.type === 'argument_list' && child.type === 'ERROR' && child.text === ',') {
        argumentDelimiters.push(...child.children.filter(token => token.type === ',').map(copy));
      }
      if (!child.isNamed && !name) { continue; }
      const item = copy(child);
      if (child.isNamed) { children.push(item); }
      if (name) { (fields[name] ??= []).push(item); }
    }
    return {...(argumentDelimiters.length ? {argumentDelimiters} : {}), ...(node.isMissing ? {missing:true} : {}), ...(isTypedVariadicParameter(node) ? {variadic:true} : {}), kind: node.type, text: source.slice(start - sourceStart, end - sourceStart), start, end,
      range: {start:{line:node.startPosition.row, character:node.startPosition.column},
        end:{line:node.endPosition.row, character:node.endPosition.column}}, children, fields};
  }
  return {uri, root:copy(root)};
}
export function field(node: TypeNode, name: string): TypeNode | undefined { return node.fields[name]?.[0]; }
export function callArguments(node: TypeNode): TypeNode[] {
  return (field(node, 'arguments')?.children ?? []).filter(child => child.kind !== 'comment');
}
// Type snapshots are immutable and replaced on edits. Weak keys release old generations.
const descendantCache = new WeakMap<TypeNode, Map<string, TypeNode[]>>();
export function descendants(node: TypeNode, kind: string): TypeNode[] {
  let byKind = descendantCache.get(node);
  const cached = byKind?.get(kind);
  if (cached) { return cached; }
  const result: TypeNode[] = [];
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.kind === kind) { result.push(current); }
    const children = current.children;
    for (let i = children.length - 1; i >= 0; i--) { pending.push(children[i]); }
  }
  if (!byKind) { byKind = new Map(); descendantCache.set(node, byKind); }
  byKind.set(kind, result);
  return result;
}
