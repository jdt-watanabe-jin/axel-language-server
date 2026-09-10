import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { loadBuiltinCatalog, builtinRole, isBuiltinDeclarationSource } from '../../analyzer/typeChecking/builtinCatalog';

suite('Type checking: builtin catalog', () => {
  let root: string;
  const uri = (name: string) => pathToFileURL(path.join(root, name)).toString();
  const write = (name: string, content = '') => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  };
  const manifest = (overrides: Record<string, unknown> = {}) => write('entry.analysis.json', JSON.stringify({
    schemaVersion: 1, profile: 'axel-510', declarationFiles: ['entry.h', 'types/natural.h'],
    types: { natural: 'types/natural.h' }, analysisOnlyMacros: ['NULL'], ...overrides
  }));
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-catalog-'));
    write('entry.h', '#include "types/natural.h"');
    write('types/natural.h', 'class natural {};');
    write('user.h', 'class natural {};');
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test('binds roles to the listed declaration URI and name only', () => {
    manifest();
    const catalog = loadBuiltinCatalog([uri('entry.h')]);
    assert.strictEqual(catalog.profile, 'axel-510');
    assert.strictEqual(builtinRole(catalog, uri('types/natural.h'), 'natural'), 'natural');
    assert.strictEqual(builtinRole(catalog, uri('user.h'), 'natural'), undefined);
    assert.strictEqual(builtinRole(catalog, uri('types/natural.h'), 'Other'), undefined);
    assert.ok(isBuiltinDeclarationSource(catalog, uri('entry.h')));
    assert.ok(!isBuiltinDeclarationSource(catalog, uri('user.h')));
    assert.ok(catalog.analysisOnlyMacroUris.has(uri('entry.h')));
  });
  test('ordinary forced includes and arbitrary identical basenames receive no handling', () => {
    write('_axel_intellisense_def.h');
    const catalog = loadBuiltinCatalog([uri('entry.h'), uri('_axel_intellisense_def.h')]);
    assert.strictEqual(catalog.profile, undefined);
    assert.strictEqual(catalog.declarationUris.size, 0);
    assert.strictEqual(catalog.analysisOnlyMacroUris.size, 0);
  });
  test('supports filesystem entries and explicit differently named bindings', () => {
    manifest({ types: { unit: { file: 'types/natural.h', name: 'Unit' } } });
    const catalog = loadBuiltinCatalog([path.join(root, 'entry.h')]);
    assert.strictEqual(builtinRole(catalog, uri('types/natural.h'), 'Unit'), 'unit');
    assert.strictEqual(builtinRole(catalog, uri('types/natural.h'), 'unit'), undefined);
  });
  test('does not implicitly register transitive includes or macros without opt in', () => {
    manifest({ declarationFiles: ['types/natural.h'], analysisOnlyMacros: [] });
    const catalog = loadBuiltinCatalog([uri('entry.h')]);
    assert.strictEqual(catalog.declarationUris.size, 1);
    assert.ok(!isBuiltinDeclarationSource(catalog, uri('entry.h')));
    assert.strictEqual(catalog.analysisOnlyMacroUris.size, 0);
  });
  test('rejects invalid manifests atomically and retains valid independent entries', () => {
    const invalid = [
      { schemaVersion: 2 }, { profile: 'axel-next' }, { declarationFiles: ['missing.h'] },
      { declarationFiles: ['../outside.h'] }, { declarationFiles: [path.join(root, 'user.h')] },
      { types: { natural: 'user.h' } }, { types: { natural: { file: 'types/natural.h', name: '' } } },
      { analysisOnlyMacros: ['OTHER'] }
    ];
    for (const overrides of invalid) {
      manifest(overrides);
      const catalog = loadBuiltinCatalog([uri('entry.h')]);
      assert.strictEqual(catalog.declarationUris.size, 0, JSON.stringify(overrides));
      assert.strictEqual(catalog.profile, undefined);
      assert.ok(catalog.issues?.length);
    }
    write('entry.analysis.json', '{');
    assert.strictEqual(loadBuiltinCatalog([uri('entry.h')]).declarationUris.size, 0);
    manifest();
    write('broken.h'); write('broken.analysis.json', '{');
    assert.strictEqual(loadBuiltinCatalog([uri('broken.h'), uri('entry.h')]).declarationUris.size, 2);
  });
});
