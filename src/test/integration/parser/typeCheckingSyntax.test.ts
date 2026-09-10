import * as assert from 'assert';
import { createAxelParser } from '../../../analyzer/axelParser';

// Class names and value names share lexical syntax. A bare a*b statement still
// has object_definition(type: class_name, declarator: pointer_declarator);
// semantic name resolution distinguishes multiplication from a pointer declaration.
suite('Type checking: syntax contracts', () => {
  function parse(source: string) {
    const root = createAxelParser().parse(source).rootNode;
    assert.strictEqual(root.hasError, false, root.toString());
    return root;
  }

  test('distinguishes standard conversion definitions from header return types', () => {
    const root = parse('class A { public: int x; operator int(){return x;} int operator int(); };');
    const definition = root.descendantsOfType('function_definition')[0];
    assert.strictEqual(definition.childForFieldName('type'), null);
    const declarator = definition.childForFieldName('declarator')!;
    assert.strictEqual(declarator.type, 'function_declarator');
    assert.strictEqual(declarator.childForFieldName('parameters')!.type, 'parameter_list');
    const conversion = declarator.childForFieldName('declarator')!;
    assert.strictEqual(conversion.type, 'conversion_declarator');
    assert.strictEqual(conversion.childForFieldName('type')!.text, 'int');
    const header = root.descendantsOfType('field_declaration')[1];
    assert.strictEqual(header.childForFieldName('type')!.text, 'int');
    assert.strictEqual(header.childForFieldName('declarator')!.childForFieldName('declarator')!.type, 'conversion_declarator');
    assert.strictEqual(definition.childForFieldName('body')!.type, 'compound_statement');
  });

  test('preserves forward declarations const and nested declarator structure', () => {
    const root = parse('class A; const int *p; int &r=x; int a[1+2]; int (*callback)(int); typedef int Number;');
    assert.strictEqual(root.descendantsOfType('class_specifier')[0].childForFieldName('name')!.text, 'A');
    const objects = root.descendantsOfType('object_definition');
    assert.strictEqual(objects[0].childForFieldName('storage_class_specifier')!.text, 'const');
    assert.strictEqual(objects[0].childForFieldName('type')!.text, 'int');
    const pointer = objects[0].childForFieldName('declarator')!;
    assert.strictEqual(pointer.type, 'pointer_declarator');
    assert.strictEqual(pointer.children[0].text, '*');
    assert.strictEqual(pointer.childForFieldName('declarator')!.text, 'p');
    const reference = objects[1].childForFieldName('declarator')!.childForFieldName('declarator')!;
    assert.strictEqual(reference.children[0].text, '&');
    assert.strictEqual(root.descendantsOfType('array_declarator')[0].childForFieldName('size')!.type, 'binary_expression');
    const callback = objects[3].childForFieldName('declarator')!;
    assert.strictEqual(callback.type, 'function_declarator');
    assert.strictEqual(callback.childForFieldName('declarator')!.type, 'parenthesized_declarator');
    assert.strictEqual(callback.childForFieldName('parameters')!.namedChildren[0].childForFieldName('type')!.text, 'int');
    assert.strictEqual(root.descendantsOfType('type_definition')[0].childForFieldName('declarator')!.text, 'Number');
  });

  test('preserves casts units null and operator fields without evaluating them', () => {
    const root = parse('void f(){ natural n=1um; natural d=1.5um; int *p=NULL; int *q=nullptr; int i=(int)n; i+=2; n=n*2; }');
    assert.strictEqual(root.descendantsOfType('unit_integer_literal')[0].text, '1um');
    assert.strictEqual(root.descendantsOfType('unit_double_literal')[0].text, '1.5um');
    const initializers = root.descendantsOfType('init_declarator');
    assert.strictEqual(initializers[2].childForFieldName('value')!.text, 'NULL');
    assert.strictEqual(initializers[3].childForFieldName('value')!.text, 'nullptr');
    const cast = root.descendantsOfType('cast_expression')[0];
    assert.strictEqual(cast.childForFieldName('type')!.childForFieldName('type')!.text, 'int');
    assert.strictEqual(cast.childForFieldName('argument')!.text, 'n');
    const assignment = root.descendantsOfType('assignment_expression')[0];
    assert.strictEqual(assignment.childForFieldName('left')!.text, 'i');
    assert.strictEqual(assignment.childForFieldName('operator')!.text, '+=');
    assert.strictEqual(assignment.childForFieldName('right')!.text, '2');
    const binary = root.descendantsOfType('binary_expression')[0];
    assert.strictEqual(binary.childForFieldName('operator')!.text, '*');
  });

  test('retains syntactic declarations and invalid storage targets for semantic checks', () => {
    const root = parse('void f(int); void f(double); class A { int operator int(){return 1;} }; void probe(){ 1=2; (1+2)=3; }');
    const assignments = root.descendantsOfType('assignment_expression');
    assert.strictEqual(assignments.length, 2);
    assert.strictEqual(assignments[0].childForFieldName('left')!.type, 'integer_literal');
    assert.strictEqual(assignments[1].childForFieldName('left')!.type, 'parenthesized_expression');
    assert.strictEqual(root.descendantsOfType('object_definition').length, 2);
  });
});
