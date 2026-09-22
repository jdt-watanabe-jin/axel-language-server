import * as assert from 'assert';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { collectTypeDiagnostics } from '../../analyzer/typeChecking/diagnostics';

suite('Type checking performance',()=>{
  test('checks repeated macro expressions without spurious diagnostics',()=>{
    const text='#define ONE 1\nvoid main(){int a;'+ 'a+ONE;'.repeat(3)+'}';
    const analyzer=new DocumentAnalyzer();
    const input={uri:'file:///type-performance.axl',version:1,text};
    const analysis=analyzer.analyzeDocument(input);
    const diagnostics=collectTypeDiagnostics({analysis});
    assert.deepStrictEqual(diagnostics,[]);
  });
});
