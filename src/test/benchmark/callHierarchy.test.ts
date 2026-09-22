import * as assert from 'assert';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { prepareCallHierarchySteps, outgoingCallHierarchySteps, incomingCallHierarchySteps } from '../../analyzer/callHierarchy';
import { collectHierarchySymbols } from '../../analyzer/callHierarchySymbols';
import { runAnalysisSteps } from '../../util/analysisSteps';

suite('Call hierarchy performance', () => {
  test('collects ownership for a large header without repeated whole-tree scans', function () {
    this.timeout(10000);
    const analysis = new DocumentAnalyzer().analyzeDocument({uri:'file:///large.axl',version:1,
      text:Array.from({length:4000},(_,i)=>`void function${i}() {}`).join('\n')});
    const start = performance.now();
    const symbols = runAnalysisSteps(collectHierarchySymbols(analysis,analysis.uri));
    const elapsed = performance.now()-start;
    assert.strictEqual(symbols.length,4001);
    assert.ok(elapsed < 1500, `ownership collection took ${elapsed.toFixed(1)} ms`);
    console.log(`    call hierarchy ownership (4000 functions): ${elapsed.toFixed(1)} ms`);
  });

  test('builds a graph with many variable references without quadratic navigation scans', function () {
    this.timeout(30000);
    const analysis = new DocumentAnalyzer().analyzeDocument({uri:'file:///references.axl',version:1,
      text:'void target() {}\nvoid caller() { target(); void (*callback)() = &target; callback(); }\nvoid count() {}\n'
        + Array.from({length:300},(_,i)=>`void function${i}() { int count = 0; ${'count += 1; '.repeat(80)} }`).join('\n')});
    const workspaceIndex = {};
    const start = performance.now();
    const prepare = prepareCallHierarchySteps({analysis,workspaceIndex,position:{line:1,character:6}});
    let checkpoints = 0;
    let next = prepare.next();
    while (!next.done) { checkpoints++; next = prepare.next(); }
    const item = next.value![0];
    assert.ok(checkpoints < 5000, `preparing a declaration traversed relation edges (${checkpoints} checkpoints)`);
    const calls = runAnalysisSteps(outgoingCallHierarchySteps({analysis,workspaceIndex,item}));
    const incoming = runAnalysisSteps(incomingCallHierarchySteps({analysis,workspaceIndex,item:calls[0].item}));
    const elapsed = performance.now()-start;
    assert.deepStrictEqual(calls.map(call=>call.item.name),['target']);
    assert.strictEqual(calls[0].fromRanges.length,2);
    assert.deepStrictEqual(incoming.map(call=>call.item.name),['caller']);
    assert.strictEqual(incoming[0].fromRanges.length,2);
    assert.ok(elapsed < 1500, `hierarchy with ${analysis.references.length} references took ${elapsed.toFixed(1)} ms`);
    console.log(`    call hierarchy (${analysis.references.length} references): ${elapsed.toFixed(1)} ms`);
  });

});
