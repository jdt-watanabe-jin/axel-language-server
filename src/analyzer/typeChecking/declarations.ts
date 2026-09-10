import type { AnalyzedDocument } from '../../types/analysis';
import { builtinRole, type BuiltinCatalog } from './builtinCatalog';
import { basic, pointer, unknownType, numericNames, type Binding, type ClassInfo, type FunctionInfo, type Scope, type Type, type TypeContext } from './model';
import { field, type TypeNode, type TypeSnapshot } from './syntax';

const classKinds = new Set(['class_specifier', 'struct_specifier', 'union_specifier']);
const declarationKinds = new Set(['object_definition', 'field_declaration', 'type_definition', 'function_definition']);
const basics = new Set([...numericNames, 'void']);

export function scopeFor(ctx: TypeContext, node: TypeNode): Scope {
  return ctx.nodeScopes.get(node) ?? ctx.scopes.find(s => s.uri === ctx.analysis.uri && !s.parent) ?? ctx.scopes[0];
}

export function lookupClass(ctx: TypeContext, name: string, scope: Scope): ClassInfo | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const found = ctx.classes.find(c => c.name === name && c.scope.parent === current);
    if (found) { return found; }
    if (current.owner?.name === name) { return current.owner; }
  }
  const globals = ctx.classes.filter(c => c.name === name && !c.scope.parent?.parent);
  return globals.find(c => c.uri === scope.uri && !c.role) ?? globals.find(c => !c.role) ?? globals[0];
}

export function lookupBinding(ctx: TypeContext, name: string, scope: Scope, position = Infinity): Binding | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const candidates = current.bindings.filter(b => b.name === name && (b.node.start <= position || !!current!.owner || b.type.kind === 'function'));
    if (candidates.length) { return candidates[candidates.length - 1]; }
    const member = current.owner?.fields.get(name);
    if (member) { return member; }
  }
  return ctx.bindings.find(b => b.name === name && !b.scope.parent && b.uri !== scope.uri);
}

function aliasKey(scope: Scope, name: string): string { return `${scope.uri}#${scope.node.start}:${scope.node.end}#${name}`; }
function lookupAlias(ctx: TypeContext, name: string, scope: Scope): Type | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const alias = ctx.aliases.get(aliasKey(current, name));
    if (alias) { return alias; }
  }
  for (const root of ctx.scopes.filter(s => !s.parent && s.uri !== scope.uri)) {
    const alias = ctx.aliases.get(aliasKey(root, name));
    if (alias) { return alias; }
  }
  return undefined;
}

/** Resolve syntax types without inventing bindings for unresolved names. */
export function resolveType(ctx: TypeContext, node: TypeNode | undefined, scope: Scope): Type {
  if (!node) { return unknownType; }
  const typeNode = field(node, 'type');
  if (typeNode && !classKinds.has(node.kind)) {
    let type = resolveType(ctx, typeNode, scope);
    const modifier = field(node, 'class_modifier');
    if (modifier?.text.includes('unsigned') && basics.has(type.name)) { type = basic(`unsigned ${type.name}`); }
    const storage = field(node, 'storage_class_specifier') ?? field(node, 'storage_class');
    if (storage?.text.split(/\s+/).includes('const')) { type = { ...type, const: true }; }
    const declarator = field(node, 'declarator');
    return declarator ? shapeType(ctx, declarator, type, scope, node).type : type;
  }
  if (classKinds.has(node.kind)) {
    const info = ctx.classes.find(c => c.node === node) ?? lookupClass(ctx, field(node, 'name')?.text ?? '', scope);
    return info ? { kind: 'class', name: info.name, classInfo: info } : unknownType;
  }
  const name = node.text.trim().replace(/\s+/g, ' ');
  if (ctx.documents.find(d => d.uri === scope.uri)?.uncertainNames?.includes(name)) { return unknownType; }
  const alias = lookupAlias(ctx, name, scope);
  if (alias) { return alias; }
  const info = lookupClass(ctx, name, scope);
  if (info) { return { kind: 'class', name, classInfo: info }; }
  return basics.has(name) ? basic(name) : unknownType;
}

function nameOf(node: TypeNode | undefined): string | undefined {
  if (!node) { return undefined; }
  if (node.kind === 'operator_declarator') { return `operator${field(node, 'operator')?.text ?? node.text.slice(8).trim()}`; }
  if (node.kind === 'conversion_declarator') { return `convert:${field(node, 'type')?.text ?? ''}`; }
  if (node.kind === 'qualified_declarator') { return nameOf(field(node, 'name')); }
  if (node.kind === 'identifier' || node.kind === 'class_name') { return node.text; }
  return nameOf(field(node, 'declarator') ?? node.children.find(c => c.kind.endsWith('declarator')));
}

