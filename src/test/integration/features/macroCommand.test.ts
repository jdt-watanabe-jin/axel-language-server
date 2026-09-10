import { pathToFileURL } from 'url';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { getDefinitions } from '../../../analyzer/navigation';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Macro command statements', () => {
  const fixtures=useWorkspaceFixtures();
  const prefix='#define CMD @_dp -nohistory\n';
  function analyze(text: string) {
    const index=fixtures.createWorkspaceIndex();
    const analysis=index.analyzeDocument({uri:'file:///cmd.axl',version:1,text});
    return {index,analysis};
  }
  test('treats interpolated arguments as references rather than declarations', () => {
    const {index,analysis}=analyze(prefix+'void f(){int va; CMD `va`;}');
    assert.deepStrictEqual(analysis.diagnostics, []);
    const declarations=analysis.declarations.filter(d=>d.name==='va');
    assert.strictEqual(declarations.length,1);
    const reference=analysis.references.find(r=>r.name==='va')!;
    assert.ok(reference);
    assert.deepStrictEqual(getDefinitions({analysis,position:reference.range.start,workspaceIndex:index}),
      [{uri:analysis.uri,range:declarations[0].selectionRange}]);
  });
  test('expands a command macro supplied by an include', () => {
    const root=fixtures.createTempDir();
    fs.writeFileSync(path.join(root,'cmd.h'),prefix);
    const index=fixtures.createWorkspaceIndex({includeRoots:[root]});
    const analysis=index.analyzeDocument({uri:pathToFileURL(path.join(root,'main.axl')).toString(),version:1,
      text:'#include "cmd.h"\nvoid f(){int va; CMD `va`;}'});
    assert.deepStrictEqual(analysis.diagnostics,[]);
  });
  test('retains duplicate diagnostics for macros expanding to a type', () => {
    const {analysis}=analyze('#define CMD int\nvoid f(){int va; CMD va;}');
    assert.ok(analysis.diagnostics.some(d=>d.message === "Duplicate declaration 'va'."));
  });
  test('does not recover a command after its macro was undefined', () => {
    const {analysis}=analyze(prefix+'#undef CMD\nvoid f(){int va; CMD `va`;}');
    assert.ok(analysis.diagnostics.some(d=>d.severity==='error'));
  });
  test('supports nested object-like command macros', () => {
    assert.deepStrictEqual(analyze('#define BASE @_dp\n#define CMD BASE -nohistory\nvoid f(){int va; CMD `va`;}').analysis.diagnostics,[]);
  });
  test('keeps genuine duplicate declarations following a command', () => {
    const {analysis}=analyze(prefix+'void f(){int va; CMD `va`; int va;}');
    assert.strictEqual(analysis.diagnostics.filter(d=>d.message === "Duplicate declaration 'va'.").length,1);
  });
  test('does not suppress invalid expressions in command arguments', () => {
    const {analysis}=analyze(prefix+'void f(){CMD `*5`;}');
    assert.ok(analysis.diagnostics.some(d=>d.severity==='error'));
  });
  test('does not recover recursive macros', () => {
    const {analysis}=analyze('#define CMD CMD\nvoid f(){int va;CMD `va`;}');
    assert.ok(analysis.diagnostics.some(d=>d.severity==='error'));
  });
  test('does not recover macros defined only in inactive branches', () => {
    const {analysis}=analyze('#if 0\n'+prefix+'#endif\nvoid f(){int va; CMD `va`;}');
    assert.ok(analysis.diagnostics.some(d=>d.severity==='error'));
  });
});
