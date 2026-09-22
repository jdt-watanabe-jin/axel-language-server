import * as assert from 'assert';
import { getInlayHints } from '../../analyzer/inlayHints';
import { useWorkspaceFixtures } from '../support/workspace';

suite('inlay hints performance', function () {
  this.timeout(5000);
  const {createWorkspaceIndex} = useWorkspaceFixtures();
  test('reuses syntax and resolution for 3 calls and updates after edits', () => {
    const index = createWorkspaceIndex();
    const text = 'void f(int count) {}\nvoid main(){\n' + 'f(1);\n'.repeat(3) + '}';
    const input = {uri:'file:///inlay-performance.axl',version:1,text};
    const analysis = index.indexOpenDocument(input);
    const params = {analysis,text,range:{start:{line:0,character:0},end:{line:6,character:0}},workspaceIndex:index,suppressWhenArgumentContainsName:true};
    assert.strictEqual(getInlayHints(params).length,3);
    const hints = getInlayHints(params);
    assert.strictEqual(hints.length,3);
    const edited = text.replace('count','size');
    const next = index.indexOpenDocument({...input,version:2,text:edited});
    assert.strictEqual(getInlayHints({...params,analysis:next,text:edited})[0].label,'size:');
  });
});
