import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  incomingCallHierarchySteps,
  outgoingCallHierarchySteps,
  prepareCallHierarchySteps
} from '../../../analyzer/callHierarchy';
import type { AnalysisCallHierarchyItem } from '../../../analyzer/callHierarchyModel';
import type { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import type { AnalyzedDocument } from '../../../types/analysis';
import { runAnalysisSteps } from '../../../util/analysisSteps';
import { positionFromOffset } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Call hierarchy invalidation', () => {
  const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();

  function prepare(
    index: WorkspaceIndex,
    analysis: AnalyzedDocument,
    text: string,
    name: string,
    occurrence = 0
  ): AnalysisCallHierarchyItem {
    let offset = -1;
    for (let i = 0; i <= occurrence; i++) {
      offset = text.indexOf(name, offset + 1);
    }
    assert.ok(offset >= 0, `Missing ${name} occurrence ${occurrence}`);
    const items = runAnalysisSteps(prepareCallHierarchySteps({
      analysis,
      position: positionFromOffset(text, offset),
      workspaceIndex: index
    }));
    assert.ok(items?.length, `No call hierarchy item for ${name}`);
    return items[0];
  }

  function outgoing(index: WorkspaceIndex, analysis: AnalyzedDocument, item: AnalysisCallHierarchyItem) {
    return runAnalysisSteps(outgoingCallHierarchySteps({ item, analysis, workspaceIndex: index }));
  }

  function incoming(index: WorkspaceIndex, analysis: AnalyzedDocument, item: AnalysisCallHierarchyItem) {
    return runAnalysisSteps(incomingCallHierarchySteps({ item, analysis, workspaceIndex: index }));
  }

  test('rebuilds header-owned edges after an included dependency changes', () => {
    const directory = createTempDir();
    const header = path.join(directory, 'api.h');
    fs.writeFileSync(header, 'void oldTarget() {}\nvoid headerCaller() { oldTarget(); }');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const text = '#include "api.h"\nvoid root() { headerCaller(); }';
    const input = { uri, version: 1, text };
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument(input);

    const root = prepare(index, analysis, text, 'root');
    const headerCaller = outgoing(index, analysis, root)[0]?.item;
    assert.ok(headerCaller);
    assert.strictEqual(headerCaller.name, 'headerCaller');
    const oldTarget = outgoing(index, analysis, headerCaller)[0]?.item;
    assert.ok(oldTarget);
    assert.strictEqual(oldTarget.name, 'oldTarget');

    fs.writeFileSync(header, 'void newTarget() {}\nvoid headerCaller() { newTarget(); }');
    index.invalidateFile(header);
    const updated = index.indexOpenDocument(input);

    assert.deepStrictEqual(
      outgoing(index, updated, headerCaller).map(call => call.item.name),
      ['newTarget']
    );
    assert.deepStrictEqual(incoming(index, updated, oldTarget), []);
  });

  test('rebuilds conditional edges after configured defines change', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'conditional.h'), [
      '#if FEATURE',
      'void enabled() {}',
      'void choose() { enabled(); }',
      '#else',
      'void disabled() {}',
      'void choose() { disabled(); }',
      '#endif'
    ].join('\n'));
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const text = '#include "conditional.h"\nvoid root() { choose(); }';
    const input = { uri, version: 1, text };
    const index = createWorkspaceIndex({ defines: ['FEATURE=1'] });
    const analysis = index.indexOpenDocument(input);

    const choose = outgoing(index, analysis, prepare(index, analysis, text, 'root'))[0]?.item;
    assert.ok(choose);
    assert.strictEqual(choose.name, 'choose');
    const enabled = outgoing(index, analysis, choose)[0]?.item;
    assert.ok(enabled);
    assert.strictEqual(enabled.name, 'enabled');

    index.configure({ defines: ['FEATURE=0'] });
    const updated = index.indexOpenDocument(input);

    assert.deepStrictEqual(
      outgoing(index, updated, choose).map(call => call.item.name),
      ['disabled']
    );
    assert.deepStrictEqual(incoming(index, updated, enabled), []);
  });

  test('refreshes login-scope edges without rebinding stale items to an unrelated same-name definition', () => {
    const root = createTempDir();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const login = path.join(bin, '_login.axl');
    const loginUri = pathToFileURL(login).toString();
    fs.writeFileSync(login, [
      'void sharedTarget() {}',
      'void startupCaller() { sharedTarget(); }',
      'void main() {}'
    ].join('\n'));

    const index = createWorkspaceIndex({ sxmHome: root });
    const otherInput = {
      uri: pathToFileURL(path.join(root, 'other.axl')).toString(),
      version: 1,
      text: 'void sharedTarget() {}\nvoid wrongCaller() { sharedTarget(); }'
    };
    index.indexOpenDocument(otherInput);
    const consumerInput = {
      uri: pathToFileURL(path.join(root, 'consumer.axl')).toString(),
      version: 1,
      text: 'void consumer() { sharedTarget(); }'
    };
    const analysis = index.indexOpenDocument(consumerInput);

    const sharedTarget = prepare(index, analysis, consumerInput.text, 'sharedTarget');
    assert.strictEqual(sharedTarget.uri, loginUri);
    const callers = incoming(index, analysis, sharedTarget);
    assert.deepStrictEqual(callers.map(call => call.item.name), ['consumer', 'startupCaller']);
    const startupCaller = callers.find(call => call.item.name === 'startupCaller')?.item;
    assert.ok(startupCaller);

    fs.writeFileSync(login, [
      'void replacement() {}',
      'void startupCaller() { replacement(); }',
      'void main() {}'
    ].join('\n'));
    index.invalidateFile(login);
    index.indexOpenDocument(otherInput);
    const updated = index.indexOpenDocument(consumerInput);

    assert.deepStrictEqual(
      outgoing(index, updated, startupCaller).map(call => call.item.name),
      ['replacement']
    );
    assert.deepStrictEqual(incoming(index, updated, sharedTarget), []);
  });
});
