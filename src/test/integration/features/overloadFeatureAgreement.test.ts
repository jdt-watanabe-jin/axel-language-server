import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';
import { getHover } from '../../../analyzer/hover';
import { getDefinitions, getReferences } from '../../../analyzer/navigation';
import { prepareRename } from '../../../analyzer/rename';
import { getSignatureHelp } from '../../../analyzer/signatureHelp';

suite('Overload feature agreement', () => {
  const fixtures = useWorkspaceFixtures();
  function setup(header: string, text: string) {
    const root = fixtures.createTempDir();
    const file = path.join(root, 'api.h');
    fs.writeFileSync(file, header);
    fs.writeFileSync(path.join(root, 'api.analysis.json'), JSON.stringify({
      schemaVersion: 1, profile: 'axel-510', declarationFiles: ['api.h'],
      types: { string: 'api.h' }, analysisOnlyMacros: []
    }));
    const workspaceIndex = fixtures.createWorkspaceIndex({ forcedIncludeFiles: [file] });
    const analysis = workspaceIndex.analyzeDocument({uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1, text});
    return {analysis, workspaceIndex, text};
  }
  const header = [
    'class string {public:int data;}; class izone {public:int data;}; class VARRAY {public:int data;};',
    'class DBPfigDD {public:int data;',
    'int InitGetFigureWP(void *rootdd, int layertype, int state, int selmode, int znmode, izone zone);',
    'int InitGetFigureWP(void *rootdd, string layername, int state, int selmode, int znmode, izone zone);',
    'int InitGetFigureWP(void *rootdd, string layername, int state, int selmode, int znmode, VARRAY* zone);',
    '};'
  ].join('\n');
  const source = 'void main(){DBPfigDD fdd; string name; fdd.InitGetFigureWP(NULL,name+"|x",0,0,0,NULL);}';
  for (const feature of ['hover', 'definition', 'signature', 'references']) {
    test(`selects the registered string/pointer overload for ${feature}`, () => {
      const input = setup(header, source);
      const position = {line:0,character:source.indexOf('InitGetFigureWP')+2};
      if (feature === 'hover') { assert.match(getHover({...input,position})!.plainText, /string layername.*VARRAY\* zone/); }
      if (feature === 'definition') { assert.strictEqual(getDefinitions({...input,position})[0].range.start.line,4); }
      if (feature === 'signature') {
        const help = getSignatureHelp({...input,position:{line:0,character:source.lastIndexOf('NULL')+2}});
        assert.match(help!.signatures[0].label, /string layername.*VARRAY\* zone/);
      }
      if (feature === 'references') {
        const target = input.workspaceIndex.listVisibleDocuments(input.analysis.uri).find(d => d.uri.endsWith('api.h'))!;
        const refs = getReferences({analysis:target,workspaceIndex:input.workspaceIndex,position:{line:4,character:8},includeDeclaration:false});
        assert.ok(refs.some(ref => ref.uri === input.analysis.uri));
      }
    });
  }
  test('keeps all viable numeric declarations instead of guessing a ranking', () => {
    const text = 'void main(){f(1);}';
    const input = setup('class string {public:int data;};\nint f(int x);\nint f(double x);',text);
    const position = {line:0,character:text.indexOf('f(1)')};
    assert.deepStrictEqual(getDefinitions({...input,position}).map(d => d.range.start.line),[1,2]);
    assert.match(getHover({...input,position})!.plainText,/f\(double x\)/);
    assert.strictEqual(getSignatureHelp({...input,position:{line:0,character:text.indexOf('1')}})!.signatures.length,2);
  });
  for (const [label, declaration, call] of [
    ['global', 'int f(int value);\nint f(string value);', 'f("x")'],
    ['static', 'class API {public:static int f(int value);\nstatic int f(string value);};', 'API::f("x")'],
    ['inherited', 'class Base {public:int data; int f(int value);\nint f(string value);}; class API : public Base {};', 'api.f("x")'],
    ['nested result', 'class API {public:int data;}; int f(int value);\nint f(string value); string name();', 'f(name())'],
    ['unknown argument', 'int f(int value);\nint f(string value);', 'f(missing)'],
  ]) {
    test(`resolves ${label} calls using registered declarations`, () => {
      const text = `void main(){API api; ${call};}`;
      const input = setup('class string {public:int data;}; '+declaration, text);
      const position = {line:0,character:text.indexOf(call)+call.indexOf('f(')};
      const definitions = getDefinitions({...input,position});
      if (label === 'unknown argument') {
        assert.strictEqual(definitions.length,2);
        assert.strictEqual(prepareRename({...input,position}),null);
      } else {
        assert.strictEqual(definitions.length,1);
        assert.strictEqual(definitions[0].range.start.line,1);
        assert.match(getHover({...input,position})!.plainText,/string value/);
      }
    });
  }
  test('retains macro name navigation and resolves an expanded argument type', () => {
    const text = '#define NAME "x"\nvoid main(){f(NAME);}';
    const input = setup('class string {public:int data;}; int f(int value);\nint f(string value);', text);
    assert.strictEqual(getDefinitions({...input,position:{line:1,character:12}})[0].range.start.line,1);
    assert.strictEqual(getDefinitions({...input,position:{line:1,character:15}})[0].uri,input.analysis.uri);
  });
  test('keeps user definitions distinguished by arity even with a wrong argument type', () => {
    const text = 'void f(int x) {}\nvoid f(int x,int y) {}\nvoid main(){f("x",2);}';
    const input = setup('class string {public:int data;};', text);
    assert.strictEqual(getDefinitions({...input,position:{line:2,character:12}})[0].range.start.line,1);
    assert.ok(input.analysis.diagnostics.some(d => d.code === 'axel.type.argument_type'));
  });
  test('does not accept same-arity user definitions as valid type overloads', () => {
    const text = 'void f(int x) {}\nvoid f(string x) {}\nvoid main(){f("x");}';
    const input = setup('class string {public:int data;};', text);
    assert.ok(input.analysis.diagnostics.some(d => d.code === 'axel.type.definition'));
  });
  test('reselects after a document edit and a declaration edit', () => {
    const text = 'void main(){f("x");}';
    const input = setup('class string {public:int data;}; int f(int value);\nint f(string value);', text);
    const position = {line:0,character:12};
    assert.strictEqual(getDefinitions({...input,position})[0].range.start.line,1);
    const analysis = input.workspaceIndex.analyzeDocument({uri:input.analysis.uri,version:2,text:'void main(){f(1);}'});
    assert.strictEqual(getDefinitions({...input,analysis,position})[0].range.start.line,0);
    const document = input.workspaceIndex.listVisibleDocuments(analysis.uri).find(d => d.uri.endsWith('api.h'))!;
    input.workspaceIndex.analyzeDocument({uri:document.uri,version:2,text:'class string {public:int data;}; int f(string value);\nint f(int value);'});
    assert.strictEqual(getDefinitions({...input,analysis,position})[0].range.start.line,1);
  });

  for (const args of ['', '"x"']) {
    test(`offers prefix-compatible signature help while entering arguments: ${args}`, () => {
      const text = `void main(){f(${args});}`;
      const input = setup('class string {public:int data;}; int f(int value,int count);\nint f(string value,int count);',text);
      const help = getSignatureHelp({...input,position:{line:0,character:text.indexOf(');')}});
      assert.ok(help);
      assert.strictEqual(help.signatures.length,args ? 1 : 2);
      if (args) { assert.match(help.signatures[0].label,/string value/); }
    });
  }

});
