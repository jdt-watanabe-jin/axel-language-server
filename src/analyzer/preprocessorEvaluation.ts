import type * as Parser from 'tree-sitter';
import type { AnalysisPreprocessorSymbol, AnalysisRange } from '../types/analysis';
import { getDeclaratorName, nodeToAnalysisRange } from './syntaxTree';
import { containsSourcePosition, isSystemMacroName, systemMacroNames } from './systemMacros';
import { isDeclarationNodeType, isTypeSpecifierNodeType } from './nodeKinds';

interface MacroDefinition {
  value?: string;
  possiblyUndefined?: boolean;
  unknownValue?: boolean;
}

type MacroDefinitions = Map<string, MacroDefinition>;

interface Branch {
  condition?: Parser.SyntaxNode;
  name?: Parser.SyntaxNode;
  directiveText: string;
  content: Parser.SyntaxNode[];
}

const PREPROCESSOR_IF_NODE_TYPES = new Set([
  'preproc_if',
  'preproc_ifdef',
  'preproc_elif',
  'preproc_elifdef',
  'preproc_else'
]);

export interface PreprocessorEvaluation {
  inactiveRanges: AnalysisRange[];
  uncertainRanges: AnalysisRange[];
  uncertainNames: string[];
}

export function collectInactivePreprocessorRanges(
  rootNode: Parser.SyntaxNode,
  predefinedSymbols: readonly AnalysisPreprocessorSymbol[] = [],
  tool?: string
): AnalysisRange[] {
  return evaluatePreprocessor(rootNode, predefinedSymbols, tool).inactiveRanges;
}

export function evaluatePreprocessor(
  rootNode: Parser.SyntaxNode,
  predefinedSymbols: readonly AnalysisPreprocessorSymbol[] = [],
  tool?: string
): PreprocessorEvaluation {
  const result: PreprocessorEvaluation = { inactiveRanges: [], uncertainRanges: [], uncertainNames: [] };
  const macros = macroDefinitionsFromSymbols(predefinedSymbols);
  for (const name of systemMacroNames(tool)) {
    macros.set(name, name === '__AXEL__' || name.startsWith('__APP_') ? { value: '1' } : { unknownValue: true });
  }
  visitChildren(rootNode.namedChildren, macros, result, true, predefinedSymbols.filter(symbol => symbol.sourceRange !== undefined));
  result.uncertainNames = [...new Set(result.uncertainNames)];
  return result;
}

// undefined means the code can be active, but is not guaranteed to be active.
type Activity = boolean | undefined;

function visitChildren(
  children: readonly Parser.SyntaxNode[], macros: MacroDefinitions,
  result: PreprocessorEvaluation, active: Activity, includeSymbols: readonly AnalysisPreprocessorSymbol[]
): void {
  for (const node of children) {
    if (isPreprocessorConditional(node)) {
      visitConditional(node, macros, result, active, includeSymbols);
    } else if (active === false) {
      result.inactiveRanges.push(nodeToAnalysisRange(node));
    } else {
      if (active === undefined) {
        result.uncertainRanges.push(nodeToAnalysisRange(node));
        if (isDeclarationNodeType(node.type)) {
          for (let index = 0; index < node.childCount; index += 1) {
            const child = node.child(index);
            if (child === null || node.fieldNameForChild(index) !== 'declarator') { continue; }
            const name = child.type === 'identifier' ? child : getDeclaratorName(child);
            if (name !== null) { result.uncertainNames.push(name.text); }
          }
        } else if (isTypeSpecifierNodeType(node.type)
          || ['enumerator', 'preproc_def', 'preproc_function_def'].includes(node.type)) {
          const name = getDeclaratorName(node);
          if (name !== null) { result.uncertainNames.push(name.text); }
        }
      }
      applyPreprocessorMutation(node, macros);
      if (node.type === 'preproc_include') {
        applyIncludeSymbols(node, macros, includeSymbols);
      }
      visitChildren(node.namedChildren, macros, result, active, includeSymbols);
    }
  }
}

