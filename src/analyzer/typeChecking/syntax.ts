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
  // One cursor streams native nodes directly into the immutable semantic tree.
  // No child wrapper arrays or parse-local property caches are needed by this pass.
  const cursor = root.walk();
  function copy(): TypeNode {
    const start = cursor.startIndex, end = cursor.endIndex;
    const replacement = replacements.find(item => item.start === start && item.end >= end);
    if (replacement) { return replacement; }
    const kind = cursor.nodeType;
    const missing = cursor.nodeIsMissing;
    const variadic = kind === 'parameter_declaration' && isTypedVariadicParameter(cursor.currentNode);
    const from = cursor.startPosition, to = cursor.endPosition;
    const children: TypeNode[] = [];
    const fields: Record<string, TypeNode[]> = {};
    const argumentDelimiters: TypeNode[] = [];
    if (cursor.gotoFirstChild()) {
      do {
        if (replacements.some(item => item.start < cursor.startIndex && cursor.endIndex <= item.end)) { continue; }
        const name = cursor.currentFieldName;
        const named = cursor.nodeIsNamed;
        if (kind === 'argument_list') {
          const childKind = cursor.nodeType;
          if (['(', ',', ')'].includes(childKind)) { argumentDelimiters.push(copy()); }
          // Retain the trailing comma inside an unfinished-call recovery node.
          if (childKind === 'ERROR' && source.slice(cursor.startIndex - sourceStart, cursor.endIndex - sourceStart) === ',') {
            if (cursor.gotoFirstChild()) {
              do { if (cursor.nodeType === ',') { argumentDelimiters.push(copy()); } } while (cursor.gotoNextSibling());
              cursor.gotoParent();
            }
          }
        }
        if (!named && !name) { continue; }
        const item = copy();
        if (named) { children.push(item); }
        if (name) { (fields[name] ??= []).push(item); }
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
    return {...(argumentDelimiters.length ? {argumentDelimiters} : {}), ...(missing ? {missing:true} : {}), ...(variadic ? {variadic:true} : {}),
      kind, text: source.slice(start - sourceStart, end - sourceStart), start, end,
      range: {start:{line:from.row, character:from.column}, end:{line:to.row, character:to.column}}, children, fields};
  }
  return {uri, root:copy()};
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
