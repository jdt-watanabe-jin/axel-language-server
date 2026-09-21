import * as assert from 'assert';
import { createAxelParser } from '../../analyzer/axelParser';
import { collectFoldingRangesSteps } from '../../analyzer/foldingRanges';
suite('Folding traversal performance',()=>{
  test('does not traverse expression subtrees confined to one physical line',()=>{
    const text='void main(){\n'+'consume(1, 2, 3);\n'.repeat(3000)+'}';
    const iterator=collectFoldingRangesSteps(createAxelParser().parse(text).rootNode,text);
    let batches=0;let result=iterator.next();while(!result.done){batches++;result=iterator.next();}
    assert.strictEqual(result.value.length,1);
    assert.ok(batches<30,`Traversed ${batches} batches for 3000 single-line statements`);
  });
});