function visitConditional(
  node: Parser.SyntaxNode, macros: MacroDefinitions,
  result: PreprocessorEvaluation, parentActive: Activity, includeSymbols: readonly AnalysisPreprocessorSymbol[]
): void {
  let remaining: Activity = true;
  const outcomes: MacroDefinitions[] = [];
  for (const branch of branchesFromConditional(node)) {
    const condition = evaluateBranchCondition(branch, macros);
    const selected = and(remaining, condition);
    const branchMacros = new Map(macros);
    visitChildren(branch.content, branchMacros, result, and(parentActive, selected), includeSymbols);
    if (selected !== false) { outcomes.push(branchMacros); }
    remaining = and(remaining, condition === undefined ? undefined : !condition);
  }
  if (remaining !== false) { outcomes.push(new Map(macros)); }
  if (parentActive !== false && outcomes.length > 0) {
    macros.clear();
    const names = new Set(outcomes.flatMap(outcome => [...outcome.keys()]));
    for (const name of names) {
      const definitions = outcomes.map(outcome => outcome.get(name));
      const present = definitions.filter((definition): definition is MacroDefinition => definition !== undefined);
      const first = present[0];
      macros.set(name, {
        value: first.value,
        possiblyUndefined: present.length !== outcomes.length || present.some(definition => definition.possiblyUndefined),
        unknownValue: present.some(definition => definition.unknownValue || definition.value !== first.value)
      });
    }
  }
}

function and(left: Activity, right: Activity): Activity {
  if (left === false || right === false) { return false; }
  return left === true && right === true ? true : undefined;
}

function applyIncludeSymbols(node: Parser.SyntaxNode, macros: MacroDefinitions, symbols: readonly AnalysisPreprocessorSymbol[]): void {
  const range = nodeToAnalysisRange(node);
  for (const symbol of symbols) {
    if (isSystemMacroName(symbol.name) || symbol.sourceRange === undefined
      || !containsSourcePosition(range, symbol.sourceRange.start)) { continue; }
    const previous = macros.get(symbol.name);
    if (symbol.possiblyUndefined) {
      macros.set(symbol.name, {
        value: previous?.value,
        possiblyUndefined: previous === undefined || previous.possiblyUndefined,
        unknownValue: true
      });
    } else {
      macros.set(symbol.name, { value: symbol.value, unknownValue: symbol.unknownValue });
    }
  }
}

function branchesFromConditional(node: Parser.SyntaxNode): Branch[] {
  const branches: Branch[] = [];
  let current: Parser.SyntaxNode | undefined = node;
  while (current !== undefined) {
    branches.push(branchFromConditionalNode(current));
    current = alternativeNode(current);
  }

  return branches;
}

function branchFromConditionalNode(node: Parser.SyntaxNode): Branch {
  const condition = node.childForFieldName('condition') ?? undefined;
  const name = node.childForFieldName('name') ?? undefined;
  return {
    condition,
    name,
    directiveText: firstLine(node.text),
    content: node.namedChildren.filter((child) => (
      child.id !== condition?.id
      && child.id !== name?.id
      && child.id !== alternativeNode(node)?.id
    ))
  };
}

function alternativeNode(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  return node.childForFieldName('alternative') ?? undefined;
}

function evaluateBranchCondition(branch: Branch, macros: MacroDefinitions): Activity {
  if (branch.condition !== undefined) {
    const value = evaluateExpression(branch.condition, macros);
    return value === undefined ? undefined : value !== 0;
  }

  if (branch.name === undefined) {
    return true;
  }

  const isDefined = macroDefined(branch.name.text, macros);
  if (isDefined === undefined) { return undefined; }
  return isNegativeDirective(branch.directiveText) ? !isDefined : isDefined;
}

function applyPreprocessorMutation(node: Parser.SyntaxNode, macros: MacroDefinitions): void {
  if (node.type === 'preproc_def' || node.type === 'preproc_function_def') {
    const nameNode = node.childForFieldName('name');
    if (nameNode !== null && !isSystemMacroName(nameNode.text)) {
      macros.set(nameNode.text, { value: node.childForFieldName('value')?.text.trim() });
    }
    return;
  }

  if (node.type === 'preproc_call' && /^#[ \t]*undef\b/.test(firstLine(node.text))) {
    const argumentNode = node.childForFieldName('argument');
    const name = argumentNode?.text.trim().match(/^[A-Za-z_$][0-9A-Za-z_$]*/)?.[0];
    if (name !== undefined && !isSystemMacroName(name)) {
      macros.delete(name);
    }
  }
}

