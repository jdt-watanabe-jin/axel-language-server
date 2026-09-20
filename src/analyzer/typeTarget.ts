import type { AnalysisDeclaration, AnalysisPosition, AnalysisRange, AnalyzedDocument } from '../types/analysis';
import { findNavigationTargetDeclaration, type NavigationInput, type WorkspaceNavigationIndex } from './navigation';
import { contains, comparePositions } from './resolution';
import { createTypeCheckingContext, type TypeDiagnosticsInput } from './typeChecking/diagnostics';
import { resolveType, scopeFor } from './typeChecking/declarations';
import type { ClassInfo, Scope, Type, TypeContext } from './typeChecking/model';
import { field, type TypeNode } from './typeChecking/syntax';

export interface TypeTargetWorkspace extends WorkspaceNavigationIndex {
  callHierarchyTypeInput?(analysis: AnalyzedDocument): TypeDiagnosticsInput;
}
export interface TypeTargetContext {
  input: TypeDiagnosticsInput;
  types: TypeContext;
  documents: readonly AnalyzedDocument[];
}
export interface ResolvedTypeTarget {
  declaration: AnalysisDeclaration;
  type: Type;
  aliases: AnalysisDeclaration[];
  classInfo?: ClassInfo;
}

export function typeTargetInput(analysis: AnalyzedDocument, workspace: TypeTargetWorkspace): TypeDiagnosticsInput {
  return workspace.callHierarchyTypeInput?.(analysis)
    ?? { analysis, documents: workspace.listVisibleDocuments?.(analysis.uri) ?? [analysis] };
}

export function createTypeTargetContext(input: TypeDiagnosticsInput): TypeTargetContext | undefined {
  if (!input.analysis.typeSnapshot) { return undefined; }
  return { input, types: createTypeCheckingContext(input),
    documents: [...new Map([input.analysis, ...input.documents ?? [], ...input.loginScope?.documents ?? []]
      .map(document => [document.uri, document])).values()] };
}

/** Retains the original shape for type-definition consumers; hierarchy uses only classInfo. */
export function underlyingClass(type: Type): ClassInfo | undefined {
  const visited = new Set<Type>();
  while (['pointer', 'reference', 'array'].includes(type.kind)) {
    if (visited.has(type) || !type.element) { return undefined; }
    visited.add(type); type = type.element;
  }
  return type.kind === 'class' ? type.classInfo : undefined;
}

/** Existing type resolution supplies the meaning; this guard rejects ambiguous global choices. */
export function uniqueClassReference(ctx: TypeContext, node: TypeNode, scope: Scope): ClassInfo | undefined {
  const resolved = underlyingClass(resolveType(ctx, node, scope));
  if (!resolved) { return undefined; }
  const name = node.text.trim();
  // An alias resolves in the alias declaration's scope, not in the caller's scope.
  if (name !== resolved.name) {
    const aliases = aliasDeclarations(ctx, name, scope);
    if (aliases.length > 1) { return undefined; }
    if (aliases.length === 1) {
      const alias = aliases[0];
      const type = field(alias.node, 'type');
      if (type && type.text.trim() !== name) {
        return uniqueClassReferenceGuarded(ctx, type, alias.scope, new Set([alias.node]));
      }
    }
    return canonicalClass(ctx, resolved);
  }
  return uniqueNamedClass(ctx, name, scope);
}

function uniqueClassReferenceGuarded(ctx: TypeContext, node: TypeNode, scope: Scope, seen: Set<TypeNode>): ClassInfo | undefined {
  if (seen.has(node)) { return undefined; }
  seen.add(node);
  const aliases = aliasDeclarations(ctx, node.text.trim(), scope);
  if (aliases.length > 1) { return undefined; }
  if (aliases.length === 1) {
    const type = field(aliases[0].node, 'type');
    return type ? uniqueClassReferenceGuarded(ctx, type, aliases[0].scope, seen) : undefined;
  }
  return uniqueNamedClass(ctx, node.text.trim(), scope);
}

function aliasDeclarations(ctx: TypeContext, name: string, scope: Scope): { node: TypeNode; scope: Scope }[] {
  const declarations = [...ctx.nodeScopes].filter(([node]) => node.kind === 'type_definition'
    && (node.fields.declarator ?? []).some(declarator => declarationName(declarator)?.text === name))
    .map(([node, owner]) => ({ node, scope: owner }));
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const local = declarations.filter(item => item.scope === current);
    if (local.length) { return local; }
  }
  return declarations.filter(item => !item.scope.parent);
}