function findDeclarator(node: TypeNode | undefined, kind: string): TypeNode | undefined {
  if (!node) { return undefined; }
  return node.kind === kind ? node : findDeclarator(field(node, 'declarator') ?? field(node, 'name'), kind);
}

function shapeType(ctx: TypeContext, node: TypeNode, base: Type, scope: Scope, declaration: TypeNode): { type: Type; functions: FunctionInfo[] } {
  let type = base;
  const functions: FunctionInfo[] = [];
  if (node.kind.includes('pointer_declarator')) {
    type = node.text.trimStart().startsWith('&') ? { kind: 'reference', name: base.name + '&', element: base } : { ...pointer(base), const: base.const };
  } else if (node.kind.includes('array_declarator')) {
    type = { kind: 'array', name: base.name + '[]', element: base };
  } else if (node.kind.includes('function_declarator')) {
    const paramsNode = field(node, 'parameters');
    const paramNodes = paramsNode?.children.filter(c => c.kind === 'parameter_declaration') ?? [];
    let parameters = paramNodes.map(p => resolveType(ctx, p, scope));
    if (parameters.length === 1 && parameters[0].name === 'void' && !field(paramNodes[0], 'declarator')) { parameters = []; }
    const conversion = findDeclarator(field(node, 'declarator'), 'conversion_declarator');
    const result = conversion ? resolveType(ctx, field(conversion, 'type'), scope) : base;
    const fn: FunctionInfo = {
      name: nameOf(node) ?? '', node: declaration, uri: scope.uri, result, parameters,
      required: Math.min(parameters.length, paramNodes.filter(p => !findDeclarator(field(p, 'declarator'), 'init_declarator')).length),
      variadic: paramsNode?.text.includes('...') ?? false, owner: scope.owner, scope
    };
    functions.push(fn);
    type = { kind: 'function', name: fn.name, call: fn };
  }
  const child = field(node, 'declarator') ?? (node.kind.includes('parenthesized') ? node.children[0] : undefined);
  if (child) {
    const nested = shapeType(ctx, child, type, scope, declaration);
    return { type: nested.type, functions: [...functions, ...nested.functions] };
  }
  return { type, functions };
}