function evaluateExpression(node: Parser.SyntaxNode, macros: MacroDefinitions): number | undefined {
  switch (node.type) {
    case 'identifier':
      if (node.text === '__LINE__') { return node.startPosition.row + 1; }
      return numericMacroValue(macros.get(node.text));
    case 'number_literal':
      return parseInteger(node.text);
    case 'char_literal':
      return node.text.length > 2 ? node.text.codePointAt(1) ?? 0 : 0;
    case 'preproc_defined': {
      const name = node.namedChildren.find(child => child.type === 'identifier')?.text;
      const defined = macroDefined(name ?? '', macros);
      return defined === undefined ? undefined : defined ? 1 : 0;
    }
    case 'parenthesized_expression':
      return node.namedChildren[0] === undefined ? 0 : evaluateExpression(node.namedChildren[0], macros);
    case 'unary_expression':
      return evaluateUnaryExpression(node, macros);
    case 'binary_expression':
      return evaluateBinaryExpression(node, macros);
    case 'call_expression':
      return numericMacroValue(macros.get(node.childForFieldName('function')?.text ?? ''));
    default:
      return undefined;
  }
}

function evaluateUnaryExpression(node: Parser.SyntaxNode, macros: MacroDefinitions): number | undefined {
  const operator = node.childForFieldName('operator')?.text ?? node.children.find((child) => !child.isNamed)?.text;
  const argument = node.childForFieldName('argument') ?? node.namedChildren[0];
  const value = argument === undefined ? 0 : evaluateExpression(argument, macros);
  if (value === undefined) { return undefined; }
  switch (operator) {
    case '!':
      return value === 0 ? 1 : 0;
    case '~':
      return ~value;
    case '-':
      return -value;
    case '+':
      return value;
    default:
      return undefined;
  }
}

function evaluateBinaryExpression(node: Parser.SyntaxNode, macros: MacroDefinitions): number | undefined {
  const [leftNode, rightNode] = node.namedChildren;
  if (leftNode === undefined || rightNode === undefined) {
    return 0;
  }

  const operator = node.children.find((child) => !child.isNamed && /\S/.test(child.text))?.text;
  const left = evaluateExpression(leftNode, macros);
  const right = evaluateExpression(rightNode, macros);
  if (operator === '&&') {
    if (left === 0 || right === 0) { return 0; }
    return left === undefined || right === undefined ? undefined : 1;
  }
  if (operator === '||') {
    if ((left !== undefined && left !== 0) || (right !== undefined && right !== 0)) { return 1; }
    return left === undefined || right === undefined ? undefined : 0;
  }
  if (left === undefined || right === undefined) { return undefined; }
  switch (operator) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return right === 0 ? 0 : Math.trunc(left / right);
    case '%':
      return right === 0 ? 0 : left % right;
    case '==':
      return left === right ? 1 : 0;
    case '!=':
      return left !== right ? 1 : 0;
    case '>':
      return left > right ? 1 : 0;
    case '>=':
      return left >= right ? 1 : 0;
    case '<':
      return left < right ? 1 : 0;
    case '<=':
      return left <= right ? 1 : 0;
    case '&':
      return left & right;
    case '|':
      return left | right;
    case '^':
      return left ^ right;
    case '<<':
      return left << right;
    case '>>':
      return left >> right;
    default:
      return undefined;
  }
}

function macroDefined(name: string, macros: MacroDefinitions): Activity {
  const definition = macros.get(name);
  return definition?.possiblyUndefined ? undefined : definition !== undefined;
}

function numericMacroValue(definition: MacroDefinition | undefined): number | undefined {
  if (definition === undefined) {
    return 0;
  }

  if (definition.possiblyUndefined || definition.unknownValue) { return undefined; }

  if (definition.value === undefined || definition.value === '') {
    return 1;
  }

  return parseInteger(definition.value);
}

function parseInteger(text: string): number | undefined {
  const match = text.trim().match(/^0[xX][0-9a-fA-F]+|^0[0-7]+|^[0-9]+/);
  if (match === null) {
    return undefined;
  }

  return Number.parseInt(match[0], match[0].startsWith('0x') || match[0].startsWith('0X') ? 16 : 10);
}

function isPreprocessorConditional(node: Parser.SyntaxNode): boolean {
  return PREPROCESSOR_IF_NODE_TYPES.has(node.type);
}

function isNegativeDirective(text: string): boolean {
  return /^#[ \t]*ifn(?:def)?\b|^#[ \t]*elifn(?:def)?\b/.test(text);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? '';
}

function macroDefinitionsFromSymbols(symbols: readonly AnalysisPreprocessorSymbol[]): MacroDefinitions {
  return new Map(symbols.filter(symbol => !isSystemMacroName(symbol.name) && symbol.sourceRange === undefined).map((symbol) => [symbol.name, {
    value: symbol.value,
    possiblyUndefined: symbol.possiblyUndefined,
    unknownValue: symbol.unknownValue
  }]));
}
