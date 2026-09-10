import * as assert from 'assert';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';

suite('Type checking: basic diagnostics', () => {
  function errors(text: string) {
    const index = new WorkspaceIndex();
    return index.analyzeDocument({uri:'file:///type-basic.axl',version:1,text}).diagnostics.filter(d=>d.severity==='error');

  }
  test('rejects integer zero as pointer initializer', () => {
    assert.ok(errors('void main(){int *p=0;}').length > 0);
  });
  test('accepts builtin NULL', () => {
    assert.strictEqual(errors('void main(){int *p=NULL;}').length, 0);
  });
  test('rejects non-callable values', () => {
    assert.ok(errors('void main(){int i=1; i();}').length > 0);
  });
  test('keeps const reassignment legal', () => {
    assert.strictEqual(errors('void main(){const int i=1; i=2;}').length, 0);
  });
  test('rejects invalid return even when runtime continues', () => {
    assert.ok(errors('int f(){return;}').length > 0);
  });
});
