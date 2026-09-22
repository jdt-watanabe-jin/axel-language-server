import type * as Parser from 'tree-sitter';

const stateKey = Symbol('syntaxView');
interface ViewState {
  node: Parser.SyntaxNode;
  read: (view: object, key: PropertyKey) => unknown;
}
const prototypes = new WeakMap<object, object>();
function viewPrototype(native: object): object {
  const original = Object.getPrototypeOf(native) as object;
  let prototype = prototypes.get(original);
  if (prototype) { return prototype; }
  prototype = Object.create(original) as object;
  // Share accessors between every node of the same native grammar type. Once
  // read, a field is an ordinary own property: hot passes avoid Proxy traps.
  const keys = new Set<PropertyKey>();
  for (let current: object | null = native; current && current !== Object.prototype; current = Object.getPrototypeOf(current) as object | null) {
    for (const key of Reflect.ownKeys(current)) { keys.add(key); }
  }
  for (const key of keys) {
    if (key === 'constructor') { continue; }
    Object.defineProperty(prototype, key, { configurable: true, get(this: { [stateKey]: ViewState }) {
      return this[stateKey].read(this, key);
    } });
  }
  prototypes.set(original, prototype);
  return prototype;
}
function cachedValue(view: object, key: PropertyKey): unknown {
  return Object.hasOwn(view, key) ? Reflect.get(view, key) : undefined;
}
function remember(view: object, key: PropertyKey, value: unknown): unknown {
  Object.defineProperty(view, key, { value, configurable: true });
  return value;
}

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
    const view = Object.create(viewPrototype(node)) as Parser.SyntaxNode;
    Object.defineProperty(view, stateKey, {value: {node, read}});
    views.set(node,view);
    return view;
  }
  function read(view: object, key: PropertyKey): unknown {
    const target = (view as { [stateKey]: ViewState })[stateKey].node;

    if (key === 'namedChildren' && Object.hasOwn(view, 'children')) {
      const named = (cachedValue(view, 'children') as Parser.SyntaxNode[]).filter(child => child.isNamed);
      remember(view, 'namedChildren', named);
      remember(view, 'namedChildCount', named.length);
      return named;
    }
    if (key === 'children' || key === 'namedChildren') {
      const countKey = key === 'children' ? 'childCount' : 'namedChildCount';
      let count = cachedValue(view, countKey);
      if (count === undefined) {
        count = Reflect.get(target,countKey,target) as number;
        remember(view, countKey,count);
      }
      // Native child enumeration resets a traversal cursor even for a leaf.
      if (count === 0) {
        const empty: Parser.SyntaxNode[] = [];
        remember(view, key,empty);
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
            const children = key === 'child' ? cachedValue(view, 'children') : key === 'namedChild' ? cachedValue(view, 'namedChildren') : undefined;
            if (Array.isArray(children) && typeof argument === 'number' && Number.isInteger(argument)
              && argument >= 0 && argument < children.length) { return children[argument]; }
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
    remember(view, key,value);
    return value;
  }
  return wrap(root)!;
}
