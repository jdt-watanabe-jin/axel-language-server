import { createHash } from 'crypto';
import { resolveType } from '../typeChecking/declarations';
import type { ClassInfo, Scope } from '../typeChecking/model';
import { field, type TypeNode } from '../typeChecking/syntax';
import type { TypeDiagnosticsInput } from '../typeChecking/diagnostics';
import { canonicalClass, createTypeTargetContext, declarationName, sourceTypeRange, typeNodeExcluded,
  uniqueClassReference, type TypeTargetContext } from '../typeTarget';
import { canonicalPath, fileIdentity, filePath } from '../projectScope';
import type { TypeHierarchyRecord } from './model';

function scopePath(scope: Scope | undefined, structural = false): string[] {
  if (!scope?.parent) { return []; }
  const named = field(scope.node, 'name') ?? declarationName(field(scope.node, 'declarator'));
  const identity = structural && scope.node.kind === 'function_definition'
    ? field(scope.node, 'declarator')?.text.replace(/\s+/g, ' ').trim() ?? named?.text ?? scope.node.kind
    : named?.text ?? `${scope.node.kind}:${scope.parent.node.children.indexOf(scope.node)}`;
  return [...scopePath(scope.parent, structural), identity];
}

export function classKey(info: ClassInfo): string {
  const file = filePath(info.uri);
  return JSON.stringify([file ? fileIdentity(canonicalPath(file)) : info.uri, scopePath(info.scope.parent, true), info.name, info.node.kind]);
}

function shape(node: TypeNode): string {
  if (node.kind === 'comment') { return ''; }
  return node.children.length ? `${node.kind}(${node.children.map(shape).join(',')})` : `${node.kind}:${node.text}`;
}

export function classRecord(context: TypeTargetContext, original: ClassInfo): TypeHierarchyRecord | undefined {
  const info = canonicalClass(context.types, original);
  if (!info) { return undefined; }
  const name = field(info.node, 'name');
  if (!name || typeNodeExcluded(context, info.uri, name.range)) { return undefined; }
  const declarations = [...context.types.nodeScopes].filter(([node, scope]) => node.kind === info.node.kind
    && scope === info.scope.parent && field(node, 'name')?.text === info.name && field(node, 'body'));
  if (declarations.length > 1) { return undefined; }
  const selectionRange = sourceTypeRange(context, info.uri, name.range);
  const document = context.documents.find(document => document.uri === info.uri);
  // Only names with a physical declaration survive macro mapping.
  const visible = document?.declarations.filter(declaration => ['class', 'struct', 'union'].includes(declaration.kind)
    && declaration.name === info.name && declaration.selectionRange.start.line === selectionRange.start.line
    && declaration.selectionRange.start.character === selectionRange.start.character);
  if (!visible?.length || visible.some(declaration => declaration.name !== info.name)) { return undefined; }
  const kind = info.node.kind === 'struct_specifier' ? 'struct' : info.node.kind === 'union_specifier' ? 'union' : 'class';
  return { key: classKey(info), shape: createHash('sha256').update(shape(info.node)).digest('hex'), name: info.name,
    qualifiedName: [...scopePath(info.scope.parent), info.name].join('::'), kind, uri: info.uri,
    range: sourceTypeRange(context, info.uri, info.node.range), selectionRange, bases: [], defined: info.defined };
}

/** Only compact declarations and edges escape; type contexts remain generation-local. */
export function collectTypeHierarchy(input: TypeDiagnosticsInput, supplied?: TypeTargetContext): TypeHierarchyRecord[] {
  const context = supplied ?? createTypeTargetContext(input);
  if (!context) { return []; }
  const records = new Map<string, TypeHierarchyRecord>();
  const classes = new Map<string, ClassInfo>();
  for (const original of context.types.classes) {
    const info = canonicalClass(context.types, original);
    const record = info && classRecord(context, info);
    if (record && info) { records.set(record.key, record); classes.set(record.key, info); }
  }
  for (const record of records.values()) {
    const info = classes.get(record.key)!;
    const clause = info.node.children.find(node => node.kind === 'base_class_clause');
    for (const node of clause?.children ?? []) {
      if (node.kind === 'access_specifier' || typeNodeExcluded(context, info.uri, node.range)) { continue; }
      if (resolveType(context.types, node, info.scope.parent ?? info.scope).kind !== 'class') { continue; }
      const base = uniqueClassReference(context.types, node, info.scope.parent ?? info.scope);
      const key = base && classKey(base);
      if (key && key !== record.key && records.has(key) && !record.bases.includes(key)) { record.bases.push(key); }
    }
  }
  // Two macro-generated declarations mapping to the same written name cannot be selected unambiguously.
  const byPosition = new Map<string, TypeHierarchyRecord[]>();
  for (const record of records.values()) {
    const key = `${record.uri}:${record.selectionRange.start.line}:${record.selectionRange.start.character}`;
    const group = byPosition.get(key) ?? []; group.push(record); byPosition.set(key, group);
  }
  for (const group of byPosition.values()) { if (group.length > 1) { for (const record of group) { records.delete(record.key); } } }
  for (const record of records.values()) { record.bases = record.bases.filter(key => records.has(key)); }
  return [...records.values()];
}
