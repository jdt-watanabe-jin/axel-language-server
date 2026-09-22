import * as assert from 'assert';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import { runAnalysisSteps } from '../../../util/analysisSteps';
import { validateSettings, configurationKeys } from '../../../lsp/configuration';
import type { AnalysisSymbol, AnalyzeDocumentInput } from '../../../types/analysis';
import type { AnalysisStep } from '../../../util/analysisSteps';

suite('document outline isolation', () => {
  test('validates modes and invalidates feature configuration', () => {
    assert.strictEqual(validateSettings({workspaceSymbols:'All'}).workspaceSymbols, 'All');
    assert.strictEqual(validateSettings({workspaceSymbols:'Just My Code'}).workspaceSymbols, 'Just My Code');
    assert.throws(() => validateSettings({workspaceSymbols:'all'}), /workspaceSymbols/);
    assert.strictEqual(configurationKeys({}).features, configurationKeys({workspaceSymbols:'Just My Code'}).features);
    assert.notStrictEqual(configurationKeys({}).features, configurationKeys({workspaceSymbols:'All'}).features);
  });
  test('outline does not enter semantic analysis or load dependencies and follows edits', () => {
    const index = new WorkspaceIndex({sxmHome:'missing-sdk',forcedIncludeFiles:['missing-forced.h'],defines:['SELECTED=1']});
    index.analyzeRequestDocument = async () => { throw new Error('Full analysis must not run'); };
    const api = index as unknown as {getDocumentSymbolsSteps(input:AnalyzeDocumentInput):Generator<AnalysisStep,AnalysisSymbol[],void>};
    const input={uri:'file:///outline.axl',version:1,text:'#include "missing.h"\n#if SELECTED\nint selected;\n#else\nint omitted;\n#endif\nclass Local { int member; };'};
    const symbols=runAnalysisSteps(api.getDocumentSymbolsSteps(input));
    assert.ok(symbols.some(s=>s.name==='selected'));
    assert.ok(!symbols.some(s=>s.name==='omitted'));
    assert.deepStrictEqual(symbols.find(s=>s.name==='Local')?.children?.map(s=>s.name),['member']);
    assert.deepStrictEqual(runAnalysisSteps(api.getDocumentSymbolsSteps({...input,version:2,text:'int edited;'})).map(s=>s.name),['edited']);
  });
});
