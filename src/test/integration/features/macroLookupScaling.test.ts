import * as assert from 'assert';
import { createMacroLookup } from '../../../analyzer/diagnostics';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';

suite('Macro lookup scaling', () => {
  test('indexes macro names once across source positions', () => {
    const macros=new DocumentAnalyzer().analyzeDocument({uri:'file:///m.axl',version:1,text:'#define A 1\n#define A 2\n#define B 3\n'}).macroDefinitions;
    const filter=macros.filter.bind(macros);
    let scans=0;
    macros.filter=((...args:Parameters<typeof filter>)=>{scans++;return filter(...args);}) as typeof macros.filter;
    for(let i=0;i<20;i++) {
      const lookup=createMacroLookup(macros,'file:///m.axl',{line:3,character:0});
      assert.strictEqual(lookup.findMacro('A')?.replacementText,'2');
      assert.strictEqual(lookup.findMacro('missing'),undefined);
    }
    assert.ok(scans<=1,`Full macro scans: ${scans}`);
    assert.strictEqual(createMacroLookup(macros,'file:///m.axl',{line:0,character:0}).findMacro('A'),undefined);
    assert.strictEqual(createMacroLookup(macros,'file:///m.axl',{line:1,character:0}).findMacro('A')?.replacementText,'1');
  });
});
