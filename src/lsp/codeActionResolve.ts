import { createHmac, randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { ErrorCodes, LSPErrorCodes, ResponseError, type ClientCapabilities, type CodeAction } from 'vscode-languageserver/node';
import { getCodeActionCandidates, getCodeActions, type CodeActionInput } from '../analyzer/codeActions';
import { toLspCodeActions } from './codeActions';
import { toLspDiagnostic } from './diagnostics';
import { toLspWorkspaceEdit } from './rename';

export function supportsCodeActionResolve(client?: ClientCapabilities): boolean {
  const action = client?.textDocument?.codeAction;
  return action?.dataSupport === true && action.resolveSupport?.properties.includes('edit') === true;
}

interface ResolveContext {
  documentVersion(uri: string): number | undefined;
  analysisGeneration(uri: string): unknown;
  revision(): number;
}
interface Batch {
  uri: string;
  version: number;
  generation: unknown;
  revision: number;
  documentChanges: boolean;
  items: { original: CodeAction; resolveEdit: () => CodeAction['edit'] }[];
}
interface Identity { session: string; id: number; index: number; signature: string }

/** At most eight batches retain analysis candidates. Signed identities distinguish forgery from eviction. */
export class CodeActionResolveStore {
  private readonly session = randomUUID();
  private readonly secret = randomUUID();
  private next = 0;
  private readonly batches = new Map<number, Batch>();

  constructor(private readonly context: ResolveContext) {}

  clear(): void { this.batches.clear(); }

  actions(input: CodeActionInput, version: number, capabilities?: ClientCapabilities): CodeAction[] {
    if (!supportsCodeActionResolve(capabilities)) {
      return toLspCodeActions(getCodeActions(input), input.locale);
    }
    const candidates = getCodeActionCandidates(input);
    if (!candidates.length) { return []; }
    const revision = this.context.revision();
    for (const [id, batch] of this.batches) {
      if (batch.revision !== revision) { this.batches.delete(id); }
    }
    const id = ++this.next;
    const items = candidates.map((candidate, index) => ({
      original: {
        title: candidate.title,
        kind: candidate.kind,
        diagnostics: candidate.diagnostics.map(diagnostic => toLspDiagnostic(diagnostic, input.locale)),
        data: { session: this.session, id, index, signature: this.sign(id, index) }
      },
      resolveEdit: () => toLspWorkspaceEdit(candidate.resolveEdit())
    }));
    this.batches.set(id, { uri: input.analysis.uri, version, revision,
      documentChanges: capabilities?.workspace?.workspaceEdit?.documentChanges === true,
      generation: this.context.analysisGeneration(input.analysis.uri), items });
    while (this.batches.size > 8) { this.batches.delete(this.batches.keys().next().value!); }
    // Keep the bound originals independent of any client-side mutations.
    return items.map(item => structuredClone(item.original));
  }

  resolve(action: CodeAction): CodeAction {
    const data: unknown = action?.data;
    if (!data || typeof data !== 'object') { return this.invalid(); }
    const identity = data as Identity;
    if (identity.session !== this.session || !Number.isSafeInteger(identity.id) || identity.id < 1 ||
        !Number.isSafeInteger(identity.index) || identity.index < 0 ||
        identity.signature !== this.sign(identity.id, identity.index)) { return this.invalid(); }
    const batch = this.batches.get(identity.id);
    if (!batch || batch.revision !== this.context.revision() ||
        this.context.documentVersion(batch.uri) !== batch.version ||
        this.context.analysisGeneration(batch.uri) !== batch.generation) {
      this.batches.delete(identity.id);
      throw new ResponseError(LSPErrorCodes.ContentModified, 'Code action source or dependencies changed.');
    }
    const item = batch.items[identity.index];
    if (!item || action.title !== item.original.title || action.kind !== item.original.kind ||
        !isDeepStrictEqual(action.diagnostics, item.original.diagnostics) || action.command !== undefined) {
      return this.invalid();
    }
    const edit = item.resolveEdit();
    if (batch.documentChanges && edit?.changes) {
      return { ...action, edit: { documentChanges: Object.entries(edit.changes).map(([uri, edits]) => ({
        textDocument: { uri, version: uri === batch.uri ? batch.version : null }, edits
      })) } };
    }
    return { ...action, edit };
  }

  private sign(id: number, index: number): string {
    return createHmac('sha256', this.secret).update(`${id}:${index}`).digest('hex');
  }

  private invalid(): never {
    throw new ResponseError(ErrorCodes.InvalidParams, 'Invalid code action resolve identity.');
  }
}
