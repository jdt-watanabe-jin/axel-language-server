import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';
import { getHover } from '../../../analyzer/hover';
import { positionFromOffset } from '../../support/source';

suite('Doxygen workspace', () => {
  const {createWorkspaceIndex, createTempDir} = useWorkspaceFixtures();
  test('keeps distant documentation in its requesting include context', () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, 'api.h'), 'int Find(int count);');
    const index = createWorkspaceIndex();
    const a = pathToFileURL(path.join(dir, 'a.axl')).href;
    const b = pathToFileURL(path.join(dir, 'b.axl')).href;
    const source = '#include "api.h"\n/*! @fn int Find(int n)\n * @brief A only\n */\nvoid main(){ Find(1); }';
    const text = '#include "api.h"\nvoid main(){ Find(1); }';
    const aa = index.indexOpenDocument({uri:a,version:1,text:source});
    const bb = index.indexOpenDocument({uri:b,version:1,text});
    const ha = getHover({analysis:aa,position:positionFromOffset(source,source.lastIndexOf('Find')),workspaceIndex:index});
    const hb = getHover({analysis:bb,position:positionFromOffset(text,text.lastIndexOf('Find')),workspaceIndex:index});
    assert.ok(ha?.plainText.includes('A only'));
    assert.ok(!hb?.plainText.includes('A only'));
    assert.strictEqual(index.documentationBindings(a), index.documentationBindings(a));
  });
  test('replaces edited header docs and removes deleted header docs', () => {
    const dir = createTempDir();
    const file = path.join(dir,'api.h');
    fs.writeFileSync(file, '/*! @brief old */\nint Find();');
    const uri = pathToFileURL(path.join(dir,'main.axl')).href;
    const index = createWorkspaceIndex();
    const text = '#include "api.h"\nvoid main(){ Find(); }';
    const read = (version:number) => {
      const analysis = index.indexOpenDocument({uri,version,text});
      return getHover({analysis,position:positionFromOffset(text,text.lastIndexOf('Find')),workspaceIndex:index});
    };
    assert.ok(read(1)?.plainText.includes('old'));
    fs.writeFileSync(file, '/*! @brief updated */\nint Find();');
    index.invalidateFile(file);
    assert.ok(read(2)?.plainText.includes('updated'));
    fs.unlinkSync(file);
    index.invalidateFile(file);
    assert.ok(!read(3)?.plainText.includes('updated'));
  });
  test('refreshes documentation when forced includes switch', () => {
    const dir = createTempDir();
    const firstDir = path.join(dir, 'first'), secondDir = path.join(dir, 'second');
    fs.mkdirSync(firstDir); fs.mkdirSync(secondDir);
    const first = path.join(firstDir, 'api.h'), second = path.join(secondDir, 'api.h');
    fs.writeFileSync(first, '/*! @brief First docs */\nint Find();');
    fs.writeFileSync(second, '/*! @brief Second docs */\nint Find();');
    const index = createWorkspaceIndex({forcedIncludeRoots:[firstDir]});
    const uri = pathToFileURL(path.join(dir,'main.axl')).href;
    const text = 'void main(){ Find(); }';
    const read = (version:number) => {
      const analysis = index.indexOpenDocument({uri,version,text});
      return getHover({analysis,position:positionFromOffset(text,text.indexOf('Find')),workspaceIndex:index})?.plainText;
    };
    assert.ok(read(1)?.includes('First docs'));
    index.configure({forcedIncludeRoots:[secondDir]});
    assert.ok(read(2)?.includes('Second docs'));
    assert.ok(!read(2)?.includes('First docs'));
  });
  test('uses new and unsaved header documentation ahead of disk content', () => {
    const dir = createTempDir();
    const file = path.join(dir, 'api.h');
    const headerUri = pathToFileURL(file).href;
    const uri = pathToFileURL(path.join(dir,'main.axl')).href;
    const index = createWorkspaceIndex();
    const text = '#include "api.h"\nvoid main(){ Find(); }';
    const read = (version:number) => {
      const analysis = index.indexOpenDocument({uri,version,text});
      return getHover({analysis,position:positionFromOffset(text,text.lastIndexOf('Find')),workspaceIndex:index})?.plainText;
    };
    assert.ok(!read(1)?.includes('Disk docs'));
    fs.writeFileSync(file, '/*! @brief Disk docs */\nint Find();');
    index.invalidateFile(file);
    assert.ok(read(2)?.includes('Disk docs'));
    index.indexOpenDocument({uri:headerUri,version:1,text:'/*! @brief Unsaved docs */\nint Find();'});
    assert.ok(read(3)?.includes('Unsaved docs'));
    assert.ok(!read(3)?.includes('Disk docs'));
  });
  test('does not expose documentation from an inactive include', () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir,'hidden.h'), '/*! @fn int Find()\n * @brief Hidden\n */');
    const uri = pathToFileURL(path.join(dir,'main.axl')).href;
    const index = createWorkspaceIndex();
    const text = '#if 0\n#include "hidden.h"\n#endif\nint Find();\nvoid main(){ Find(); }';
    const analysis = index.indexOpenDocument({uri,version:1,text});
    assert.ok(!getHover({analysis,position:positionFromOffset(text,text.lastIndexOf('Find')),workspaceIndex:index})?.plainText.includes('Hidden'));
  });
});
