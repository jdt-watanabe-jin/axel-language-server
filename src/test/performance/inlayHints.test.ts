import * as assert from 'assert';
import { getInlayHints } from '../../analyzer/inlayHints';
import { useWorkspaceFixtures } from '../support/workspace';

suite('inlay hints performance', function () {
  this.timeout(15000);
  const {createWorkspaceIndex} = useWorkspaceFixtures();
  test('reuses syntax and resolution for 5000 calls and updates after edits', () => {
    const index = createWorkspaceIndex();
    const text = 'void f(int count) {}\nvoid main(){\n' + 'f(1);\n'.repeat(5000) + '}';
    const input = {uri:'file:///inlay-performance.axl',version:1,text};
    const analysis = index.indexOpenDocument(input);
    const params = {analysis,text,range:{start:{line:0,character:0},end:{line:6000,character:0}},workspaceIndex:index,suppressWhenArgumentContainsName:true};
    assert.strictEqual(getInlayHints(params).length,5000);
    const start = performance.now();
    const hints = getInlayHints(params);
    const elapsed = performance.now()-start;
    console.log('      5000 cached inlay calls: ' + elapsed.toFixed(1) + 'ms');
    assert.strictEqual(hints.length,5000);
    assert.ok(elapsed < 1000,'cached inlay hints took ' + elapsed + 'ms');
    const edited = text.replace('count','size');
    const next = index.indexOpenDocument({...input,version:2,text:edited});
    assert.strictEqual(getInlayHints({...params,analysis:next,text:edited})[0].label,'size:');
  });
});
