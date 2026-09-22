import * as assert from 'assert';
import { WorkspaceIndex } from '../../analyzer/workspaceIndex';
suite('Rollback journal scaling', () => {
  test('does not copy untouched document entries when starting an analysis transaction', () => {
    const index = new WorkspaceIndex() as unknown as {
      documents: Map<string, object>; requestRevision: number;
      analysisRollback(revision: number): (() => void) & {commit?: () => void};
    };
    let copies = 0;
    for(let i=0;i<2000;i++) { index.documents.set('file:///' + i, {get analysis() { copies++; return {}; }}); }
    const rollback = index.analysisRollback(index.requestRevision);
    rollback.commit?.();
    assert.strictEqual(copies, 0, 'Transaction setup must not visit every document');
  });
});
