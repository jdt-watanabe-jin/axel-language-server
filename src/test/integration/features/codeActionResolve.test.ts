import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { ErrorCodes, LSPErrorCodes, type ClientCapabilities, type CodeAction } from 'vscode-languageserver/node';
import * as analyzer from '../../../analyzer/codeActions';
import { CodeActionResolveStore } from '../../../lsp/codeActionResolve';
import { useWorkspaceFixtures } from '../../support/workspace';

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
const supported: ClientCapabilities = { textDocument: { codeAction: { dataSupport: true, resolveSupport: { properties: ['edit'] } } } };

suite('Code action resolve', () => {
  function fixture() {
    const directory = createTempDir();
    const header = path.join(directory, 'types.h');
    fs.writeFileSync(header, 'class Widget {};');
    const index = createWorkspaceIndex();
    index.indexDiskDocument(header);
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const analysis = index.indexOpenDocument({ uri, version: 1, text: 'Widget widget;' });
    const input: analyzer.CodeActionInput = { analysis, diagnostics: analysis.diagnostics,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, workspaceIndex: index };
    let version: number | undefined = 1;
    let revision = 0;
    let generation: unknown = analysis;
    const store = new CodeActionResolveStore({ documentVersion: () => version, revision: () => revision,
      analysisGeneration: () => generation });
    return { store, input, uri, setVersion: (value?: number) => { version = value; },
      invalidate: () => { revision++; }, reanalyze: () => { generation = {}; } };
  }

  test('defers edit computation and adds only edit during resolve', () => {
    const { store, input, uri } = fixture();
    const module = analyzer as { getCodeActionCandidates: typeof analyzer.getCodeActionCandidates };
    const original = module.getCodeActionCandidates;
    let computations = 0;
    module.getCodeActionCandidates = ((value: analyzer.CodeActionInput) => original(value).map(candidate => ({
      ...candidate, resolveEdit: () => { computations++; return candidate.resolveEdit(); }
    }))) as typeof original;
    try {
      const action = store.actions(input, 1, supported)[0];
      assert.deepStrictEqual(Object.keys(action).sort(), ['data', 'diagnostics', 'kind', 'title']);
      assert.strictEqual(computations, 0);
      const returned = { ...action, isPreferred: true };
      const resolved = store.resolve(returned);
      assert.strictEqual(computations, 1);
      assert.deepStrictEqual(resolved, { ...returned, edit: { changes: { [uri]: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: '#include "types.h"\n'
      }] } } });
    } finally { module.getCodeActionCandidates = original; }
  });

  test('keeps eager behavior unless both data and edit resolution are supported', () => {
    const { store, input } = fixture();
    for (const capabilities of [undefined, {}, { textDocument: { codeAction: { dataSupport: true } } },
      { textDocument: { codeAction: { resolveSupport: { properties: ['edit'] } } } },
      { textDocument: { codeAction: { dataSupport: true, resolveSupport: { properties: ['command'] } } } }]) {
      const action = store.actions(input, 1, capabilities)[0];
      assert.ok(action.edit);
      assert.strictEqual(action.data, undefined);
    }
    assert.ok(analyzer.getCodeActions(input)[0].edit);
  });

  test('versions resolved edits only when documentChanges is supported', () => {
    const { store, input, uri } = fixture();
    for (const documentChanges of [true, false, undefined]) {
      const capabilities: ClientCapabilities = { ...supported, workspace: { workspaceEdit: { documentChanges } } };
      const action = store.actions(input, 1, capabilities)[0];
      assert.strictEqual(action.edit, undefined);
      const resolved = store.resolve(action);
      const edits = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: '#include "types.h"\n' }];
      assert.deepStrictEqual(resolved.edit, documentChanges ? {
        documentChanges: [{ textDocument: { uri, version: 1 }, edits }]
      } : { changes: { [uri]: edits } });
    }
    const eager = store.actions(input, 1, { workspace: { workspaceEdit: { documentChanges: true } } })[0];
    assert.ok(eager.edit?.changes);
    assert.strictEqual(eager.edit?.documentChanges, undefined);
  });

  test('rejects forged identity and invalid indexes', () => {
    const { store, input } = fixture();
    const action = store.actions(input, 1, supported)[0];
    for (const data of [undefined, {}, { ...action.data, session: 'forged' },
      { ...action.data, id: 999999 }, { ...action.data, index: -1 }, { ...action.data, index: 99 }]) {
      assert.throws(() => store.resolve({ ...action, data }), errorCode(ErrorCodes.InvalidParams));
    }
  });

  test('rejects altered bound action fields without corrupting the original', () => {
    const { store, input } = fixture();
    const action = store.actions(input, 1, supported)[0];
    for (const changed of [{ ...action, title: 'Forged' }, { ...action, kind: 'refactor' },
      { ...action, diagnostics: [] }, { ...action, command: { title: 'Injected', command: 'injected' } }]) {
      assert.throws(() => store.resolve(changed), errorCode(ErrorCodes.InvalidParams));
    }
    const original = structuredClone(action);
    action.diagnostics![0].message = 'mutated';
    assert.throws(() => store.resolve(action), errorCode(ErrorCodes.InvalidParams));
    assert.ok(store.resolve(original).edit);
  });

  test('rejects document edits, closure, same-version reanalysis and dependency/configuration revisions', () => {
    for (const invalidate of [(f: ReturnType<typeof fixture>) => f.setVersion(2),
      (f: ReturnType<typeof fixture>) => f.setVersion(), (f: ReturnType<typeof fixture>) => f.reanalyze(),
      (f: ReturnType<typeof fixture>) => f.invalidate(), (f: ReturnType<typeof fixture>) => f.store.clear()]) {
      const f = fixture();
      const action = f.store.actions(f.input, 1, supported)[0];
      invalidate(f);
      assert.throws(() => f.store.resolve(action), errorCode(LSPErrorCodes.ContentModified));
    }
  });

  test('bounds retained batches and treats evicted issued identities as stale', () => {
    const { store, input } = fixture();
    const action: CodeAction = store.actions(input, 1, supported)[0];
    for (let count = 0; count < 20; count++) { store.actions(input, 1, supported); }
    assert.throws(() => store.resolve(action), errorCode(LSPErrorCodes.ContentModified));
  });
});
function errorCode(code: number) {
  return (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
