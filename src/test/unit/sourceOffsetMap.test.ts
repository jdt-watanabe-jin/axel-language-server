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
  function reference(index:number,end:boolean) {
    let delta=0;
    for(const s of segments){
      if(index<s.start || index===s.start && end){break;}
      if(index<s.end || index===s.end && !end && s.start===s.end){return end?s.targetEnd:s.targetStart;}
      delta=s.targetEnd-s.end;
    }
    return index+delta;
  }
  test('preserves start/end boundaries including empty and adjacent expansions',()=>{
    for(let offset=0;offset<20;offset++) {for(const end of [false,true]) {
      assert.strictEqual(mapSourceOffset(segments,offset,end),reference(offset,end));
    }}
  });
  test('does not scan every expansion for a location near the end',()=>{
    let reads=0;
    const many=Array.from({length:8192},(_,i)=>({get start(){reads++;return i*4;},end:i*4+2,targetStart:i*4,targetEnd:i*4+2}));
    assert.strictEqual(mapSourceOffset(many,32765),32764);
    assert.ok(reads<40,`Expansion start reads: ${reads}`);
  });
});
