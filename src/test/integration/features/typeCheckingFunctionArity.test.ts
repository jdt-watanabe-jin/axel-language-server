import * as assert from 'assert';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';

suite('Type checking: function definition arity', () => {
  const contexts = [
    {name: 'global functions', source: (parameter: string) =>
      `void f(int x) {} void f(${parameter}) {} void main(){f(1);f();}`},
    {name: 'inline methods', source: (parameter: string) =>
      `class A {public: int data; void f(int x) {} void f(${parameter}) {}}; void main(){A a; a.f(1);a.f();}`},
    {name: 'out-of-class methods', source: (parameter: string) =>
      `class A {public: int data;}; void A::f(int x) {} void A::f(${parameter}) {} void main(){A a;a.f(1);a.f();}`}
  ];
  function check(text: string) {
    return new WorkspaceIndex().analyzeDocument({uri:'file:///arity.axl',version:1,text}).diagnostics;
  }
  for (const context of contexts) {
    test(`accepts different argument counts for ${context.name}`, () => {
      assert.deepStrictEqual(check(context.source('')), []);
    });
    test(`rejects equal argument counts with different types for ${context.name}`, () => {
      assert.strictEqual(check(context.source('double x')).filter(d=>d.code==='axel.type.definition').length, 1);
    });
    test(`rejects equal signatures for ${context.name}`, () => {
      assert.strictEqual(check(context.source('int x')).filter(d=>d.code==='axel.type.definition').length, 1);
    });
  }
});
