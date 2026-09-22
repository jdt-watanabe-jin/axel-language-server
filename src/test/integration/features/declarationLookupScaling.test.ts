import * as assert from 'assert';
import { declarationsInTypeHierarchy, visibleDeclarationsByName, findLocalDeclaration } from '../../../analyzer/resolution';
import { createVisibleEnumMemberDeclarations, createReferenceHeavyAnalysis } from '../../support/semanticTokenLoad';

suite('Declaration lookup scaling', () => {
  test('does not rescan visible declarations for repeated names and members', () => {
    function check(count: number) {
      const declarations = createVisibleEnumMemberDeclarations(500);
      const iterator = declarations[Symbol.iterator].bind(declarations);
      let scans = 0;
      declarations[Symbol.iterator] = function () { scans++; return iterator(); };
      const input = {analysis:createReferenceHeavyAnalysis(1),position:{line:0,character:0},workspaceIndex:{listVisibleDeclarations:()=>declarations}};
      for (let i=0;i<count;i++) {
        assert.strictEqual(visibleDeclarationsByName(input, 'MD_MESSAGE_1')[0]?.name,'MD_MESSAGE_1');
        assert.strictEqual(declarationsInTypeHierarchy(input, 'MessageId').length,500);
      }
      return scans;
    }
    const small = check(2), large = check(40);
    assert.ok(small > 0);
    assert.strictEqual(large,small,'Repeated references must not rebuild the visible declaration list');
  });
  test('invalidates lookups when visible declarations change at the same document version', () => {
    let declarations = createVisibleEnumMemberDeclarations(2);
    const input = {analysis:createReferenceHeavyAnalysis(1),position:{line:0,character:0},workspaceIndex:{listVisibleDeclarations:()=>declarations}};
    assert.strictEqual(declarationsInTypeHierarchy(input,'MessageId').length,2);
    declarations = createVisibleEnumMemberDeclarations(3);
    assert.strictEqual(declarationsInTypeHierarchy(input,'MessageId').length,3);
    assert.strictEqual(visibleDeclarationsByName(input,'MD_MESSAGE_2').length,1);
    declarations = [];
    assert.deepStrictEqual(declarationsInTypeHierarchy(input,'MessageId'),[]);
    assert.deepStrictEqual(visibleDeclarationsByName(input,'MD_MESSAGE_2'),[]);
  });
  test('invalidates local declaration ids when a new analysis replaces the declaration array', () => {
    const analysis = createReferenceHeavyAnalysis(1);
    analysis.declarations = createVisibleEnumMemberDeclarations(1);
    analysis.scopes[0].declarationIds = [analysis.declarations[0].id];
    const position = {line:0,character:20};
    assert.strictEqual(findLocalDeclaration(analysis,'MD_MESSAGE_0',position)?.name,'MD_MESSAGE_0');
    analysis.declarations = [{...analysis.declarations[0],name:'renamed'}];
    assert.strictEqual(findLocalDeclaration(analysis,'MD_MESSAGE_0',position),undefined);
    assert.strictEqual(findLocalDeclaration(analysis,'renamed',position)?.name,'renamed');
  });
  test('callers cannot mutate cached lookup arrays', () => {
    const declarations = createVisibleEnumMemberDeclarations(2);
    const input = {analysis:createReferenceHeavyAnalysis(1),position:{line:0,character:0},workspaceIndex:{listVisibleDeclarations:()=>declarations}};
    declarationsInTypeHierarchy(input,'MessageId').pop();
    visibleDeclarationsByName(input,'MD_MESSAGE_0').pop();
    assert.strictEqual(declarationsInTypeHierarchy(input,'MessageId').length,2);
    assert.strictEqual(visibleDeclarationsByName(input,'MD_MESSAGE_0').length,1);
  });

});
