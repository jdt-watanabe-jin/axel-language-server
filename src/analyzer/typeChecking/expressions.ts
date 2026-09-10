import { resolveGuiPartPath } from '../guiResolution';
import { createAxelParser } from '../axelParser';
import { expandMacroInvocationText } from '../macroExpansion';
import { containsSourcePosition, resolveSystemMacro } from '../systemMacros';
import { comparePositions } from '../resolution';
import { message } from '../../i18n/messages';
import { checkCompatibility } from './compatibility';
import { lookupBinding, lookupClass, resolveType } from './declarations';
import {
  basic, dereference, isInteger, isNumeric, pointer, role, sameType, unknownType,
  type ExpressionResult, type FunctionInfo, type Scope, type Type, type TypeContext
} from './model';
import { buildTypeSnapshot, descendants, field, type TypeNode } from './syntax';

const unknown = (): ExpressionResult => ({ type: unknownType, category: 'temporary', unknown: true });
const temporary = (type: Type, constant?: number | string | boolean): ExpressionResult => ({ type, category: 'temporary', constant });
const isConstant = (value: ExpressionResult): boolean => value.constant !== undefined || value.constantExpression === true;

const categoryLabels: Record<string, string> = {
  argument_type: 'argument', binary_operator: 'binary operation', assignment: 'assignment',
  cast: 'type cast', condition: 'condition', delete: 'deletion', member: 'member access',
  not_callable: 'function call', subscript: 'array index', unary_operator: 'unary operation'
};

function problem(ctx: TypeContext, node: TypeNode, category: string, expected?: Type, actual?: Type): void {
  ctx.diagnostics.push({ severity: 'error', source: 'axel', code: `axel.type.${category}`, range: node.range,
    ...message('Invalid {0}: expected {1}, got {2}.', { key: categoryLabels[category] ?? category }, expected?.name ?? '', actual?.name ?? '') });
}
function builtin(ctx: TypeContext, name: string): Type {
  const info = ctx.classes.find(c => c.role === name);
  return info ? { kind: 'class', name: info.name, classInfo: info } : unknownType;
}
function callable(fn: FunctionInfo, candidates: FunctionInfo[] = [fn]): ExpressionResult {
  return temporary({ kind: 'function', name: fn.name, call: fn, candidates });
}
function baseClass(ctx: TypeContext, type: Type): Type | undefined {
  const info = type.classInfo;
  if (!info?.baseName) { return undefined; }
  const parent = lookupClass(ctx, info.baseName, info.scope);
  return parent ? { kind: 'class', name: parent.name, classInfo: parent } : undefined;
}
function member(ctx: TypeContext, type: Type, name: string, seen = new Set<string>()): ExpressionResult | undefined {
  const info = type.classInfo;
  if (!info || seen.has(info.id)) { return undefined; }
  seen.add(info.id);
  const binding = info.fields.get(name);
  if (binding) { return { type: binding.type, category: 'storage' }; }
  const methods = info.methods.get(name);
  if (methods?.length) { return callable(methods[0], methods); }
  const parent = baseClass(ctx, type);
  return parent ? member(ctx, parent, name, seen) : undefined;
}

export function checkCondition(ctx: TypeContext, node: TypeNode, value: ExpressionResult): void {
  const type = dereference(value.type);
  if (type.kind === 'unknown' || isNumeric(type) || type.kind === 'pointer' || type.kind === 'null' || ['natural', 'string'].includes(role(type) ?? '')) { return; }
  if (type.classInfo?.methods.has('convert:bool')) { return; }
  problem(ctx, node, 'condition', basic('bool'), type);
}

