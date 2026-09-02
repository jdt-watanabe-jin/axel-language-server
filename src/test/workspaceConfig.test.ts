import * as assert from 'assert';
import * as path from 'path';
import { mergeWorkspaceIndexOptions, workspaceIndexOptionsFromEnvironment } from '../analyzer/workspaceConfig';

suite('workspaceIndexOptionsFromEnvironment', () => {
  test('maps semicolon-separated APP_AXELPATH and SXM_FORCED_INCLUDE_FILES to workspace index options', () => {
    const includeRoots = [
      path.join('workspace', 'axel'),
      path.join('vendor', 'axel')
    ];
    const forcedIncludeFiles = [
      path.join('forced', 'gui.h'),
      path.join('forced', 'system.h')
    ];

    const options = withPathDelimiter(':', () => workspaceIndexOptionsFromEnvironment({
      APP_AXELPATH: includeRoots.join(';'),
      SXM_FORCED_INCLUDE_FILES: forcedIncludeFiles.join(';')
    }));

    assert.deepStrictEqual(options, {
      includeRoots: includeRoots.map((root) => path.normalize(root)),
      forcedIncludeFiles: forcedIncludeFiles.map((filePath) => path.normalize(filePath))
    });
  });

  test('merges configured forced includes with SXM_FORCED_INCLUDE_FILES instead of replacing them', () => {
    const envForcedIncludeFiles = [
      path.join('env', 'system.h'),
      path.join('shared', 'common.h')
    ];
    const configuredForcedIncludeFiles = [
      path.join('workspace', 'project.h'),
      path.join('shared', 'common.h')
    ];

    const options = mergeWorkspaceIndexOptions({
      forcedIncludeFiles: envForcedIncludeFiles
    }, {
      forcedIncludeRoots: [path.join('workspace', 'forced')],
      forcedIncludeFiles: configuredForcedIncludeFiles
    });

    assert.deepStrictEqual(options, {
      includeRoots: [],
      forcedIncludeRoots: [path.normalize(path.join('workspace', 'forced'))],
      forcedIncludeFiles: [
        path.normalize(path.join('env', 'system.h')),
        path.normalize(path.join('shared', 'common.h')),
        path.normalize(path.join('workspace', 'project.h'))
      ]
    });
  });

  test('keeps SXM_FORCED_INCLUDE_FILES when the client sends an empty forcedIncludeFiles array', () => {
    const envForcedIncludeFile = path.join('env', 'system.h');

    const options = mergeWorkspaceIndexOptions({
      forcedIncludeFiles: [envForcedIncludeFile]
    }, {
      forcedIncludeFiles: []
    });

    assert.deepStrictEqual(options, {
      includeRoots: [],
      forcedIncludeRoots: [],
      forcedIncludeFiles: [path.normalize(envForcedIncludeFile)]
    });
  });

  test('keeps configured maxNumberOfProblems when it is positive', () => {
    const options = mergeWorkspaceIndexOptions({}, {
      maxNumberOfProblems: 25
    });

    assert.strictEqual(options.maxNumberOfProblems, 25);
  });

  test('keeps configured default defines', () => {
    const options = mergeWorkspaceIndexOptions({}, {
      defines: ['NDEBUG', 'MY_CUSTOM_MACRO=1']
    });

    assert.deepStrictEqual(options.defines, ['NDEBUG', 'MY_CUSTOM_MACRO=1']);
  });
});

function withPathDelimiter<T>(delimiter: string, callback: () => T): T {
  const originalDelimiter = path.delimiter;
  Object.defineProperty(path, 'delimiter', { value: delimiter });

  try {
    return callback();
  } finally {
    Object.defineProperty(path, 'delimiter', { value: originalDelimiter });
  }
}
