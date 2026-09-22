import * as assert from 'assert';
import { collectSemanticCallData } from '../../../analyzer/callHierarchySemantics';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import type { AnalysisDeclaration, AnalysisRange } from '../../../types/analysis';
import { runAnalysisSteps } from '../../../util/analysisSteps';

suite('Call hierarchy semantics', () => {
  function collect(text: string) {
    const analysis = new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///call-hierarchy-semantics.axl', version: 1, text
    });
    return { analysis, data: runAnalysisSteps(collectSemanticCallData({ analysis })) };
  }

  function selectedText(text: string, range: AnalysisRange): string {
    const lines = text.split('\n');
    if (range.start.line === range.end.line) {
      return lines[range.start.line].slice(range.start.character, range.end.character);
    }
    return [lines[range.start.line].slice(range.start.character),
      ...lines.slice(range.start.line + 1, range.end.line),
      lines[range.end.line].slice(0, range.end.character)].join('\n');
  }

  function declarationOnLine(declarations: AnalysisDeclaration[], line: number): AnalysisDeclaration {
    const declaration = declarations.find(item => item.kind === 'function' && item.selectionRange.start.line === line);
    assert.ok(declaration, `Expected a function declaration on line ${line + 1}`);
    return declaration;
  }

  test('resolves direct, overloaded, and member calls without guessing unresolved calls', () => {
    const text = [
      'class Label { public: int data; };',
      'int choose(int value) { return value; }',
      'int choose(Label value) { return 0; }',
      'class Worker { public: int data; int work(int value) { return value; } };',
      'void caller() {',
      '  Worker worker;',
      '  Label label;',
      '  choose(label);',
      '  worker.work(1);',
      '  choose(unknownValue);',
      '  missing();',
      '}'
    ].join('\n');
    const { analysis, data } = collect(text);
    const calls = data.calls.map(call => ({
      text: selectedText(text, call.range), targets: call.targets
    }));

    assert.strictEqual(calls.find(call => call.text === 'choose' && call.targets.length === 1)?.targets[0],
      declarationOnLine(analysis.declarations, 2));
    assert.strictEqual(calls.find(call => call.text === 'work')?.targets[0],
      declarationOnLine(analysis.declarations, 3));
    assert.ok(calls.some(call => call.text === 'choose' && call.targets.length === 0));
    assert.deepStrictEqual(calls.find(call => call.text === 'missing')?.targets, []);
  });

  test('keeps AXEL numeric overload uncertainty instead of adding C++ ranking', () => {
    const { data } = collect('int choose(int value) { return value; }\nint choose(double value) { return 0; }\nvoid caller() { choose(1); }');
    assert.strictEqual(data.calls.length,1);
    assert.deepStrictEqual(data.calls[0].targets,[]);
  });

  test('does not invent implicit conversions rejected by AXEL initialization and assignment rules', () => {
    const { data } = collect('class Value { public: int data; operator int() { return data; } };\nvoid use(Value value) { int initialized = value; int assigned; assigned = value; }');
    assert.deepStrictEqual(data.calls.flatMap(call=>call.targets),[]);
  });

  test('resolves constructors, overloaded operators, and user conversions at expression ranges', () => {
    const text = [
      'class Number {',
      'public:',
      '  int data;',
      '  Number(int value) { data=value; }',
      '  int operator+(int value) { return value; }',
      '  operator int() { return data; }',
      '};',
      'void use() {',
      '  Number number = Number(1);',
      '  int sum = number + 2;',
      '  int raw = (int)number;',
      '}'
    ].join('\n');
    const { analysis, data } = collect(text);
    const calls = data.calls.map(call => ({
      text: selectedText(text, call.range), targets: call.targets
    }));

    assert.strictEqual(calls.find(call => call.text === 'Number')?.targets[0],
      declarationOnLine(analysis.declarations, 3));
    assert.strictEqual(calls.find(call => call.text === '+')?.targets[0],
      declarationOnLine(analysis.declarations, 4));
    assert.strictEqual(calls.find(call => call.text === '(int)number')?.targets[0],
      declarationOnLine(analysis.declarations, 5));
  });

  test('resolves default, direct, and new construction plus each overloaded operator form', () => {
    const text = [
      'class Ops {',
      'public:',
      '  int data;',
      '  Ops() {}',
      '  Ops(int value) { data=value; }',
      '  int operator[](int value) { return value; }',
      '  int operator()(int value) { return value; }',
      '  int operator-() { return data; }',
      '  Ops operator=(Ops value) { return value; }',
      '};',
      'void use() {',
      '  Ops first;',
      '  Ops second(1);',
      '  Ops *created = new Ops(2);',
      '  int indexed = first[0];',
      '  int called = first(1);',
      '  int negated = -first;',
      '  first = second;',
      '}'
    ].join('\n');
    const { analysis, data } = collect(text);
    const calls = data.calls.map(call => ({text:selectedText(text,call.range),targets:call.targets}));

    assert.strictEqual(calls.find(call => call.text === 'first' && call.targets[0]?.selectionRange.start.line === 3)?.targets[0],
      declarationOnLine(analysis.declarations,3));
    assert.strictEqual(calls.find(call => call.text === 'second' && call.targets[0]?.selectionRange.start.line === 4)?.targets[0],
      declarationOnLine(analysis.declarations,4));
    assert.strictEqual(calls.find(call => call.text === 'Ops' && call.targets[0]?.selectionRange.start.line === 4)?.targets[0],
      declarationOnLine(analysis.declarations,4));
    for (const [site,line] of [['first[0]',5],['first',6],['-',7],['=',8]] as const) {
      assert.strictEqual(calls.find(call => call.text === site && call.targets[0]?.selectionRange.start.line === line)?.targets[0],
        declarationOnLine(analysis.declarations,line));
    }
  });

  test('records an implicit user conversion used by a resolved argument', () => {
    const text = [
      'class Value { public: int data; operator int() { return data; } };',
      'void consume(int value) {}',
      'void use() { Value value; consume(value); }'
    ].join('\n');
    const { analysis, data } = collect(text);
    const conversion = declarationOnLine(analysis.declarations,0);

    assert.strictEqual(data.calls.find(call => selectedText(text,call.range) === 'value'
      && call.targets[0] === conversion)?.targets[0],conversion);
  });

  test('records virtual override pairs by resolved inheritance and signature', () => {
    const text = [
      'class Base { public: int data; virtual int run(int value); };',
      'class Mid : public Base { public: int run(int value) { return value; } };',
      'class Derived : public Mid { public: int run(int value) { return value; } };',
      'class Wrong : public Base { public: int run(string value) { return 0; } };'
    ].join('\n');
    const { analysis, data } = collect(text);

    assert.deepStrictEqual(data.overrides, [
      { derived: declarationOnLine(analysis.declarations, 1), base: declarationOnLine(analysis.declarations, 0) },
      { derived: declarationOnLine(analysis.declarations, 2), base: declarationOnLine(analysis.declarations, 1) }
    ]);
  });

  test('finds virtual bases through non-overriding intermediate and multiple base classes', () => {
    const text = [
      'class Left { public: int data; virtual int run(int value); };',
      'class Right { public: int data; virtual int stop(int value); };',
      'class Middle : public Left {};',
      'class Derived : public Middle, public Right {',
      'public:',
      '  int run(int value) { return value; }',
      '  int stop(int value) { return value; }',
      '};'
    ].join('\n');
    const { analysis, data } = collect(text);

    assert.deepStrictEqual(data.overrides,[
      {derived:declarationOnLine(analysis.declarations,5),base:declarationOnLine(analysis.declarations,0)},
      {derived:declarationOnLine(analysis.declarations,6),base:declarationOnLine(analysis.declarations,1)}
    ]);
  });

  test('resolves an explicit destructor call to its qualified definition', () => {
    const text = [
      'class Version { public: int data; };',
      'Version::~Version() {}',
      'void destroy(Version value, Version *pointer) {',
      '  value.~Version();',
      '  pointer->~Version();',
      '  Version::~Version();',
      '}'
    ].join('\n');
    const { analysis, data } = collect(text);
    const destructor = declarationOnLine(analysis.declarations,1);

    assert.strictEqual(destructor.name,'~Version');
    const calls = data.calls.filter(call => selectedText(text,call.range) === '~Version');
    assert.strictEqual(calls.length,3);
    assert.ok(calls.every(call => call.targets[0] === destructor));
  });

});