/** Binary operators use direct operand rules; implicit user conversions are not composed. */
export function checkBinaryExpression(ctx: TypeContext, node: TypeNode, operator: string,
  left: ExpressionResult, right: ExpressionResult): ExpressionResult {
  const a = dereference(left.type), b = dereference(right.type);
  if (a.kind === 'unknown' || b.kind === 'unknown') { return unknown(); }
  const comparison = ['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(operator);
  const numericResult = (): Type => comparison ? basic('int')
    : basic(a.name === 'double' || b.name === 'double' ? 'double' : a.name === 'float' || b.name === 'float' ? 'float' : 'int');
  if (isNumeric(a) && isNumeric(b)) {
    let constant: number | undefined;
    if (typeof left.constant === 'number' && typeof right.constant === 'number') {
      const x = left.constant, y = right.constant;
      switch (operator) {
        case '+': constant = x + y; break;
        case '-': constant = x - y; break;
        case '*': constant = x * y; break;
        case '/': if (y !== 0) { constant = isInteger(a) && isInteger(b) ? Math.trunc(x / y) : x / y; } break;
        case '%': if (y !== 0) { constant = x % y; } break;
        case '<<': constant = x << y; break;
        case '>>': constant = x >> y; break;
        case '&': constant = x & y; break;
        case '|': constant = x | y; break;
        case '^': constant = x ^ y; break;
        case '==': constant = Number(x === y); break;
        case '!=': constant = Number(x !== y); break;
        case '<': constant = Number(x < y); break;
        case '>': constant = Number(x > y); break;
        case '<=': constant = Number(x <= y); break;
        case '>=': constant = Number(x >= y); break;
      }
    }
    return {...temporary(numericResult(), constant), constantExpression:isConstant(left) && isConstant(right)
      && !(['/', '%'].includes(operator) && right.constant === 0)};
  }
  if (role(a) === 'natural' && ['<<', '>>'].includes(operator)) {
    if (b.kind === 'basic' && b.name === 'int') { return temporary(basic('int')); }
    problem(ctx, node, 'binary_operator', a, b);
    return unknown();
  }
  if (role(a) === 'natural' || role(b) === 'natural') {
    const an = role(a) === 'natural', bn = role(b) === 'natural';
    if ((an || isNumeric(a)) && (bn || isNumeric(b)) && ['+', '-', '*', '/', '%', '==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(operator)
      && !(an && bn && operator === '*')) {
      const result = comparison || (operator === '/' && bn) ? basic('int')
        : ['+', '-'].includes(operator) && (!an || !bn)
          ? basic(a.name === 'double' || b.name === 'double' ? 'double' : a.name === 'float' || b.name === 'float' ? 'float' : 'int')
          : builtin(ctx, 'natural');
      return temporary(result);
    }
  }
  if (role(a) === 'string') {
    if (role(b) === 'string' && ['+', '-', '==', '!=', '<', '>', '<=', '>='].includes(operator)) {
      return temporary(comparison ? basic('int') : a);
    }
    if (isInteger(b) && operator === '*') { return temporary(a); }
  }
  if ((a.kind === 'pointer' || a.kind === 'array') && isInteger(b) && ['+', '-'].includes(operator)) {
    return temporary(a.kind === 'array' ? pointer(a.element!) : a);
  }
  if (comparison && (a.kind === 'pointer' || a.kind === 'null') && (b.kind === 'pointer' || b.kind === 'null')) {
    return temporary(basic('int'));
  }
  const candidates = a.classInfo?.methods.get(`operator${operator}`) ?? [];
  const selected = selectOverload(ctx, candidates, [right], 'operator');
  if (selected.fn) { return temporary(selected.fn.result); }
  if (selected.uncertain) { return unknown(); }
  problem(ctx, node, 'binary_operator', a, b);
  return unknown();
}

function selectOverload(ctx: TypeContext, candidates: FunctionInfo[], values: ExpressionResult[], site: 'argument' | 'operator'):
  { fn?: FunctionInfo; uncertain?: boolean } {
  const viable: FunctionInfo[] = [];
  let uncertain = false;
  for (const fn of candidates) {
    if (values.length < fn.required || (!fn.variadic && values.length > fn.parameters.length)) { continue; }
    const relations = values.map((value,index) => fn.parameters[index]
      ? checkCompatibility(ctx,dereference(value.type),fn.parameters[index],site) : 'accepted');
    if (relations.includes('rejected')) { continue; }
    if (relations.includes('unknown')) { uncertain = true; continue; }
    viable.push(fn);
  }
  if (uncertain) { return {uncertain:true}; }
  // Runtime ranking is not established. A shared result is useful without
  // choosing a speculative promotion winner or inventing an ambiguity error.
  if (viable.length && viable.every(fn => sameType(fn.result,viable[0].result))) { return {fn:viable[0]}; }
  return viable.length ? {uncertain:true} : {};
}

function invoke(ctx: TypeContext, node: TypeNode, candidates: FunctionInfo[], args: TypeNode[], scope: Scope): ExpressionResult {
  const values = args.map(arg => evaluateExpression(ctx, arg, scope));
  const selected = selectOverload(ctx, candidates, values, 'argument');
  if (selected.uncertain) { return unknown(); }
  const fn = selected.fn ?? candidates[0];
  if (!fn) { return unknown(); }
  if (!selected.fn) {
    if (args.length < fn.required || (!fn.variadic && args.length > fn.parameters.length)) {
      problem(ctx, node, 'argument_type');
    } else {
      for (let i = 0; i < Math.min(values.length, fn.parameters.length); i++) {
        if (checkCompatibility(ctx, values[i].type, fn.parameters[i], 'argument') === 'rejected') {
          problem(ctx, args[i], 'argument_type', fn.parameters[i], values[i].type);
        }
      }
    }
    return unknown();
  }
  return { type: dereference(fn.result), category: fn.result.kind === 'reference' ? 'reference' : 'temporary' };
}

export function evaluateExpression(ctx: TypeContext, node: TypeNode, scope: Scope): ExpressionResult {
  const cached = ctx.cache.get(node);
  if (cached) { return cached; }
  ctx.cache.set(node, unknown());
  const result = evaluate(ctx, node, scope);
  ctx.cache.set(node, result);
  return result;
}


/** Uncertain alternatives only affect references where they could be visible. */
function uncertainExpressionName(ctx: TypeContext, name: string, node: TypeNode, scope: Scope): boolean {
  const analysis = ctx.documents.find(document => document.uri === scope.uri) ?? ctx.analysis;
  if (!analysis.uncertainNames?.includes(name)) { return false; }
  const macros = (analysis.uncertainMacroDefinitions ?? []).filter(macro => macro.name === name);
  const declarations = (analysis.uncertainDeclarations ?? []).filter(declaration => declaration.name === name && declaration.kind !== 'macro');
  const definiteMacro = ctx.resolveMacro?.(name, node);
  if (macros.some(macro => {
    const start = macro.visibilityStart ?? macro.range.start;
    if (macro.uri === analysis.uri && comparePositions(start, node.range.start) > 0) { return false; }
    return !definiteMacro || definiteMacro.uri !== analysis.uri
      || comparePositions(definiteMacro.visibilityStart ?? definiteMacro.range.start, start) <= 0;
  })) { return true; }
  const binding = lookupBinding(ctx, name, scope, node.start);
  if (declarations.some(declaration => {
    if (declaration.uri !== analysis.uri) { return true; }
    if (comparePositions(declaration.selectionRange.start, node.range.start) > 0) { return false; }
    const candidateScope = analysis.scopes.find(candidate => candidate.declarationIds.includes(declaration.id));
    if (!candidateScope || !containsSourcePosition(candidateScope.range, node.range.start)) { return false; }
    if (binding?.uri === analysis.uri) {
      const bindingRange = binding.scope.node.range;
      const inner = containsSourcePosition(candidateScope.range, bindingRange.start)
        && (comparePositions(candidateScope.range.start, bindingRange.start) !== 0
          || comparePositions(candidateScope.range.end, bindingRange.end) !== 0);
      if (inner || comparePositions(binding.node.range.start, declaration.selectionRange.start) > 0) { return false; }
    }
    return true;
  })) { return true; }
  if (macros.length || declarations.length) { return false; }
  // Imported uncertainty may have no local declaration/position evidence.
  // A known local redefinition after every local uncertain range still wins.
  const ranges = analysis.uncertainRanges ?? [];
  if (definiteMacro?.uri === analysis.uri && ranges.length > 0
    && ranges.every(range => comparePositions(range.end, definiteMacro.range.start) <= 0)) { return false; }
  return true;
}

const expandingMacros = new WeakMap<TypeContext, Set<string>>();
const macroSyntax = new WeakMap<TypeContext, { parser: ReturnType<typeof createAxelParser>; expressions: Map<string, TypeNode | undefined> }>();
function macroExpression(ctx: TypeContext, node: TypeNode, scope: Scope): ExpressionResult | undefined {
  const name = node.kind === 'call_expression' ? field(node, 'function')?.text : node.text;
  if (!name || !['identifier', 'null', 'call_expression'].includes(node.kind)) { return undefined; }
  if (uncertainExpressionName(ctx, name, node, scope)) { return unknown(); }
  const macro = ctx.resolveMacro?.(name, node);
  if (!macro) { return undefined; }
  const active = expandingMacros.get(ctx) ?? new Set<string>();
  expandingMacros.set(ctx, active);
  if (active.has(name) || active.size >= 8) { return unknown(); }
  active.add(name);
  try {
    let text = macro.replacementText;
    if (node.kind === 'call_expression') {
      const expanded = expandMacroInvocationText(node.text, { findMacro: candidate => uncertainExpressionName(ctx, candidate, node, scope) ? undefined : ctx.resolveMacro?.(candidate, node) });
      if (expanded.truncated || expanded.diagnostics.length) { return unknown(); }
      text = expanded.expandedText;
    } else if (macro.parameters !== undefined) { return unknown(); }
    let syntax = macroSyntax.get(ctx);
    if (!syntax) {
      syntax = {parser:createAxelParser(), expressions:new Map()};
      macroSyntax.set(ctx,syntax);
    }
    if (!syntax.expressions.has(text)) {
      const tree = syntax.parser.parse(`void __type_macro(){return ${text};}`);
      const snapshot = tree.rootNode.hasError ? undefined : buildTypeSnapshot(tree.rootNode, ctx.analysis.uri);
      const statement = snapshot && descendants(snapshot.root,'return_statement')[0];
      syntax.expressions.set(text,statement?.children[0]);
    }
    const template = syntax.expressions.get(text);
    if (!template) { return unknown(); }
    // Syntax is cached; each expansion still resolves names at its own invocation.
    const clones = new Map<TypeNode,TypeNode>();
    function atInvocation(item: TypeNode): TypeNode {
      const cached = clones.get(item);
      if (cached) { return cached; }
      const clone: TypeNode = {...item, range:node.range,start:node.start,end:node.end,children:[],fields:{}};
      clones.set(item,clone);
      clone.children=item.children.map(atInvocation);
      for (const [name,children] of Object.entries(item.fields)) { clone.fields[name]=children.map(atInvocation); }
      return clone;
    }
    return evaluateExpression(ctx, atInvocation(template), scope);
  } finally { active.delete(name); }
}

function evaluate(ctx: TypeContext, node: TypeNode, scope: Scope): ExpressionResult {
  if (node.kind === 'identifier') {
    const macro = resolveSystemMacro(node.text, scope.uri, node.range.start, ctx.analysis.tool);
    if (macro) {
      return macro.defined
        ? temporary(macro.typeName === 'int' ? basic('int') : builtin(ctx, 'string'), macro.value)
        : unknown();
    }
  }
  const expanded = macroExpression(ctx, node, scope);
  if (expanded) { return expanded; }
  const expression = (child?: TypeNode): ExpressionResult => child ? evaluateExpression(ctx, child, scope) : unknown();
  const op = field(node, 'operator')?.text ?? '';
  switch (node.kind) {
    case 'number_literal': case 'integer_literal': case 'integer64_literal': case 'double_literal':
    case 'unit_integer_literal': case 'unit_double_literal': {
      if (/[a-z]+$/i.test(node.text) && /nat$/i.test(node.text)) { return temporary(builtin(ctx, 'natural')); }
      if (node.kind.startsWith('unit_')) { return unknown(); }
      const value = Number(node.text.replace(/[lLuU]+$/, ''));
      return temporary(basic(node.kind === 'integer64_literal' ? 'int64' : /[.eE]/.test(node.text) && !/^0x/i.test(node.text) ? 'double' : 'int'), Number.isFinite(value) ? value : undefined);
    }
    case 'true': return temporary(basic('bool'), true);
    case 'false': return temporary(basic('bool'), false);
    case 'string_literal': return temporary(builtin(ctx, 'string'), node.text);
    case 'char_literal': return temporary(basic('int'));
    case 'null': return temporary({ kind: 'null', name: 'NULL' });
    case 'this': {
      let current: Scope | undefined = scope;
      while (current && !current.owner) { current = current.parent; }
      const owner = current?.owner;
      return owner ? temporary(pointer({ kind: 'class', name: owner.name, classInfo: owner })) : unknown();
    }
    case 'identifier': case 'field_identifier': case 'qualified_identifier': {
      const binding = lookupBinding(ctx, node.text, scope, node.start);
      if (binding) {
        if (binding.type.call) {
          const fn = binding.type.call;
          const candidates = ctx.functions.filter(other => other.name === fn.name && other.owner === fn.owner
            && (!other.scope.parent?.parent || other.scope.parent === fn.scope.parent));
          return callable(fn, candidates.length ? candidates : [fn]);
        }
        return { type: binding.type, category: binding.type.kind === 'reference' ? 'reference' : 'storage' };
      }
      const fn = ctx.functions.find(f => f.name === node.text && !f.owner);
      if (fn) { return callable(fn, ctx.functions.filter(other => other.name === fn.name && !other.owner)); }
      return unknown();
    }
    case 'parenthesized_expression': case 'expression': case 'expression_statement':
      return expression(node.children[0]);
    case 'comma_expression': {
      let value = unknown();
      for (const child of node.children) { value = expression(child); }
      return value;
    }
    case 'cast_expression': {
      const value = expression(field(node, 'argument'));
      const targetNode = field(node, 'type');
      if (!targetNode) { return unknown(); }
      const target = resolveType(ctx, targetNode, scope);
      if (checkCompatibility(ctx, value.type, target, 'cast') === 'rejected') { problem(ctx, node, 'cast', target, value.type); }
      return temporary(target);
    }
    case 'sizeof_expression': return { ...temporary(basic('int')), constantExpression: true };
    case 'new_expression': {
      const typeNode = field(node, 'type');
      return typeNode ? temporary(pointer(resolveType(ctx, typeNode, scope))) : unknown();
    }
    case 'delete_expression': {
      const value = expression(field(node, 'argument'));
      if (!['pointer', 'array', 'null', 'unknown'].includes(value.type.kind)) { problem(ctx, node, 'delete', undefined, value.type); }
      return temporary(basic('void'));
    }
    case 'field_expression': {
      const value = expression(field(node, 'argument'));
      let type = dereference(value.type);
      if (op.startsWith('->') && type.element) { type = type.element; }
      const name = field(node, 'field');
      if (!name || type.kind === 'unknown') { return unknown(); }
      const found = member(ctx, type, name.text);
      if (found) { return found; }
      const owner = value.guiReceiver?.owner ?? type.classInfo;
      if (owner) {
        const source = ctx.documents.find(document => document.uri === owner.uri);
        const path = [...value.guiReceiver?.path ?? [], name.text];
        const part = source && resolveGuiPartPath({analysis:source, position:node.range.start,
          workspaceIndex:{listVisibleDocuments:()=>[...ctx.documents]}}, owner.name, path);
        if (part) {
          const info = lookupClass(ctx, part.part.typeName, owner.scope);
          return {type:info ? {kind:'class',name:info.name,classInfo:info} : unknownType,
            category:'storage',guiReceiver:{owner,path}};
        }
      }
      problem(ctx, name, 'member', undefined, type);
      return unknown();
    }
    case 'subscript_expression': {
      const value = expression(field(node, 'argument'));
      const index = expression(field(node, 'index'));
      const type = dereference(value.type);
      if (type.kind === 'unknown' || index.type.kind === 'unknown') { return unknown(); }
      if (isInteger(index.type)) {
        if (type.kind === 'pointer' || type.kind === 'array') { return { type: type.element!, category: 'storage' }; }
        if (role(type) === 'string') { return temporary(basic('int')); }
      }
      const subscript = member(ctx, type, 'operator[]');
      const indexNode = field(node, 'index');
      if (subscript?.type.call && indexNode && (role(type) !== 'VARRAY' || isInteger(index.type))) {
        return invoke(ctx, node, subscript.type.candidates ?? [subscript.type.call], [indexNode], scope);
      }
      problem(ctx, node, 'subscript', undefined, type);
      return unknown();
    }
    case 'pointer_expression': case 'unary_expression': case 'update_expression': {
      const value = expression(field(node, 'argument'));
      const type = dereference(value.type);
      if (type.kind === 'unknown') { return unknown(); }
      if (op === '&' && value.category !== 'temporary') { return temporary(pointer(type)); }
      if (op === '*' && (type.kind === 'pointer' || type.kind === 'array')) { return { type: type.element!, category: 'storage' }; }
      if (op === '!' && (isNumeric(type) || ['natural', 'string'].includes(role(type) ?? '') || type.kind === 'pointer')) { return temporary(basic('int')); }
      if (['-', '+'].includes(op) && role(type) === 'natural') { return temporary(type); }
      if (['-', '+', '~'].includes(op) && isNumeric(type)) {
        const constant = typeof value.constant === 'number'
          ? op === '-' ? -value.constant : op === '~' ? ~value.constant : value.constant : undefined;
        return {...temporary(type, constant),constantExpression:isConstant(value)};
      }
      if (['++', '--'].includes(op) && isNumeric(type) && value.category !== 'temporary') { return temporary(type); }
      const candidate = type.classInfo?.methods.get(`operator${op}`)?.find(fn => fn.parameters.length === 0);
      if (candidate) { return temporary(candidate.result); }
      problem(ctx, node, 'unary_operator', undefined, type);
      return unknown();
    }
    case 'binary_expression':
      return checkBinaryExpression(ctx, node, op, expression(field(node, 'left')), expression(field(node, 'right')));
    case 'assignment_expression': {
      const left = expression(field(node, 'left')), right = expression(field(node, 'right'));
      if (left.type.kind === 'unknown' || right.type.kind === 'unknown') { return unknown(); }
      if (left.category === 'temporary' || left.type.kind === 'array') {
        problem(ctx, node, 'assignment', left.type, right.type);
        return unknown();
      }
      if (op !== '=') {
        if (role(left.type) === 'natural' && (['<<=', '>>=', '%=', '&=', '|=', '^='].includes(op)
          || role(right.type) === 'natural' && op === '/=')) {
          problem(ctx, node, 'binary_operator', left.type, right.type);
          return unknown();
        }
        if (left.type.kind === 'class' && !role(left.type)) {
          const candidates = left.type.classInfo?.methods.get(`operator${op}`) ?? [];
          const selected = selectOverload(ctx, candidates, [right], 'operator');
          if (selected.fn) { return temporary(selected.fn.result); }
          if (!selected.uncertain) { problem(ctx, node, 'binary_operator', left.type, right.type); }
          return unknown();
        }
        const value = checkBinaryExpression(ctx, node, op.slice(0, -1), left, right);
        if (value.type.kind === 'unknown') { return value; }
      } else if (checkCompatibility(ctx, right.type, left.type, 'assign') === 'rejected') {
        problem(ctx, node, 'assignment', left.type, right.type);
      }
      return { type: left.type, category: 'storage' };
    }
    case 'call_expression': {
      const functionNode = field(node, 'function');
      const callee = expression(functionNode);
      const args = field(node, 'arguments')?.children ?? [];
      if (callee.type.call) { return invoke(ctx, node, callee.type.candidates ?? [callee.type.call], args, scope); }
      const candidates = callee.type.classInfo?.methods.get('operator()');
      if (candidates?.length) { return invoke(ctx, node, candidates, args, scope); }
      for (const arg of args) { expression(arg); }
      if (callee.type.kind !== 'unknown') { problem(ctx, node, 'not_callable', undefined, callee.type); }
      return unknown();
    }
    case 'conditional_expression': {
      const conditionNode = field(node, 'condition');
      const condition = expression(conditionNode);
      if (conditionNode) { checkCondition(ctx, conditionNode, condition); }
      const a = expression(field(node, 'consequence')), b = expression(field(node, 'alternative'));
      return temporary(checkCompatibility(ctx, a.type, b.type, 'assign') === 'accepted' ? b.type : a.type);
    }
    default: return unknown();
  }
}
