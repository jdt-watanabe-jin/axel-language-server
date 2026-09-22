import * as assert from 'assert';
import { mapSourceOffset, type OffsetSegment } from '../../analyzer/sourceOffsetMap';

suite('Source offset mapping',()=>{
  const segments:OffsetSegment[]=[
    {start:2,end:5,targetStart:2,targetEnd:3},
    {start:7,end:7,targetStart:5,targetEnd:8},
    {start:7,end:7,targetStart:8,targetEnd:10},
    {start:7,end:9,targetStart:10,targetEnd:11},
    {start:12,end:15,targetStart:14,targetEnd:14}
  ];
  test('preserves start/end boundaries including empty and adjacent expansions',()=>{
    // [source offset, mapped start, mapped end]; expectations describe the source spans above.
    const boundaries = [
      [0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 2, 3], [5, 3, 3], [6, 4, 4],
      [7, 5, 5], [8, 10, 11], [9, 11, 11], [11, 13, 13], [12, 14, 14],
      [13, 14, 14], [15, 14, 14], [16, 15, 15]
    ];
    for (const [offset, start, end] of boundaries) {
      assert.strictEqual(mapSourceOffset(segments, offset, false), start, 'start at ' + offset);
      assert.strictEqual(mapSourceOffset(segments, offset, true), end, 'end at ' + offset);
    }
  });
  test('does not scan every expansion for a location near the end',()=>{
    let reads=0;
    const many=Array.from({length:8192},(_,i)=>({get start(){reads++;return i*4;},end:i*4+2,targetStart:i*4,targetEnd:i*4+2}));
    assert.strictEqual(mapSourceOffset(many,32765),32764);
    assert.ok(reads<40,`Expansion start reads: ${reads}`);
  });
});