function selectClass(ctx: TypeContext, candidates: ClassInfo[]): ClassInfo | undefined {
  const definitions = candidates.filter(info => info.defined);
  if (definitions.length === 1) { return definitions[0]; }
  if (definitions.length > 1) { return undefined; }
  return candidates.length === 1 ? canonicalClass(ctx, candidates[0]) : undefined;
}

function aliasChain(context: TypeTargetContext, node: TypeNode | undefined, scope: Scope): AnalysisDeclaration[] {
  const result: AnalysisDeclaration[] = [];
  const seen = new Set<TypeNode>();
  while (node) {
    const aliases = aliasDeclarations(context.types, node.text.trim(), scope);
    if (aliases.length !== 1 || seen.has(aliases[0].node)) { break; }
    const alias = aliases[0];
    seen.add(alias.node);
    const name = (alias.node.fields.declarator ?? []).map(declarationName)
      .find(candidate => candidate?.text === node!.text.trim());
    if (!name) { break; }
    const position = sourceTypeRange(context, alias.scope.uri, name.range).start;
    const declaration = context.documents.find(document => document.uri === alias.scope.uri)?.declarations
      .find(candidate => candidate.kind === 'typedef' && candidate.name === name.text
        && samePosition(candidate.selectionRange.start, position));
    if (!declaration) { break; }
    result.push(declaration);
    node = field(alias.node, 'type');
    scope = alias.scope;
  }
  return result;
}

export function canonicalClass(ctx: TypeContext, info: ClassInfo): ClassInfo | undefined {
  if (info.defined || info.scope.parent?.parent) { return info; }
  const definitions = ctx.classes.filter(candidate => candidate.name === info.name
    && !candidate.scope.parent?.parent && candidate.defined && !candidate.role);
  return definitions.length === 1 ? definitions[0] : definitions.length > 1 ? undefined : info;
}

function uniqueNamedClass(ctx: TypeContext, name: string, scope: Scope): ClassInfo | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const local = ctx.classes.filter(info => info.name === name && info.scope.parent === current);
    if (local.length) { return selectClass(ctx, local); }
    if (current.owner?.name === name) { return canonicalClass(ctx, current.owner); }
  }
  const globals = ctx.classes.filter(info => info.name === name && !info.scope.parent?.parent);
  const priorities = [globals.filter(info => info.uri === scope.uri && !info.role),
    globals.filter(info => !info.role && ctx.scopes.includes(info.scope)), globals.filter(info => !info.role), globals];
  return selectClass(ctx, priorities.find(candidates => candidates.length) ?? []);
}

export function sourceTypeRange(context: TypeTargetContext, uri: string, range: AnalysisRange): AnalysisRange {
  return context.documents.find(document => document.uri === uri)?.expandedSource?.sourceRange(range) ?? range;
}

export function typeNodeExcluded(context: TypeTargetContext, uri: string, range: AnalysisRange): boolean {
  const document = context.documents.find(document => document.uri === uri);
  if (!document) { return true; }
  const mapped = sourceTypeRange(context, uri, range);
  return [...document.inactiveRanges ?? [], ...document.uncertainRanges ?? [],
    ...document.syntaxRecovery?.ranges ?? []].some(excluded => contains(excluded, mapped.start));
}

export function declarationName(node: TypeNode | undefined): TypeNode | undefined {
  if (!node) { return undefined; }
  if (['identifier', 'field_identifier', 'class_name'].includes(node.kind)) { return node; }
  return declarationName(field(node, 'declarator') ?? field(node, 'name')
    ?? (node.kind.includes('parenthesized') ? node.children[0] : undefined));
}

function samePosition(a: AnalysisPosition, b: AnalysisPosition): boolean { return comparePositions(a, b) === 0; }

