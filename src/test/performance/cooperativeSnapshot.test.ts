import * as assert from 'assert';
import { CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { createAxelParser } from '../../analyzer/axelParser';
import { getSourceSyntaxFacts } from '../../analyzer/sourceSyntaxFacts';
import { runAnalysisSteps, runAnalysisStepsAsync } from '../../util/analysisSteps';

suite('Cooperative type snapshots', () => {
  test('yields inside a large traversal and never publishes a cancelled snapshot', async () => {
    const root = createAxelParser().parse(Array.from({length: 3000}, (_, i) => 'int value' + i + ';').join('\n')).rootNode;
    const facts = getSourceSyntaxFacts(root, 'file:///large.axl');
    const source = new CancellationTokenSource();
    const steps = facts.typeSnapshotSteps([]);
    assert.strictEqual(steps.next().done, false);
    source.cancel();
    await assert.rejects(runAnalysisStepsAsync(steps, source.token), {code: LSPErrorCodes.RequestCancelled});
    source.dispose();
    let yields = 0;
    const retry = facts.typeSnapshotSteps([]);
    let next = retry.next();
    while (!next.done) { yields++; next = retry.next(); }
    assert.ok(yields > 10, 'Retry must rebuild the cancelled traversal cooperatively');
    assert.strictEqual(next.value.root.children.length, 3000);
    assert.strictEqual(next.value.root.children[0].text, 'int value0;');
    assert.strictEqual(next.value.root.children[2999].text, 'int value2999;');
    assert.strictEqual(runAnalysisSteps(facts.typeSnapshotSteps([])), next.value);
  });
});
