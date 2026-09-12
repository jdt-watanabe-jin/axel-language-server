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
      const original=Reflect.get(target,key,target) as unknown;
      let value:unknown=original;
      if(typeof original==='function') {
        if(cachedMethods.has(String(key))) {
          const results=new Map<string,unknown>();
          value=(...args:unknown[])=>{
            const cacheKey=JSON.stringify(args);
            if(results.has(cacheKey)) { return results.get(cacheKey); }
            const result=Reflect.apply(original,target,args) as unknown;
            const mapped=key==='descendantsOfType' ? (result as Parser.SyntaxNode[]).map(n=>wrap(n)!)
              : nodeMethods.has(String(key)) ? wrap(result as Parser.SyntaxNode | null) : result;
            results.set(cacheKey,mapped);
            return mapped;
          };
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