export function buildTypeContext(options: { analysis: AnalyzedDocument; documents?: readonly AnalyzedDocument[]; catalog: BuiltinCatalog }): TypeContext {
  const documents = [...new Map([...(options.documents ?? []), options.analysis].map(d => [d.uri, d])).values()];
  const ctx: TypeContext = {
    ...options, documents, classes: [], scopes: [], functions: [], bindings: [], aliases: new Map(),
    nodeScopes: new Map(), diagnostics: [], cache: new Map()
  };
  const roots: TypeNode[] = [];
  const excludedRanges = new Map(documents.map(d => [d.uri, [...(d.inactiveRanges ?? []), ...(d.uncertainRanges ?? [])]]));
  function excluded(node: TypeNode, uri: string): boolean {
    if (node.kind === 'translation_unit' || node.kind.startsWith('preproc_')) { return false; }
    const start = node.range.start;
    return (excludedRanges.get(uri) ?? []).some(range =>
      (start.line > range.start.line || start.line === range.start.line && start.character >= range.start.character)
      && (start.line < range.end.line || start.line === range.end.line && start.character < range.end.character));
  }
  function newScope(node: TypeNode, uri: string, parent?: Scope): Scope {
    const scope: Scope = { node, uri, parent, owner: parent?.owner, bindings: [] };
    ctx.scopes.push(scope);
    return scope;
  }
  function mapScopes(node: TypeNode, scope: Scope, reuse = false): void {
    if (excluded(node, scope.uri)) { return; }
    if (classKinds.has(node.kind)) {
      const name = field(node, 'name')?.text ?? `<anonymous:${node.start}>`;
      let info = ctx.classes.find(c => c.name === name && c.scope.parent === scope);
      if (!info) {
        const inner = newScope(node, scope.uri, scope);
        info = { id: `${scope.uri}#${scope.node.start}#${name}`, name, uri: scope.uri, node,
          role: builtinRole(ctx.catalog, scope.uri, name), fields: new Map(), methods: new Map(), scope: inner, defined: !!field(node, 'body') };
        inner.owner = info;
        ctx.classes.push(info);
      } else if (field(node, 'body')) { info.defined = true; info.node = node; }
      const base = node.children.find(c => c.kind === 'base_class_clause');
      info.baseName = base?.children.find(c => c.kind !== 'access_specifier')?.text ?? info.baseName;
      ctx.nodeScopes.set(node, scope);
      for (const child of node.children) { mapScopes(child, info.scope, true); }
      return;
    }
    if (!reuse && (node.kind === 'compound_statement' || node.kind === 'function_definition' || node.kind === 'for_statement')) {
      scope = newScope(node, scope.uri, scope);
    }
    ctx.nodeScopes.set(node, scope);
    for (const child of node.children) { mapScopes(child, scope, node.kind === 'function_definition' && child === field(node, 'body')); }
  }
  for (const document of documents) {
    const snapshot = (document as AnalyzedDocument & { typeSnapshot?: TypeSnapshot }).typeSnapshot;
    if (!snapshot) { continue; }
    roots.push(snapshot.root);
    mapScopes(snapshot.root, newScope(snapshot.root, document.uri), true);
  }

  function collect(node: TypeNode): void {
    if (!ctx.nodeScopes.has(node)) { return; }
    if (declarationKinds.has(node.kind)) {
      let scope = scopeFor(ctx, node);
      const functionScope = node.kind === 'function_definition' ? scope : undefined;
      if (functionScope?.parent) { scope = functionScope.parent; }
      const typeNode = field(node, 'type');
      const onlyDeclarator = node.fields.declarator?.length === 1 ? field(node, 'declarator') : undefined;
      // The grammar cannot distinguish a*b from a pointer declaration before name resolution.
      if (node.kind === 'object_definition' && typeNode?.kind === 'class_name'
          && !field(node, 'storage_class_specifier') && !field(node, 'class_modifier')
          && onlyDeclarator?.kind === 'pointer_declarator' && ['*','&'].includes(onlyDeclarator.text.trimStart()[0])
          && field(onlyDeclarator, 'declarator')?.kind === 'identifier'
          && lookupBinding(ctx, typeNode.text, scope, node.start - 1)) { return; }
      let base = resolveType(ctx, typeNode, scope);
      const modifier = field(node, 'class_modifier');
      if (modifier?.text.includes('unsigned') && basics.has(base.name)) { base = basic(`unsigned ${base.name}`); }
      if (field(node, 'storage_class_specifier')?.text.split(/\s+/).includes('const')) { base = { ...base, const: true }; }
      for (const declarator of node.fields.declarator ?? []) {
        const name = nameOf(declarator);
        if (!name) { continue; }
        const qualified = findDeclarator(declarator, 'qualified_declarator');
        const owner = qualified ? lookupClass(ctx, field(qualified, 'scope')?.text ?? '', scope) : scope.owner;
        const effectiveScope = owner && qualified ? owner.scope : scope;
        if (!field(node, 'type') && owner?.name === name) { base = { kind: 'class', name: owner.name, classInfo: owner }; }
        const shaped = shapeType(ctx, declarator, base, effectiveScope, node);
        if (node.kind === 'type_definition') {
          ctx.aliases.set(aliasKey(scope, name), shaped.type);
          continue;
        }
        const binding: Binding = { name, type: shaped.type, node, scope: effectiveScope, uri: scope.uri };
        ctx.bindings.push(binding); effectiveScope.bindings.push(binding);
        if (shaped.type.kind === 'function') {
          const fn = shaped.type.call!;
          fn.owner = owner;
          if (functionScope) {
            fn.scope = functionScope; functionScope.fn = fn; functionScope.owner = owner;
          }
          ctx.functions.push(fn);
          if (owner) { const overloads = owner.methods.get(name) ?? []; overloads.push(fn); owner.methods.set(name, overloads); }
          if (functionScope) {
            const functionDeclarator = findDeclarator(declarator, 'function_declarator');
            const params = field(functionDeclarator!, 'parameters')?.children.filter(c => c.kind === 'parameter_declaration') ?? [];
            params.forEach((parameter, index) => {
              const paramName = nameOf(field(parameter, 'declarator'));
              if (!paramName) { return; }
              const param: Binding = { name: paramName, type: fn.parameters[index] ?? unknownType, node: parameter, uri: scope.uri, scope: functionScope };
              ctx.bindings.push(param); functionScope.bindings.push(param);
            });
          }
        } else if (owner && effectiveScope === owner.scope) { owner.fields.set(name, binding); }
      }
    }
    for (const child of node.children) { collect(child); }
  }
  for (const root of roots) { collect(root); }
  for (const scope of ctx.scopes) {
    if (scope.parent) { scope.fn ??= scope.parent.fn; scope.owner ??= scope.parent.owner; }
  }
  return ctx;
}
