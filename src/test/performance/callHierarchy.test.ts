import * as assert from 'assert';
import { CancellationTokenSource, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { prepareCallHierarchySteps, outgoingCallHierarchySteps, incomingCallHierarchySteps } from '../../analyzer/callHierarchy';
import { collectHierarchySymbols } from '../../analyzer/callHierarchySymbols';
import { runAnalysisSteps, runAnalysisStepsAsync } from '../../util/analysisSteps';

suite('Call hierarchy performance', () => {
  test('collects ownership for every declared function', () => {
    const analysis = new DocumentAnalyzer().analyzeDocument({uri:'file:///large.axl',version:1,
      text:Array.from({length:4},(_,i)=>`void function${i}() {}`).join('\n')});
    const symbols = runAnalysisSteps(collectHierarchySymbols(analysis,analysis.uri));
    assert.strictEqual(symbols.length,5);
  });

  test('reuses a completed graph while retaining the caller locations', () => {
    const analysis = new DocumentAnalyzer().analyzeDocument({uri:'file:///cache.axl',version:1,
      text:'void target() {}\nvoid main() { target(); target(); }'});
    const workspaceIndex = {};
    const item = runAnalysisSteps(prepareCallHierarchySteps({analysis,workspaceIndex,position:{line:1,character:5}}))![0];
    runAnalysisSteps(outgoingCallHierarchySteps({analysis,workspaceIndex,item}));
    const steps = outgoingCallHierarchySteps({analysis,workspaceIndex,item});
    let yielded = 0;
    let next = steps.next();
    while (!next.done) { yielded++; next = steps.next(); }
    assert.strictEqual(next.value.length,1);
    assert.strictEqual(next.value[0].fromRanges.length,2);
    assert.ok(yielded <= 2,`cached request rebuilt the graph (${yielded} checkpoints)`);
  });

  test('distinguishes direct and pointer calls from unrelated variable references', () => {
    const analysis = new DocumentAnalyzer().analyzeDocument({uri:'file:///references.axl',version:1,
      text:'void target() {}\nvoid caller() { target(); void (*callback)() = &target; callback(); }\nvoid count() {}\n'
        + Array.from({length:3},(_,i)=>`void function${i}() { int count = 0; ${'count += 1; '.repeat(3)} }`).join('\n')});
    const workspaceIndex = {};
    const item = runAnalysisSteps(prepareCallHierarchySteps({analysis,workspaceIndex,position:{line:1,character:6}}))![0];
    const calls = runAnalysisSteps(outgoingCallHierarchySteps({analysis,workspaceIndex,item}));
    const incoming = runAnalysisSteps(incomingCallHierarchySteps({analysis,workspaceIndex,item:calls[0].item}));
    assert.deepStrictEqual(calls.map(call=>call.item.name),['target']);
    assert.strictEqual(calls[0].fromRanges.length,2);
    assert.deepStrictEqual(incoming.map(call=>call.item.name),['caller']);
    assert.strictEqual(incoming[0].fromRanges.length,2);
  });

  test('cancels graph construction and can rebuild after cancellation', async () => {
    const analysis = new DocumentAnalyzer().analyzeDocument({uri:'file:///cancel.axl',version:1,
      text:'void target() {}\nvoid main() { target(); }'});
    const workspaceIndex = {};
    const token = new CancellationTokenSource();
    const request = runAnalysisStepsAsync(prepareCallHierarchySteps({analysis,workspaceIndex,position:{line:1,character:5}}),token.token);
    token.cancel();
    await assert.rejects(request,(error: unknown) => error instanceof ResponseError && error.code === LSPErrorCodes.RequestCancelled);
    token.dispose();
    const items = runAnalysisSteps(prepareCallHierarchySteps({analysis,workspaceIndex,position:{line:1,character:5}}));
    assert.strictEqual(items?.[0].name,'main');
  });
});
