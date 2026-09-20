import type { CancellationToken } from 'vscode-languageserver/node';
import type { AnalyzeDocumentInput } from '../../types/analysis';
import type { WorkspaceSymbolEntry } from './model';
import type { AnalysisSymbol, AnalysisGuiPart, AnalysisRange } from '../../types/analysis';
import { createAxelParser } from '../axelParser';
import { collectDocumentSymbols } from '../documentSymbols';
import { buildGuiIndex, collectExternalGuiMethods } from '../guiIndex';
import { evaluatePreprocessor } from '../preprocessorEvaluation';
import { conditionalReparse } from '../conditionalReparse';
import { nodeToAnalysisRange } from '../syntaxTree';
import { containsSourcePosition } from '../systemMacros';
import { cancellationCheckpoint } from '../../util/cancellation';

export async function extractWorkspaceSymbols(input: AnalyzeDocumentInput, token: CancellationToken): Promise<WorkspaceSymbolEntry[]> {
  await cancellationCheckpoint(token);
  const parser = createAxelParser();
  let root = parser.parse(input.text).rootNode;
  // Unknown includes may affect names in later conditions. Feed provenance into the
  // existing evaluator so explicit #define/#undef still override this uncertainty.
  const conditionNames = new Set(root.descendantsOfType(['preproc_if', 'preproc_ifdef', 'preproc_elif', 'preproc_elifdef']).flatMap(node => {
    const operand = node.childForFieldName('condition') ?? node.childForFieldName('name');
    return operand ? [operand, ...operand.descendantsOfType('identifier')].filter(n => n.type === 'identifier').map(n => n.text) : [];
  }));
  const symbols = [...input.preprocessorSymbols ?? [], ...root.descendantsOfType('preproc_include').flatMap(node =>
    [...conditionNames].map(name => ({ name, possiblyUndefined: true, unknownValue: true, sourceRange: nodeToAnalysisRange(node) })))];
  const configured = { ...input, preprocessorSymbols: symbols };
  await cancellationCheckpoint(token);
  const recovered = root.hasError ? conditionalReparse(configured, text => parser.parse(text)) : undefined;
  if (recovered) { root = parser.parse(recovered.text).rootNode; }
  const evaluation = recovered?.evaluation ?? evaluatePreprocessor(root, symbols, input.tool, input.targetPlatform, input.internalFeatures);
  await cancellationCheckpoint(token);
  const active = (item: { selectionRange?: AnalysisRange; range: AnalysisRange }): boolean =>
    !evaluation.inactiveRanges.some(range => containsSourcePosition(range, (item.selectionRange ?? item.range).start));
  const activeParts = (parts: AnalysisGuiPart[]): AnalysisGuiPart[] => parts.filter(active).map(part => ({
    ...part, parts: activeParts(part.parts), methods: part.methods.filter(active)
  }));
  const guiClasses = buildGuiIndex(root, input.uri).filter(active).map(guiClass => ({
    ...guiClass, parts: activeParts(guiClass.parts), methods: guiClass.methods.filter(active)
  }));
  const guiMethods = collectExternalGuiMethods(root).filter(active);
  const positionKey = (range: AnalysisRange): string => `${range.start.line}:${range.start.character}`;
  const guiNames = new Map<string, { qualifiedName: string; containerName: string }>();
  const receiverName = (receiverPath: string[]) => {
    const containerName = receiverPath[0] + (receiverPath.length > 2 ? `::${receiverPath.slice(1, -1).join('.')}` : '');
    return { qualifiedName: `${containerName}::${receiverPath[receiverPath.length - 1]}`, containerName };
  };
  for (const guiClass of guiClasses) {
    const pendingParts = [...guiClass.parts];
    while (pendingParts.length) {
      const part = pendingParts.pop()!;
      pendingParts.push(...part.parts);
      if (part.name && !part.anonymous && part.selectionRange) {
        guiNames.set(positionKey(part.selectionRange), { qualifiedName: `${guiClass.name}::${part.path.join('.')}`,
          containerName: part.path.length > 1 ? `${guiClass.name}::${part.path.slice(0, -1).join('.')}` : guiClass.name });
      }
      for (const method of part.methods) {
        if (method.selectionRange) { guiNames.set(positionKey(method.selectionRange), receiverName(method.receiverPath)); }
      }
    }
  }
  for (const method of guiMethods) {
    if (method.selectionRange) { guiNames.set(positionKey(method.selectionRange), receiverName(method.receiverPath)); }
  }
  await cancellationCheckpoint(token);
  const outline = collectDocumentSymbols(root, { guiClasses, guiMethods, excludedRanges: evaluation.inactiveRanges, allDeclarators: true });
  const qualifiedNodes = new Map(root.descendantsOfType('qualified_declarator').map(node =>
    [`${node.startPosition.row}:${node.startPosition.column}`, node]));
  const entries: WorkspaceSymbolEntry[] = [];
  const pending: { symbol: AnalysisSymbol; owner: string }[] = outline.map(symbol => ({ symbol, owner: '' })).reverse();
  while (pending.length) {
    if (entries.length % 128 === 0) { await cancellationCheckpoint(token); }
    const { symbol, owner } = pending.pop()!;
    if (symbol.kind === 'include' || symbol.kind === 'parameter' || !symbol.name.trim()
      || evaluation.inactiveRanges.some(range => containsSourcePosition(range, symbol.selectionRange.start))) { continue; }
    let qualifiedName = owner ? `${owner}::${symbol.name}` : symbol.name;
    let name = symbol.name; let containerName = owner || undefined;
    let kind = symbol.kind;
    let selectionRange = symbol.selectionRange;
    // An external method without a local owner retains a qualified outline name.
    const qualified = !owner ? qualifiedNodes.get(`${selectionRange.start.line}:${selectionRange.start.character}`) : undefined;
    if (qualified) {
      const members = qualified.children.filter((_, index) => qualified.fieldNameForChild(index) === 'name');
      const scope = qualified.childForFieldName('scope');
      if (scope && members.length) {
        const first = members[0]; const last = members[members.length - 1];
        name = qualified.text.slice(first.startIndex - qualified.startIndex, last.endIndex - qualified.startIndex).replace(/\s+/g, ' ').trim();
        containerName = scope.text.replace(/\s+/g, '');
        const instance = qualified.childForFieldName('instance');
        if (instance) { containerName += `::${instance.text.replace(/\s+/g, '')}`; kind = 'method'; }
        qualifiedName = `${containerName}::${name}`;
        selectionRange = { start: nodeToAnalysisRange(first).start, end: nodeToAnalysisRange(last).end };
      }
    }
    const guiName = guiNames.get(positionKey(selectionRange));
    if (guiName) { qualifiedName = guiName.qualifiedName; containerName = guiName.containerName; }
    entries.push({ name, qualifiedName, containerName, kind, uri: input.uri, selectionRange });
    if (!['function', 'method', 'operator', 'constructor'].includes(symbol.kind)) {
      for (const child of [...symbol.children ?? []].reverse()) { pending.push({ symbol: child, owner: qualifiedName }); }
    }
  }
  return entries;
}
