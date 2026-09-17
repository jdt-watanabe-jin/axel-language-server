import type * as Parser from 'tree-sitter';
import { message } from '../i18n/messages';
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
    isSyntaxErrorNode
  );

  return errorNodes.flatMap((node) => diagnosticsForSyntaxNode(node, options));
}

function diagnosticsForSyntaxNode(
  node: Parser.SyntaxNode,
  options: SyntaxDiagnosticOptions
): AnalysisDiagnostic[] {
  const defaultDiagnostic: AnalysisDiagnostic = {
    severity: 'error',
    source: 'axel',
    ...(node.type === 'unterminated_comment' ? message('Missing {0}.', '*/')
      : node.isMissing ? message('Missing {0}.', node.type) : message('Syntax error.')),
    range: nodeToAnalysisRange(node)
  };
  if (node.isMissing || options.parseText === undefined || options.macroDefinitions === undefined) {
    return [defaultDiagnostic];
  }

  const invocation = macroInvocationCandidateFromErrorNode(node);
  if (invocation === undefined) {
    return [defaultDiagnostic];
  }

  const macroLookup = createMacroLookup(
    options.macroDefinitions,
    options.uri,
    invocation.range.start
  );
  const macro = macroLookup.findMacro(invocation.name);
  if (macro === undefined || macro.parameters === undefined) {
    return [defaultDiagnostic];
  }

  const expansion = expandMacroInvocation(invocation, macro, macroLookup);
  if (expansion.diagnostics.length > 0) {
    return expansion.diagnostics.map((diagnostic) => ({
      severity: 'error',
      source: 'axel',
      message: diagnostic.message,
      messageDescriptor: diagnostic.messageDescriptor,
      range: invocation.range
    }));
  }

  if (!expansion.truncated && expansionParsesInContext(expansion.expandedText, invocation, options.parseText)) {
    return [];
  }

  return [defaultDiagnostic];
}

const macroNameIndexes = new WeakMap<readonly AnalysisMacroDefinition[], Map<string, AnalysisMacroDefinition[]>>();

export function createMacroLookup(
  macros: readonly AnalysisMacroDefinition[],
  sourceUri?: AnalysisDocumentUri,
  position?: AnalysisMacroDefinition['selectionRange']['start']
): MacroLookup {
  let byName = macroNameIndexes.get(macros);
  if (!byName) {
    byName = new Map();
    for (const macro of macros) {
      const entries = byName.get(macro.name) ?? [];
      entries.push(macro); byName.set(macro.name, entries);
    }
    macroNameIndexes.set(macros, byName);
  }
  return {
    findMacro: name => byName.get(name)?.findLast(macro => macroIsVisibleAtPosition(macro, sourceUri, position))
  };
}

function macroIsVisibleAtPosition(
  macro: AnalysisMacroDefinition,
  sourceUri: AnalysisDocumentUri | undefined,
  position: AnalysisMacroDefinition['selectionRange']['start'] | undefined
): boolean {
  if (position === undefined) {
    return true;
  }

  const visibilityStart = macro.visibilityStart
    ?? (macro.uri === sourceUri ? macro.range.end : undefined);
  return visibilityStart === undefined || comparePositions(visibilityStart, position) <= 0;
}

function comparePositions(
  left: AnalysisMacroDefinition['selectionRange']['start'],
  right: AnalysisMacroDefinition['selectionRange']['start']
): number {
  return left.line - right.line || left.character - right.character;
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
  return findNamedNodes(rootNode, isSyntaxErrorNode).length === 0;
}

function isSyntaxErrorNode(node: Parser.SyntaxNode): boolean {
  return node.type === 'ERROR' || node.type === 'unterminated_comment' || node.isMissing;
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
