import type * as Parser from 'tree-sitter';

/** A read-only view for one source in a document generation. Never reuse a view after editing its native tree. */
export function cachedSyntaxNode(root: Parser.SyntaxNode): Parser.SyntaxNode {
  const views = new WeakMap<Parser.SyntaxNode, Parser.SyntaxNode>();
  const nodeProperties = new Set(['parent','firstChild','lastChild','firstNamedChild','lastNamedChild',
    'nextSibling','previousSibling','nextNamedSibling','previousNamedSibling']);
  const nodeMethods = new Set(['child','namedChild','childForFieldName']);
  const cachedMethods = new Set([...nodeMethods, 'fieldNameForChild','descendantsOfType']);
  function wrap(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
    if (!node) { return null; }
    const existing=views.get(node);
    if (existing) { return existing; }
    const values=new Map<PropertyKey, unknown>();
    const view=new Proxy(node, {get(target,key) {
      if(values.has(key)) { return values.get(key); }
      if (key === 'children' || key === 'namedChildren') {
        const countKey = key === 'children' ? 'childCount' : 'namedChildCount';
        let count = values.get(countKey);
        if (count === undefined) {
          count = Reflect.get(target,countKey,target) as number;
          values.set(countKey,count);
        }
        // Native child enumeration resets a traversal cursor even for a leaf.
        if (count === 0) {
          const empty: Parser.SyntaxNode[] = [];
          values.set(key,empty);
          return empty;
        }
      }
      const original=Reflect.get(target,key,target) as unknown;
      let value:unknown=original;
      if(typeof original==='function') {
        if(cachedMethods.has(String(key))) {
          if (key === 'descendantsOfType') {
            const results = new Map<string, Parser.SyntaxNode[]>();
            value = (...args: unknown[]) => {
              const cacheKey = JSON.stringify(args);
              const cached = results.get(cacheKey);
              if (cached) { return cached; }
              const result = (Reflect.apply(original, target, args) as Parser.SyntaxNode[]).map(child => wrap(child)!);
              results.set(cacheKey, result);
              return result;
            };
          } else {
            // These native methods have one primitive argument. Cache hits need
            // neither a rest-argument array nor a serialized cache key.
            const results = new Map<unknown, unknown>();
            value = (argument: unknown) => {
              if (results.has(argument)) { return results.get(argument); }
              const result = Reflect.apply(original, target, [argument]) as unknown;
              const mapped = nodeMethods.has(String(key)) ? wrap(result as Parser.SyntaxNode | null) : result;
              results.set(argument, mapped);
              return mapped;
            };
          }
        } else { value=original.bind(target); }
      } else if(key==='children' || key==='namedChildren') {
        value=(original as Parser.SyntaxNode[]).map(n=>wrap(n)!);
      } else if(nodeProperties.has(String(key))) { value=wrap(original as Parser.SyntaxNode | null); }
      values.set(key,value);
      return value;
    }});
    views.set(node,view);
    return view;
  }
  return wrap(root)!;
}
