import { type Type, type CheckSite, type TypeContext, sameType, isNumeric, role, dereference } from './model';

/** This is a direct conversion relation, deliberately not a transitive graph. */
export function checkCompatibility(ctx: TypeContext, from: Type, to: Type, site: CheckSite): 'accepted' | 'rejected' | 'unknown' {
  from=dereference(from); to=dereference(to);
  if(from.kind==='unknown' || to.kind==='unknown') { return 'unknown'; }
  if(site==='initialize' && to.const && to.kind==='pointer') { return 'rejected'; }
  if(to.kind==='array' && site==='assign') { return 'rejected'; }
  if(sameType(from,to)) { return 'accepted'; }
  if(isNumeric(from)&&isNumeric(to)) { return 'accepted'; }
  if (site === 'cast' && (from.kind === 'pointer' || to.kind === 'pointer') && from.kind !== to.kind) { return 'unknown'; }
  if(to.kind==='pointer') {
    // Only ordinary object-pointer conversions were measured. Do not infer
    // multilevel or function-pointer compatibility from that permissiveness.
    if ([from.element?.kind,to.element?.kind].some(kind => kind === 'pointer' || kind === 'function')) { return 'unknown'; }
    if(from.kind==='null' || from.kind==='pointer' || from.kind==='array') { return 'accepted'; }
    return 'rejected';
  }
  if(role(to)==='natural' && from.kind==='basic' && ['int','double'].includes(from.name)) { return 'accepted'; }
  if(role(from)==='natural' && to.kind==='basic' && ['int','double'].includes(to.name)) { return site==='operator' ? 'rejected' : 'accepted'; }
  if(from.kind==='class' && site!=='operator' && ['argument','return','cast'].includes(site)) {
    const conversions=from.classInfo!.methods.get('convert:'+to.name) ?? [];
    if(conversions.some(f=>sameType(f.result,to))) { return 'accepted'; }
  }
  if(to.kind==='class' && (site==='assign'||site==='initialize')) {
    const candidates=to.classInfo!.methods.get('operator=') ?? [];
    if(candidates.some(f=>f.parameters.length===1 && (sameType(from,f.parameters[0]) || isNumeric(from)&&isNumeric(f.parameters[0])))) { return 'accepted'; }
  }
  return site === 'cast' ? 'unknown' : 'rejected';
}
