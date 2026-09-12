export interface OffsetSegment { start:number; end:number; targetStart:number; targetEnd:number }
/** Sorted non-overlapping source segments; equal starts represent consecutive empty expansions. */
export function mapSourceOffset(segments: readonly OffsetSegment[], index:number, end=false):number {
  let low=0, high=segments.length;
  while(low<high) {
    const mid=(low+high)>>>1;
    if(segments[mid].start<index) { low=mid+1; } else { high=mid; }
  }
  const selected=!end && low<segments.length && segments[low].start===index ? low : low-1;
  if(selected<0) { return index; }
  const segment=segments[selected];
  if(index<segment.end || index===segment.end && !end && segment.start===segment.end) {
    return end ? segment.targetEnd : segment.targetStart;
  }
  return index+segment.targetEnd-segment.end;
}
