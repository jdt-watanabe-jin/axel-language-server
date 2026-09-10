import type { AnalysisDiagnostic, AnalysisMacroDefinition, AnalyzedDocument } from '../../types/analysis';
import { message } from '../../i18n/messages';
import { containsSourcePosition } from '../systemMacros';
import { type BuiltinCatalog, loadBuiltinCatalog, isBuiltinDeclarationSource } from './builtinCatalog';
import { buildTypeContext, lookupBinding, lookupClass, scopeFor } from './declarations';
import { evaluateExpression, checkCondition, checkBinaryExpression } from './expressions';
import { checkCompatibility } from './compatibility';
import { isInteger, type ClassInfo, type TypeContext } from './model';
import { field, descendants, type TypeNode } from './syntax';

export interface TypeDiagnosticsInput {
  analysis: AnalyzedDocument;
  documents?: readonly AnalyzedDocument[];
  catalog?: BuiltinCatalog;
  resolveMacro?: (name: string, node: TypeNode) => AnalysisMacroDefinition | undefined;
}

export function collectTypeDiagnostics(input: TypeDiagnosticsInput): AnalysisDiagnostic[] {
  const {analysis} = input;
  const root = analysis.typeSnapshot?.root;
  const catalog = input.catalog ?? loadBuiltinCatalog([]);
  if (!root || isBuiltinDeclarationSource(catalog, analysis.uri)) { return []; }
  const ctx = buildTypeContext({...input, catalog});
  const undefCalls = descendants(root,'preproc_call').filter(call => field(call,'directive')?.text.replace(/\s/g,'') === '#undef');
  ctx.resolveMacro = (name, node) => {
    const candidates = analysis.macroDefinitions.filter(macro => macro.name === name
      && (macro.range.start.line < node.range.start.line || macro.range.start.line === node.range.start.line && macro.range.start.character <= node.range.start.character));
    const macro = input.resolveMacro ? input.resolveMacro(name, node) : candidates.at(-1);
    if (!macro || name === 'NULL' && catalog.analysisOnlyMacroUris.has(macro.uri)) { return undefined; }
    const origin = macro.visibilityStart ?? (macro.uri === analysis.uri ? macro.range.start : {line:0,character:0});
    const removed = undefCalls.some(call =>
      field(call,'directive')?.text.replace(/\s/g,'') === '#undef'
      && field(call,'argument')?.text.trim() === name && !suppressed(call)
      && call.start < node.start && (call.range.start.line > origin.line
        || call.range.start.line === origin.line && call.range.start.character >= origin.character));
    return removed ? undefined : macro;
  };
  const suppressed = (node: TypeNode): boolean =>
    [...analysis.inactiveRanges ?? [], ...analysis.uncertainRanges ?? []]
      .some(range => containsSourcePosition(range, node.range.start));
  const report = (node: TypeNode, category: string, template: string, ...args: string[]): void => {
    ctx.diagnostics.push({severity:'error',source:'axel',code:'axel.type.'+category,
      range:node.range,...message(template,...args)});
  };
  function visit(node: TypeNode): void {
    if (suppressed(node) || node.kind === 'ERROR') { return; }
    const scope = scopeFor(ctx, node);
    if (node.kind === 'object_definition') {
      const left = field(node,'type');
      const declarators = node.fields.declarator ?? [];
      const pointer = declarators.length === 1 ? declarators[0] : undefined;
      const right = pointer?.kind === 'pointer_declarator' ? field(pointer,'declarator') : undefined;
      if (left?.kind === 'class_name' && right?.kind === 'identifier'
        && lookupBinding(ctx,left.text,scope,node.start-1)) {
        const operand = {...left,kind:'identifier'};
        const leftValue = evaluateExpression(ctx,operand,scope);
        const binding = lookupBinding(ctx,right.text,scope,node.start-1);
        if (binding) {
          checkBinaryExpression(ctx,node,pointer!.text.trimStart().startsWith('&') ? '&' : '*',leftValue,
            {type:binding.type,category:'storage'});
        }
        return;
      }
    }
    if (node.kind === 'init_declarator') {
      const value = field(node,'value');
      const id = declarationName(field(node,'declarator'));
      const binding = id ? lookupBinding(ctx,id.text,scope,node.end) : undefined;
      if (value && binding) {
        const from = evaluateExpression(ctx,value,scope);
        if (checkCompatibility(ctx,from.type,binding.type,'initialize') === 'rejected') {
          report(value,'initialization',"Cannot initialize '{0}' with '{1}'.",binding.type.name,from.type.name);
        }
      }
    }
    if (node.kind === 'array_declarator') {
      const size = field(node,'size');
      if (size) {
        const result = evaluateExpression(ctx,size,scope);
        if (result.type.kind !== 'unknown' && (!isInteger(result.type) || typeof result.constant !== 'number' && !result.constantExpression)) {
          report(size,'constant_expression','Array size must be an integer constant expression.');
        }
      }
    }
    if (node.kind === 'enumerator') {
      const value = field(node,'value');
      if (value) {
        const result = evaluateExpression(ctx,value,scope);
        if (result.type.kind !== 'unknown' && (!isInteger(result.type) || typeof result.constant !== 'number' && !result.constantExpression)) {
          report(value,'syntax','Enumerator value must be an integer constant expression.');
        }
      }
    }
    if (node.kind === 'return_statement' && scope.fn) {
      const value = node.children[0];
      const target = scope.fn.result;
      if (!value && target.kind !== 'unknown' && target.name !== 'void') {
        report(node,'return',"Return value of type '{0}' is required.",target.name);
      } else if (value) {
        const result = evaluateExpression(ctx,value,scope);
        if (target.name === 'void' || checkCompatibility(ctx,result.type,target,'return') === 'rejected') {
          report(value,'return',"Cannot return '{0}' from a function returning '{1}'.",result.type.name,target.name);
        }
      }
    }
    if (['if_statement','while_statement','do_statement','for_statement'].includes(node.kind)) {
      const condition = field(node,'condition');
      if (condition) { checkCondition(ctx,condition,evaluateExpression(ctx,condition,scope)); }
    }
    if (node.kind === 'switch_statement') {
      const condition = field(node,'condition');
      const body = field(node,'body');
      if (condition && body) {
        const target = evaluateExpression(ctx,condition,scope);
        for (const item of switchCases(body)) {
          const value = field(item,'value');
          if (!value) { continue; }
          const result = evaluateExpression(ctx,value,scopeFor(ctx,value));
          if (checkCompatibility(ctx,result.type,target.type,'operator') === 'rejected') {
            report(value,'binary_operator',"Case value '{0}' cannot be compared with '{1}'.",result.type.name,target.type.name);
          }
        }
      }
    }
    if (node.kind === 'function_definition') {
      const declaration = field(node,'declarator');
      if (declaration && descendants(declaration,'conversion_declarator').length && field(node,'type')) {
        report(node,'operator_definition','A conversion operator must not declare a return type.');
      }
    }
    if (node.kind === 'object_definition' || node.kind === 'field_declaration') {
      for (const fn of node.fields.declarator ?? []) {
        if (fn.kind === 'function_declarator') {
          report(fn,'prototype','Function prototypes are not supported by this AXEL runtime.');
        }
      }
    }
    if (isExpression(node)) { evaluateExpression(ctx,node,scope); }
    for (const child of node.children) { visit(child); }
  }
  visit(root);
  function hasInstanceData(info: ClassInfo, seen = new Set<string>()): boolean | undefined {
    if (!info.defined || isBuiltinDeclarationSource(catalog,info.uri) || seen.has(info.id)) { return undefined; }
    if (info.fields.size > 0) { return true; }
    const source = ctx.documents.find(document => document.uri === info.uri);
    if (source?.uncertainRanges?.some(range => containsSourcePosition(info.node.range,range.start))
      || descendants(info.node,'ERROR').length > 0) { return undefined; }
    seen.add(info.id);
    if (!info.baseName) { return false; }
    const base = lookupClass(ctx,info.baseName,info.scope);
    return base ? hasInstanceData(base,seen) : undefined;
  }
  for (const binding of ctx.bindings) {
    if (binding.uri !== analysis.uri || binding.node.kind !== 'object_definition' || suppressed(binding.node)) { continue; }
    let type = binding.type;
    while (type.kind === 'array' && type.element) { type = type.element; }
    if (type.kind !== 'class' || !type.classInfo || hasInstanceData(type.classInfo) !== false) { continue; }
    const declarator = (binding.node.fields.declarator ?? []).find(node => declarationName(node)?.text === binding.name);
    report(declarationName(declarator) ?? binding.node,'object_type',"Cannot instantiate class '{0}' without instance data.",type.name);
  }
  const definitions = ctx.functions.filter(fn => fn.uri === analysis.uri && fn.node.kind === 'function_definition');
  for (let i=0;i<definitions.length;i++) {
    const fn=definitions[i];
    if (definitions.slice(0,i).some(other => other.name===fn.name && other.owner===fn.owner && other.instancePath===fn.instancePath
      && other.parameters.length===fn.parameters.length && other.scope.parent===fn.scope.parent)) {
      report(fn.node,'definition',"Function '{0}' is already defined.",fn.name);
    }
  }
  const classes = ['class_specifier','struct_specifier','union_specifier']
    .flatMap(kind => descendants(root,kind)).filter(node => field(node,'body') && !suppressed(node));
  for (let i=1;i<classes.length;i++) {
    const name = field(classes[i],'name');
    if (name && classes.slice(0,i).some(other => field(other,'name')?.text === name.text)) {
      report(name,'duplicate_class',"Class '{0}' is already defined.",name.text);
    }
  }
  return deduplicate(ctx);
}

function isExpression(node: TypeNode): boolean {
  return node.kind.endsWith('_expression') && !['expression_statement'].includes(node.kind);
}
function declarationName(node: TypeNode | undefined): TypeNode | undefined {
  if (!node) { return undefined; }
  if (node.kind === 'identifier' || node.kind === 'field_identifier') { return node; }
  return declarationName(field(node,'declarator'));
}
function deduplicate(ctx: TypeContext): AnalysisDiagnostic[] {
  const result = new Map<string,AnalysisDiagnostic>();
  for (const diagnostic of ctx.diagnostics) {
    const {range,code}=diagnostic;
    result.set(`${code}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`,diagnostic);
  }
  return [...result.values()];
}

function switchCases(node: TypeNode): TypeNode[] {
  if (node.kind === 'switch_statement') { return []; }
  return [...(node.kind === 'case_statement' ? [node] : []), ...node.children.flatMap(switchCases)];
}
