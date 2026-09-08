import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('uncertainty integration', () => {
  test('does not export uncertain function parameters from headers', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'types.h'), '#if __TIME__\nvoid run(int arg){ arg; }\n#endif\n');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({ uri, version: 1, text: '#include "types.h"\nvoid main(){ arg; }\n' });
    assert.ok(analysis.diagnostics.some(diagnostic => diagnostic.message.includes("identifier 'arg'")));
  });
  test('does not promote declarations or macros reached only through a possible include', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'optional.h'), '#define MAYBE 1\nint candidate;\n');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({ uri, version: 1, text:
      '#if __TIME__\n#include "optional.h"\n#endif\n#ifdef MAYBE\nint yes;\n#else\nint no;\n#endif\nvoid main(){ candidate; }\n'
    });
    assert.deepStrictEqual(analysis.inactiveRanges, [], 'possible imported macro must not decide the branch');
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'candidate'), [], 'possible import must not become a definite declaration');
    assert.ok(analysis.uncertainNames?.includes('candidate'));
    assert.deepStrictEqual(analysis.diagnostics, []);
  });

  test('propagates uncertain declarations from a definitely included header', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'types.h'), '#if __TIME__\nint candidate;\n#endif\n');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({ uri, version: 1, text: '#include "types.h"\nvoid main(){ candidate; }\n' });
    assert.deepStrictEqual(analysis.diagnostics, [], 'uncertain header visibility must not produce an unknown identifier');
    assert.ok(analysis.uncertainNames?.includes('candidate'));
  });

  test('propagates maybe-defined macros from a definitely included header into later conditions', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'config.h'), '#if __TIME__\n#define MAYBE 1\n#endif\n');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({ uri, version: 1, text:
      '#include "config.h"\n#ifdef MAYBE\nint yes;\n#else\nint no;\n#endif\n'
    });
    assert.deepStrictEqual(analysis.inactiveRanges, [], 'unknown definition in a header remains unknown in the including file');
  });

  test('keeps declarations definite when another include path is definite', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'shared.h'), 'int candidate;\n');
    fs.writeFileSync(path.join(directory, 'bridge.h'), '#include "shared.h"\n');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({ uri, version: 1, text:
      '#if __TIME__\n#include "shared.h"\n#endif\n#include "bridge.h"\nvoid main(){ candidate; }\n'
    });
    assert.strictEqual(index.findVisibleDeclarations(uri, 'candidate').length, 1);
    assert.deepStrictEqual(analysis.diagnostics, []);
  });

  test('merges a possible include after an earlier local definition', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'optional.h'), '#define MODE 1\n');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({ uri, version: 1, text:
      '#define MODE 0\n#if __TIME__\n#include "optional.h"\n#endif\n#if MODE\nint yes;\n#else\nint no;\n#endif\n'
    });
    assert.deepStrictEqual(analysis.inactiveRanges, []);
  });

  test('applies uncertainty from inside a header at the include position', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'optional.h'), '#if __TIME__\n#define MODE 1\n#endif\n');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({ uri, version: 1, text:
      '#define MODE 0\n#include "optional.h"\n#if MODE\nint yes;\n#else\nint no;\n#endif\n#define MODE 0\n#if MODE\nint inactive;\n#endif\n'
    });
    assert.deepStrictEqual(analysis.inactiveRanges?.map(range => range.start.line), [9]);
  });

  test('does not expose possible imports before the include', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'optional.h'), '#define MODE 1\n');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({ uri, version: 1, text:
      '#ifdef MODE\nint before;\n#endif\n#if __TIME__\n#include "optional.h"\n#if MODE\nint inside;\n#else\nint impossible;\n#endif\n#endif\n'
    });
    assert.deepStrictEqual(analysis.inactiveRanges?.map(range => range.start.line), [1, 8]);
  });

  test('carries transitive include uncertainty to the outer include position', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'optional.h'), '#define MODE 1\n');
    fs.writeFileSync(path.join(directory, 'bridge.h'), '#if __TIME__\n#include "optional.h"\n#endif\n');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({ uri, version: 1, text:
      '#define MODE 0\n#include "bridge.h"\n#if MODE\nint yes;\n#else\nint no;\n#endif\n'
    });
    assert.deepStrictEqual(analysis.inactiveRanges, []);
  });

  test('retains known definedness when a possible header definition changes only the value', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'optional.h'), '#if __TIME__\n#define MODE 1\n#endif\n');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({ uri, version: 1, text:
      '#define MODE 0\n#include "optional.h"\n#ifndef MODE\nint impossible;\n#endif\n'
    });
    assert.deepStrictEqual(analysis.inactiveRanges?.map(range => range.start.line), [3]);
  });
});

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
