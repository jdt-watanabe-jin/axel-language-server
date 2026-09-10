import * as assert from 'assert';
import { checkCompatibility } from '../../analyzer/typeChecking/compatibility';
import { basic, pointer, type TypeContext } from '../../analyzer/typeChecking/model';

suite('Type checking: evidence boundaries',()=>{
  const context={} as TypeContext;
  test('keeps measured object-pointer conversions separate from numeric initializers',()=>{
    assert.strictEqual(checkCompatibility(context,pointer(basic('int')),pointer(basic('double')),'argument'),'accepted');
    assert.strictEqual(checkCompatibility(context,basic('int'),pointer(basic('int')),'initialize'),'rejected');
  });
  test('defers unmeasured pointer and integer casts',()=>{
    assert.strictEqual(checkCompatibility(context,pointer(basic('int')),basic('int'),'cast'),'unknown');
    assert.strictEqual(checkCompatibility(context,basic('int'),pointer(basic('int')),'cast'),'unknown');
  });
  test('does not generalize ordinary pointers to multiple indirection',()=>{
    assert.strictEqual(checkCompatibility(context,pointer(pointer(basic('int'))),pointer(pointer(basic('double'))),'argument'),'unknown');
  });
});
