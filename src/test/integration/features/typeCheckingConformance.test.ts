import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { assertCaseDiagnostics, loadTypeCheckingCases, selectTypeCheckingConformanceCases } from '../../support/typeCheckingCorpus';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Type checking: runtime conformance', () => {
  const fixtures = useWorkspaceFixtures();
  const cases = loadTypeCheckingCases();
  for (const runtimeCase of selectTypeCheckingConformanceCases(cases)) {
    test(runtimeCase.id, () => {
      const root = fixtures.createTempDir();
      const header = path.join(root, 'axel.h');
      // Minimal authored declarations, not a copy of the runtime's proprietary headers.
      fs.writeFileSync(header, [
        'class natural { public: int value; };',
        'class string { public: int length; };',
        'void printf(string format, ...);',
        '#define NULL 0',
        ''
      ].join('\n'));
      fs.writeFileSync(path.join(root, 'axel.analysis.json'), JSON.stringify({
        schemaVersion: 1, profile: 'axel-510', declarationFiles: ['axel.h'],
        types: { natural: 'axel.h', string: 'axel.h' }, analysisOnlyMacros: ['NULL']
      }));
      const index = fixtures.createWorkspaceIndex({ forcedIncludeFiles: [header] });
      const uri = pathToFileURL(path.join(root, 'probe.axl')).toString();
      const analysis = index.analyzeDocument({ uri, version: 1, text: runtimeCase.source });
      assertCaseDiagnostics(runtimeCase, analysis.diagnostics);
    });
  }
});
