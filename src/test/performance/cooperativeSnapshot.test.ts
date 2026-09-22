import * as assert from 'assert';
import { CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { createAxelParser } from '../../analyzer/axelParser';
import { getSourceSyntaxFacts } from '../../analyzer/sourceSyntaxFacts';
import { buildTypeSnapshot, type TypeSnapshot, type TypeNode } from '../../analyzer/typeChecking/syntax';
import { runAnalysisSteps, runAnalysisStepsAsync, type AnalysisStep } from '../../util/analysisSteps';

suite('Cooperative type snapshots', () => {
  test('yields inside a large traversal and never publishes a cancelled snapshot', async () => {
    const root = createAxelParser().parse(Array.from({length: 3000}, (_, i) => 'int value' + i + ';').join('\n')).rootNode;
    const facts = getSourceSyntaxFacts(root, 'file:///large.axl') as ReturnType<typeof getSourceSyntaxFacts> & {
      typeSnapshotSteps?: (replacements: readonly TypeNode[]) => Generator<AnalysisStep, TypeSnapshot, void>;
    };
    assert.strictEqual(typeof facts.typeSnapshotSteps, 'function');
    const source = new CancellationTokenSource();
    const steps = facts.typeSnapshotSteps!([]);
    assert.strictEqual(steps.next().done, false);
    source.cancel();
    await assert.rejects(runAnalysisStepsAsync(steps, source.token), {code: LSPErrorCodes.RequestCancelled});
    source.dispose();
    let yields = 0;
    const retry = facts.typeSnapshotSteps!([]);
    let next = retry.next();
    while (!next.done) { yields++; next = retry.next(); }
    assert.ok(yields > 10, 'Retry must rebuild the cancelled traversal cooperatively');
    assert.deepStrictEqual(next.value, buildTypeSnapshot(root, 'file:///large.axl'));
    assert.strictEqual(runAnalysisSteps(facts.typeSnapshotSteps!([])), next.value);
  });
});
