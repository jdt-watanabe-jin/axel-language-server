import * as assert from 'assert';
import { createAxelParser } from '../../analyzer/axelParser';
import { buildTypeSnapshot } from '../../analyzer/typeChecking/syntax';
suite('Syntax snapshot traversal',()=>{
  test('enumerates siblings together instead of crossing into the parser for every child',()=>{
    const root=createAxelParser().parse('int first; int second; void f(){first=second;}').rootNode;
    const child=root.child.bind(root);let indexedReads=0;
    Object.defineProperty(root,'child',{value:(index:number)=>{indexedReads++;return child(index);},configurable:true});
    const snapshot=buildTypeSnapshot(root,'file:///snapshot.axl');
    assert.strictEqual(snapshot.root.children.length,3);
    assert.strictEqual(snapshot.root.children[0].fields.declarator[0].text,'first');
    assert.strictEqual(indexedReads,0);
  });
});
