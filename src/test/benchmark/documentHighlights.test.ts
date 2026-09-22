import * as assert from 'assert';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { getDocumentHighlightsSteps } from '../../analyzer/documentHighlights';
import { runAnalysisSteps } from '../../util/analysisSteps';

suite('Document highlights performance', () => {
  for (const count of [5000]) {
    test(`measures initial, repeated and edited requests with ${count} references`, function () {
      this.timeout(30000);
      const analyzer = new DocumentAnalyzer();
      const text = `int value = 0;\nvoid main() {\n${'value += 1;\n'.repeat(count)}}`;
      const start = performance.now();
      const analysis = analyzer.analyzeDocument({uri:'file:///highlight-performance.axl',version:1,text});
      const workspaceIndex = {};
      const input = {analysis,workspaceIndex,position:{line:0,character:4}};
      assert.strictEqual(runAnalysisSteps(getDocumentHighlightsSteps(input)).length,count+1);
      const initial = performance.now()-start;
      const times: number[] = [];
      for (let i=0; i<10; i++) {
        const began = performance.now();
        assert.strictEqual(runAnalysisSteps(getDocumentHighlightsSteps(input)).length,count+1);
        times.push(performance.now()-began);
      }
      times.sort((a,b)=>a-b);
      assert.ok(times[9]<1000,`repeated p95 ${times[9].toFixed(1)} ms`);
      const editStart = performance.now();
      const edited = analyzer.analyzeDocument({uri:analysis.uri,version:2,text:text.replace('int value = 0;','int value = 1;')});
      assert.strictEqual(runAnalysisSteps(getDocumentHighlightsSteps({...input,analysis:edited})).length,count+1);
      console.log(`    highlights ${count} refs, ${text.length} UTF-16 units, ${count+3} lines, 0 dependencies/macros: initial=${initial.toFixed(1)} ms median=${times[5].toFixed(1)} ms p95=${times[9].toFixed(1)} ms edit=${(performance.now()-editStart).toFixed(1)} ms`);
    });
  }

});
