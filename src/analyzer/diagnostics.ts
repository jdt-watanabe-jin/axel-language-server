import type * as Parser from 'tree-sitter';
import type { AnalysisDiagnostic, AnalysisDocumentUri, AnalysisMacroDefinition } from '../types/analysis';
import { expandMacroInvocation, type MacroLookup } from './macroExpansion';
import { macroInvocationCandidateFromErrorNode, type MacroInvocationCandidate } from './macroInvocation';
import { findNamedNodes, nodeToAnalysisRange } from './syntaxTree';

export interface SyntaxDiagnosticOptions {
  uri?: AnalysisDocumentUri;
  macroDefinitions?: readonly AnalysisMacroDefinition[];
  parseText?: (text: string) => Parser.SyntaxNode;
}

export function collectSyntaxDiagnostics(
  rootNode: Parser.SyntaxNode,
  options: SyntaxDiagnosticOptions = {}
): AnalysisDiagnostic[] {
  const errorNodes = findNamedNodes(
    rootNode,
    (node) => node.type === 'ERROR' || node.isMissing
  );

  return errorNodes
    .filter((node) => !shouldSuppressMacroSyntaxError(node, options))
    .map((node) => ({
      severity: 'error',
      source: 'axel',
      message: node.isMissing ? `Missing ${node.type}.` : 'Syntax error.',
      range: nodeToAnalysisRange(node)
    }));
}

function shouldSuppressMacroSyntaxError(
  node: Parser.SyntaxNode,
  options: SyntaxDiagnosticOptions
): boolean {
  if (node.isMissing || options.parseText === undefined || options.macroDefinitions === undefined) {
    return false;
  }

  const invocation = macroInvocationCandidateFromErrorNode(node);
  if (invocation === undefined) {
    return false;
  }

  const macroLookup = createMacroLookup(options.macroDefinitions);
  const macro = macroLookup.findMacro(invocation.name, invocation.arguments.length);
  if (macro === undefined || macro.parameters === undefined) {
    return false;
  }

  const expansion = expandMacroInvocation(invocation, macro, macroLookup);
  if (expansion.truncated || expansion.diagnostics.length > 0) {
    return false;
  }

  return expansionParsesInContext(expansion.expandedText, invocation, options.parseText);
}

export function createMacroLookup(macros: readonly AnalysisMacroDefinition[]): MacroLookup {
  return {
    findMacro: (name, arity) => macros
      .filter((macro) => macro.name === name)
      .filter((macro) => arity === undefined || macro.parameters?.length === arity)
      .at(-1)
  };
}

function expansionParsesInContext(
  expandedText: string,
  invocation: MacroInvocationCandidate,
  parseText: (text: string) => Parser.SyntaxNode
): boolean {
  const probeText = probeTextForContext(expandedText, invocation.context);
  if (probeText === undefined) {
    return false;
  }

  const rootNode = parseText(probeText);
  return findNamedNodes(rootNode, (node) => node.type === 'ERROR' || node.isMissing).length === 0;
}

function probeTextForContext(text: string, context: MacroInvocationCandidate['context']): string | undefined {
  switch (context) {
    case 'classBody':
      return `class __MacroProbe { ${text} };`;
    case 'block':
      return `void __macro_probe() { ${text} }`;
    case 'topLevel':
      return text;
    case 'unknown':
      return undefined;
  }
}
