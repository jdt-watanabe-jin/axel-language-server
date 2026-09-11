import * as assert from 'assert';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { collectTypeDiagnostics } from '../../analyzer/typeChecking/diagnostics';

suite('Type checking performance',()=>{
  test('repeated macro uses remain interactive with a document-local syntax cache',()=>{
    const text='#define ONE 1\nvoid main(){int a;'+ 'a+ONE;'.repeat(1000)+'}';
    const analyzer=new DocumentAnalyzer();
    const input={uri:'file:///type-performance.axl',version:1,text};
    const analysis=analyzer.analyzeDocument(input);
    const start=performance.now();
    const diagnostics=collectTypeDiagnostics({analysis});
    const elapsed=performance.now()-start;
    assert.deepStrictEqual(diagnostics,[]);
    assert.ok(elapsed<1000,`1000 macro uses took ${elapsed.toFixed(1)} ms`);
    console.log(`    type checking 1000 macro expressions: ${elapsed.toFixed(1)} ms`);
  });
});
