import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { bindDocumentation } from '../../../analyzer/documentation/index';
import { analyze } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Doxygen owner scope', () => {
  const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();

  test('keeps an explicit member target on its actual owner when class names collide', () => {
    const directory = createTempDir();
    const documentedPath = path.join(directory, 'a.h');
    const duplicatePath = path.join(directory, 'b.h');
    const mainPath = path.join(directory, 'main.axl');
    fs.writeFileSync(documentedPath, [
      'class Box { public:',
      '/*! @fn int Find(int n)',
      ' * @brief A member',
      ' */',
      'int Find(int n);',
      '};',
    ].join('\n'));
    fs.writeFileSync(duplicatePath, 'class Box { public: int Find(int n); };');

    const mainUri = pathToFileURL(mainPath).toString();
    const documentedUri = pathToFileURL(documentedPath).toString();
    const duplicateUri = pathToFileURL(duplicatePath).toString();
    const index = createWorkspaceIndex();
    index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "a.h"\n#include "b.h"\nvoid main() {}',
    });

    const declarations = index.listVisibleDeclarations(mainUri);
    const documented = declarations.find(declaration => declaration.uri === documentedUri && declaration.name === 'Find');
    const duplicate = declarations.find(declaration => declaration.uri === duplicateUri && declaration.name === 'Find');
    assert.ok(documented);
    assert.ok(duplicate);

    const bindings = index.documentationBindings(mainUri);
    assert.deepStrictEqual(
      bindings.get(documented.id)?.documents.flatMap(document => document.brief.map(entry => entry.text)),
      ['A member'],
    );
    assert.strictEqual(bindings.has(duplicate.id), false);
  });

  test('keeps a name-only member variable target on its actual owner', () => {
    const directory = createTempDir();
    const documentedPath = path.join(directory, 'a.h');
    const duplicatePath = path.join(directory, 'b.h');
    const mainPath = path.join(directory, 'main.axl');
    fs.writeFileSync(documentedPath, [
      'class Box { public:',
      '/*! @var value',
      ' * @brief A field',
      ' */',
      'int value;',
      '};',
    ].join('\n'));
    fs.writeFileSync(duplicatePath, 'class Box { public: int value; };');

    const mainUri = pathToFileURL(mainPath).toString();
    const documentedUri = pathToFileURL(documentedPath).toString();
    const duplicateUri = pathToFileURL(duplicatePath).toString();
    const index = createWorkspaceIndex();
    index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "a.h"\n#include "b.h"\nvoid main() {}',
    });

    const declarations = index.listVisibleDeclarations(mainUri);
    const documented = declarations.find(declaration => declaration.uri === documentedUri && declaration.name === 'value');
    const duplicate = declarations.find(declaration => declaration.uri === duplicateUri && declaration.name === 'value');
    assert.ok(documented);
    assert.ok(duplicate);

    const bindings = index.documentationBindings(mainUri);
    assert.deepStrictEqual(
      bindings.get(documented.id)?.documents.flatMap(document => document.brief.map(entry => entry.text)),
      ['A field'],
    );
    assert.strictEqual(bindings.has(duplicate.id), false);
  });

  test('shares member documentation with an out-of-class definition in another file', () => {
    const directory = createTempDir();
    const declarationPath = path.join(directory, 'declaration.h');
    const definitionPath = path.join(directory, 'definition.h');
    const mainPath = path.join(directory, 'main.axl');
    fs.writeFileSync(declarationPath, [
      'class Box { public:',
      '/*! @fn int Find(int n)',
      ' * @brief Shared member',
      ' */',
      'int Find(int n);',
      '};',
    ].join('\n'));
    fs.writeFileSync(definitionPath, [
      '#include "declaration.h"',
      'int Box::Find(int n) { return n; }',
    ].join('\n'));

    const mainUri = pathToFileURL(mainPath).toString();
    const declarationUri = pathToFileURL(declarationPath).toString();
    const definitionUri = pathToFileURL(definitionPath).toString();
    const index = createWorkspaceIndex();
    index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "declaration.h"\n#include "definition.h"\nvoid main() {}',
    });

    const declarations = index.listVisibleDeclarations(mainUri).filter(declaration => declaration.name === 'Find');
    const declaration = declarations.find(candidate => candidate.uri === declarationUri);
    const definition = declarations.find(candidate => candidate.uri === definitionUri);
    assert.ok(declaration);
    assert.ok(definition);

    const bindings = index.documentationBindings(mainUri);
    for (const candidate of [declaration, definition]) {
      assert.deepStrictEqual(
        bindings.get(candidate.id)?.documents.flatMap(document => document.brief.map(entry => entry.text)),
        ['Shared member'],
      );
    }
  });

  test('resolves a name-only variable target inside its lexical function scope', () => {
    const analysis = analyze([
      'void main() {',
      '/*! @var value',
      ' * @brief Local value',
      ' */',
      'int value;',
      '}',
    ].join('\n'));
    const declaration = analysis.declarations.find(candidate => candidate.name === 'value');
    assert.ok(declaration);

    const bindings = bindDocumentation(analysis, [analysis], analysis.declarations);
    assert.deepStrictEqual(
      bindings.get(declaration.id)?.documents.flatMap(document => document.brief.map(entry => entry.text)),
      ['Local value'],
    );
  });

  test('distinguishes typed variadic overload targets by their element type', () => {
    const analysis = analyze([
      'int Find(int value ...);',
      'int Find(string value ...);',
      '/*! @fn int Find(int item ...)',
      ' * @brief Integer values',
      ' */',
    ].join('\n'));
    const declarations = analysis.declarations.filter(candidate => candidate.name === 'Find');
    const integer = declarations.find(candidate => candidate.signature?.parameters[0]?.label.startsWith('int '));
    const string = declarations.find(candidate => candidate.signature?.parameters[0]?.label.startsWith('string '));
    assert.ok(integer);
    assert.ok(string);

    const bindings = bindDocumentation(analysis, [analysis], analysis.declarations);
    assert.deepStrictEqual(
      bindings.get(integer.id)?.documents.flatMap(document => document.brief.map(entry => entry.text)),
      ['Integer values'],
    );
    assert.strictEqual(bindings.has(string.id), false);
  });
});