/** Shared position -> declaration -> static type. Does not run whole-body diagnostics. */
export function resolveTypeTarget(input: NavigationInput, supplied?: TypeTargetContext): ResolvedTypeTarget | undefined {
  const context = supplied ?? createTypeTargetContext(typeTargetInput(input.analysis, input.workspaceIndex));
  if (!context || [...input.analysis.inactiveRanges ?? [], ...input.analysis.uncertainRanges ?? [],
    ...input.analysis.completionExcludedRanges ?? [], ...input.analysis.syntaxRecovery?.ranges ?? []]
    .some(range => contains(range, input.position))) { return undefined; }
  const declaration = findNavigationTargetDeclaration(input);
  if (!declaration || !['class', 'struct', 'union', 'typedef', 'variable', 'parameter', 'field'].includes(declaration.kind)) {
    return undefined;
  }
  const { types: ctx } = context;
  const matches = (uri: string, node: TypeNode) => uri === declaration.uri
    && samePosition(sourceTypeRange(context, uri, node.range).start, declaration.selectionRange.start);
  if (['class', 'struct', 'union', 'typedef'].includes(declaration.kind)
    && !(declaration.uri === input.analysis.uri && contains(declaration.selectionRange, input.position))) {
    const position = input.analysis.expandedSource?.expandedPosition(input.position) ?? input.position;
    const root = ctx.analysis.typeSnapshot?.root;
    const pending = root ? [root] : [];
    let selected: TypeNode | undefined;
    while (pending.length) {
      const node = pending.pop()!;
      if (!contains(node.range, position)) { continue; }
      if (['class_name', 'identifier', 'qualified_identifier'].includes(node.kind)) { selected = node; }
      pending.push(...node.children);
    }
    if (!selected) { return undefined; }
    const scope = scopeFor(ctx, selected);
    const classInfo = uniqueClassReference(ctx, selected, scope);
    return classInfo ? { declaration, type: resolveType(ctx, selected, scope),
      aliases: aliasChain(context, selected, scope), classInfo } : undefined;
  }
  if (['class', 'struct', 'union'].includes(declaration.kind)) {
    let info = ctx.classes.find(candidate => {
      const name = field(candidate.node, 'name');
      return name && matches(candidate.uri, name);
    });
    if (!info) {
      // A forward declaration may have been replaced by its definition within the same scope.
      const nodes = [...ctx.nodeScopes].filter(([node, scope]) => field(node, 'name')
        && matches(scope.uri, field(node, 'name')!));
      if (nodes.length === 1) { info = uniqueClassReference(ctx, field(nodes[0][0], 'name')!, nodes[0][1]); }
    }
    info = info && canonicalClass(ctx, info);
    if (!info) { return undefined; }
    return { declaration, aliases: [], type: { kind: 'class', name: info.name, classInfo: info }, classInfo: info };
  }
  if (declaration.kind === 'typedef') {
    for (const [node, scope] of ctx.nodeScopes) {
      if (node.kind !== 'type_definition') { continue; }
      const name = (node.fields.declarator ?? []).map(declarationName).find(name => name && matches(scope.uri, name));
      if (!name) { continue; }
      const type = resolveType(ctx, name, scope);
      return { declaration, aliases: aliasChain(context, name, scope), type, classInfo: uniqueClassReference(ctx, name, scope) };
    }
    return undefined;
  }
  const bindings = ctx.bindings.filter(binding => binding.name === declaration.name && binding.uri === declaration.uri
    && (binding.node.fields.declarator ?? []).some(declarator => {
      const name = declarationName(declarator); return name && matches(binding.uri, name);
    }));
  if (bindings.length === 1) {
    const binding = bindings[0];
    const typeNode = field(binding.node, 'type');
    const rawClass = underlyingClass(binding.type);
    const info = rawClass && typeNode ? uniqueClassReference(ctx, typeNode, binding.scope) : rawClass;
    return { declaration, type: binding.type, aliases: aliasChain(context, typeNode, binding.scope), classInfo: info && canonicalClass(ctx, info) };
  }
  // GUI parts are declared by GUI syntax, rather than ordinary variable declarators.
  if (declaration.typeName && ['field', 'variable'].includes(declaration.kind)) {
    const root = ctx.documents.find(document => document.uri === declaration.uri)?.typeSnapshot?.root;
    const pending = root ? [root] : [];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.kind === 'gins_definition' && field(node, 'name') && matches(declaration.uri, field(node, 'name')!)) {
        const typeNode = field(node, 'type');
        if (!typeNode) { return undefined; }
        const scope = scopeFor(ctx, node);
        const type = resolveType(ctx, typeNode, scope);
        return { declaration, type, aliases: aliasChain(context, typeNode, scope), classInfo: uniqueClassReference(ctx, typeNode, scope) };
      }
      pending.push(...node.children);
    }
  }
  return undefined;
}
