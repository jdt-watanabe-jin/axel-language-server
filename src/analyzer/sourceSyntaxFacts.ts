import { runAnalysisSteps, type AnalysisStep } from '../util/analysisSteps';
import type * as Parser from 'tree-sitter';
import { collectMacroDefinitions } from './macroIndex';
import { collectSystemMacroSyntax } from './systemMacros';
import { buildTypeSnapshotSteps, type TypeNode, type TypeSnapshot } from './typeChecking/syntax';

/** Syntax-only facts: callers must not mutate these shared, completed values. */
export interface SourceSyntaxFacts {
  readonly macros: ReturnType<typeof collectMacroDefinitions>;
  readonly system: ReturnType<typeof collectSystemMacroSyntax>;
  typeSnapshot(replacements: readonly TypeNode[]): TypeSnapshot;
  typeSnapshotSteps(replacements: readonly TypeNode[]): Generator<AnalysisStep, TypeSnapshot, void>;
}

// Roots are generation-local. Clearing the analyzer's roots releases these entries too.
const factsByRoot = new WeakMap<Parser.SyntaxNode, Map<string, SourceSyntaxFacts>>();

export function getSourceSyntaxFacts(root: Parser.SyntaxNode, uri: string): SourceSyntaxFacts {
  let byUri = factsByRoot.get(root);
  const cached = byUri?.get(uri);
  if (cached) { return cached; }
  let macros: SourceSyntaxFacts['macros'] | undefined;
  let system: SourceSyntaxFacts['system'] | undefined;
  let previous: { replacements: readonly TypeNode[]; snapshot: TypeSnapshot } | undefined;
  const facts: SourceSyntaxFacts = {
    get macros() { return macros ??= collectMacroDefinitions(root, uri); },
    get system() { return system ??= collectSystemMacroSyntax(root); },
    typeSnapshot(replacements) { return runAnalysisSteps(facts.typeSnapshotSteps(replacements)); },
    *typeSnapshotSteps(replacements) {
      if (previous && previous.replacements.length === replacements.length
        && replacements.every((node, i) => node === previous!.replacements[i])) { return previous.snapshot; }
      const snapshot = yield* buildTypeSnapshotSteps(root, uri, replacements);
      previous = { replacements: [...replacements], snapshot };
      return snapshot;
    }
  };
  if (!byUri) { byUri = new Map(); factsByRoot.set(root, byUri); }
  byUri.set(uri, facts);
  return facts;
}
