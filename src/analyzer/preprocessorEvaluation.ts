import type * as Parser from 'tree-sitter';
import type { AnalysisPreprocessorSymbol, AnalysisRange } from '../types/analysis';
import { nodeToAnalysisRange } from './syntaxTree';

interface MacroDefinition {
  value?: string;
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

export function collectInactivePreprocessorRanges(
  rootNode: Parser.SyntaxNode,
  predefinedSymbols: readonly AnalysisPreprocessorSymbol[] = []
): AnalysisRange[] {
  const inactiveRanges: AnalysisRange[] = [];
  visitActiveChildren(rootNode.namedChildren, macroDefinitionsFromSymbols(predefinedSymbols), inactiveRanges, true);
  return inactiveRanges;
}

function visitActiveChildren(
  children: readonly Parser.SyntaxNode[],
  macros: MacroDefinitions,
  inactiveRanges: AnalysisRange[],
  parentActive: boolean
): void {
  for (const child of children) {
    visitNode(child, macros, inactiveRanges, parentActive);
  }
}

function visitNode(
  node: Parser.SyntaxNode,
  macros: MacroDefinitions,
  inactiveRanges: AnalysisRange[],
  active: boolean
): void {
  if (isPreprocessorConditional(node)) {
    visitConditional(node, macros, inactiveRanges, active);
    return;
  }

  if (!active) {
    inactiveRanges.push(nodeToAnalysisRange(node));
    return;
  }

  applyPreprocessorMutation(node, macros);
  visitActiveChildren(node.namedChildren, macros, inactiveRanges, active);
}

function visitConditional(
  node: Parser.SyntaxNode,
  macros: MacroDefinitions,
  inactiveRanges: AnalysisRange[],
  parentActive: boolean
): void {
  let branchAlreadyTaken = false;
  for (const branch of branchesFromConditional(node)) {
    const branchCondition = branch.condition === undefined && branch.name === undefined
      ? true
      : evaluateBranchCondition(branch, macros);
    const branchActive = parentActive && !branchAlreadyTaken && branchCondition;
    if (parentActive && branchCondition) {
      branchAlreadyTaken = true;
    }

    visitActiveChildren(branch.content, macros, inactiveRanges, branchActive);
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

function evaluateBranchCondition(branch: Branch, macros: MacroDefinitions): boolean {
  if (branch.condition !== undefined) {
    return evaluateExpression(branch.condition, macros) !== 0;
  }

  if (branch.name === undefined) {
    return true;
  }

  const isDefined = macros.has(branch.name.text);
  return isNegativeDirective(branch.directiveText) ? !isDefined : isDefined;
}

function applyPreprocessorMutation(node: Parser.SyntaxNode, macros: MacroDefinitions): void {
  if (node.type === 'preproc_def' || node.type === 'preproc_function_def') {
    const nameNode = node.childForFieldName('name');
    if (nameNode !== null) {
      macros.set(nameNode.text, { value: node.childForFieldName('value')?.text.trim() });
    }
    return;
  }

  if (node.type === 'preproc_call' && /^#[ \t]*undef\b/.test(firstLine(node.text))) {
    const argumentNode = node.childForFieldName('argument');
    const name = argumentNode?.text.trim().match(/^[A-Za-z_$][0-9A-Za-z_$]*/)?.[0];
    if (name !== undefined) {
      macros.delete(name);
    }
  }
}

function evaluateExpression(node: Parser.SyntaxNode, macros: MacroDefinitions): number {
  switch (node.type) {
    case 'identifier':
      return numericMacroValue(macros.get(node.text));
    case 'number_literal':
      return parseInteger(node.text);
    case 'char_literal':
      return node.text.length > 2 ? node.text.codePointAt(1) ?? 0 : 0;
    case 'preproc_defined':
      return definedIdentifier(node, macros) ? 1 : 0;
    case 'parenthesized_expression':
      return node.namedChildren[0] === undefined ? 0 : evaluateExpression(node.namedChildren[0], macros);
    case 'unary_expression':
      return evaluateUnaryExpression(node, macros);
    case 'binary_expression':
      return evaluateBinaryExpression(node, macros);
    case 'call_expression':
      return numericMacroValue(macros.get(node.childForFieldName('function')?.text ?? ''));
    default:
      return 0;
  }
}

function evaluateUnaryExpression(node: Parser.SyntaxNode, macros: MacroDefinitions): number {
  const operator = node.childForFieldName('operator')?.text ?? node.children.find((child) => !child.isNamed)?.text;
  const argument = node.childForFieldName('argument') ?? node.namedChildren[0];
  const value = argument === undefined ? 0 : evaluateExpression(argument, macros);
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
      return 0;
  }
}

function evaluateBinaryExpression(node: Parser.SyntaxNode, macros: MacroDefinitions): number {
  const [leftNode, rightNode] = node.namedChildren;
  if (leftNode === undefined || rightNode === undefined) {
    return 0;
  }

  const operator = node.children.find((child) => !child.isNamed && /\S/.test(child.text))?.text;
  if (operator === '&&') {
    return evaluateExpression(leftNode, macros) !== 0 && evaluateExpression(rightNode, macros) !== 0 ? 1 : 0;
  }

  if (operator === '||') {
    return evaluateExpression(leftNode, macros) !== 0 || evaluateExpression(rightNode, macros) !== 0 ? 1 : 0;
  }

  const left = evaluateExpression(leftNode, macros);
  const right = evaluateExpression(rightNode, macros);
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
      return 0;
  }
}

function definedIdentifier(node: Parser.SyntaxNode, macros: MacroDefinitions): boolean {
  return node.namedChildren.some((child) => child.type === 'identifier' && macros.has(child.text));
}

function numericMacroValue(definition: MacroDefinition | undefined): number {
  if (definition === undefined) {
    return 0;
  }

  if (definition.value === undefined || definition.value === '') {
    return 1;
  }

  return parseInteger(definition.value);
}

function parseInteger(text: string): number {
  const match = text.trim().match(/^0[xX][0-9a-fA-F]+|^0[0-7]+|^[0-9]+/);
  if (match === null) {
    return 0;
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
  return new Map(symbols.map((symbol) => [symbol.name, { value: symbol.value }]));
}
