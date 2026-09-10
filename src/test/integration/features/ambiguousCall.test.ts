import * as assert from 'assert';
import { getDefinitions } from '../../../analyzer/navigation';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Ambiguous pointer argument calls', () => {
  const fixtures=useWorkspaceFixtures();
  function analyze(text: string) {
    const index=fixtures.createWorkspaceIndex();
    return {index,analysis:index.analyzeDocument({uri:'file:///calls.axl',version:1,text})};
  }
  test('resolves an address argument to a later function definition', () => {
    const {analysis,index}=analyze('void main(){int item; SetTestChildCheck(&item); } void SetTestChildCheck(int *p){}');
    assert.deepStrictEqual(analysis.diagnostics,[]);
    assert.strictEqual(analysis.declarations.filter(d=>d.name==='item').length,1);
    const call=analysis.references.find(r=>r.name==='SetTestChildCheck')!;
    assert.ok(call && !call.typeReference);
    assert.strictEqual(getDefinitions({analysis,position:analysis.references.find(r=>r.name==='item')!.range.start,workspaceIndex:index}).length,1);
  });
  test('resolves calls inside nested GUI handlers', () => {
    const {analysis}=analyze('class mainDlg : public GCDialog { GCListView list { void OnChanged(int item){SetTestChildCheck(&item);} }; void SetTestChildCheck(int *p){} };');
    assert.deepStrictEqual(analysis.diagnostics,[]);
  });
  test('checks argument types after disambiguation', () => {
    const {analysis}=analyze('void main(){int item; F(&item);} void F(int p){}');
    assert.ok(analysis.diagnostics.some(d=>d.code?.startsWith('axel.type.')));
    assert.ok(!analysis.diagnostics.some(d=>d.message.includes("Unknown type 'F'")));
  });
  test('supports dereference arguments and preserves pointer declarations', () => {
    const {analysis}=analyze('void main(){int item; int *p=&item; F(*p); int (*q); } void F(int x){}');
    assert.deepStrictEqual(analysis.diagnostics,[]);
    assert.strictEqual(analysis.declarations.filter(d=>d.name==='p').length,1);
    assert.ok(analysis.declarations.some(d=>d.name==='q'));
  });
});
