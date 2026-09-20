import * as assert from 'assert';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import type { FoldingRangeParams, InitializeParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { createAxelParser } from '../../../analyzer/axelParser';
import { registerHandlers } from '../../support/configuredHandlers';
import { runAnalysisSteps } from '../../../util/analysisSteps';
import { createHandlerConnection, emptyAnalysis } from '../../support/handlerFixtures';

suite('Folding range syntax-only requests', () => {
  const uri = 'file:///folding/main.axl';
  const params = { textDocument: { uri } };

  test('does not load includes, forced includes or login dependencies', () => {
    const workspace = new WorkspaceIndex({ sxmHome: 'Z:/missing-folding-sdk',
      forcedIncludeFiles: ['Z:/missing-folding-forced.h'] });
    // Semantic processing cannot be used as a fallback for this request.
    workspace.analyzeDocument = () => { throw new Error('Semantic analysis must not run'); };
    const result = runAnalysisSteps(workspace.getFoldingRangesSteps({ uri, version: 1,
      text: '#include "missing.h"\nvoid main() {\nint value;\n}' }));
    assert.deepStrictEqual(result, [{ startLine: 1, endLine: 2 }]);
  });

  test('reuses an available original syntax tree and releases it after folding', () => {
    const parser = createAxelParser();
    const parse = parser.parse.bind(parser);
    let parses = 0;
    parser.parse = (...args: Parameters<typeof parser.parse>) => { parses++; return parse(...args); };
    const analyzer = new DocumentAnalyzer(parser);
    const input = { uri, version: 1, text: 'void main() {\nint value;\n}' };
    analyzer.analyzeDocument(input, false);
    const before = parses;
    assert.deepStrictEqual(runAnalysisSteps(analyzer.getFoldingRangesSteps(input)), [{ startLine: 0, endLine: 1 }]);
    assert.strictEqual(parses, before);
    const updated = { ...input, version: 2, text: 'void main() {}' };
    assert.deepStrictEqual(runAnalysisSteps(analyzer.getFoldingRangesSteps(updated)), []);
    assert.strictEqual(parses, before + 1);
  });

  function fixture() {
    let diagnostic!: (params: FoldingRangeParams, token?: CancellationToken) => Promise<unknown>;
    let folding!: (params: FoldingRangeParams, token?: CancellationToken) => Promise<unknown>;
    let initialize!: (params: InitializeParams, token: CancellationToken) => unknown;
    let change!: (event: { document: TextDocument }) => void;
    let close!: (event: { document: TextDocument }) => void;
    let shutdown!: (token: CancellationToken) => unknown;
    let document = TextDocument.create(uri, 'axel', 1, 'void main() {\nint value;\n}');
    const workspace = new WorkspaceIndex();
    const errors: string[] = [];
    const connection = createHandlerConnection({
      sendNotification: () => undefined,
      onInitialize: (handler: typeof initialize) => { initialize = handler; },
      onShutdown: (handler: typeof shutdown) => { shutdown = handler; },
      languages: {
        diagnostics: { on: (handler: typeof diagnostic) => { diagnostic = handler; }, refresh: () => undefined },
        semanticTokens: { on: () => undefined, refresh: () => undefined },
        foldingRange: { on: (handler: typeof folding) => { folding = handler; } }
      }
    });
    registerHandlers({ connection: connection as never, analyzer: workspace,
      documents: {
        get: (key: string) => key === uri ? document : undefined,
        onDidOpen: () => undefined,
        onDidChangeContent: (handler: typeof change) => { change = handler; },
        onDidClose: (handler: typeof close) => { close = handler; }
      } as never,
      logger: { error: (message: string) => errors.push(message) }
    });
    initialize({ capabilities: { workspace: { configuration: true } }, processId: null, rootUri: null, initializationOptions: { errorSquiggles: 'enabled' } }, CancellationToken.None);
    return {
      workspace, errors,
      diagnostic: () => diagnostic(params),
      request: (token = CancellationToken.None) => folding(params, token),
      update: () => {
        document = TextDocument.create(uri, 'axel', 2, 'void main() {}');
        change({ document });
      },
      close: () => close({ document }),
      dispose: () => shutdown(CancellationToken.None)
    };
  }

  test('does not queue behind a running dependency or semantic request', async () => {
    const f = fixture();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.workspace.analyzeRequestDocument = async () => {
      entered();
      await blocked;
      return emptyAnalysis({ uri });
    };
    const semantic = f.diagnostic();
    let timer: NodeJS.Timeout | undefined;
    try {
      await started;
      const result = await Promise.race([f.request(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Folding queued behind semantic analysis')), 200);
      })]);
      assert.deepStrictEqual(result, [{ startLine: 0, endLine: 1 }]);
    } finally {
      clearTimeout(timer);
      release();
      await semantic;
      f.dispose();
    }
  });

  test('does not await pending semantic indexing', async () => {
    const f = fixture();
    // Flushing pending changes would await this indefinitely, even though folding needs only text.
    f.workspace.analyzeForegroundDocumentAsync = () => new Promise(() => undefined);
    try {
      f.update();
      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([f.request(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Folding waited for semantic indexing')), 1_000);
        })]);
        assert.deepStrictEqual(result, []);
      } finally { clearTimeout(timer); }
    } finally { f.dispose(); }
  });

  test('cancels a running traversal and accepts the next request', async () => {
    const f = fixture();
    const source = new CancellationTokenSource();
    const collect = f.workspace.getFoldingRangesSteps.bind(f.workspace);
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    f.workspace.getFoldingRangesSteps = function* (input) {
      const steps = collect(input);
      try {
        let step = steps.next();
        // DocumentAnalyzer yields before parsing; collector then yields with a real root in scope.
        if (!step.done) { step = steps.next(); }
        started();
        while (!step.done) { yield step.value; step = steps.next(); }
        return step.value;
      } finally { steps.return([]); }
    };
    try {
      const request = f.request(source.token);
      const rejected = assert.rejects(request, error => error instanceof ResponseError
        && error.code === LSPErrorCodes.RequestCancelled);
      await entered;
      source.cancel();
      await rejected;
      assert.deepStrictEqual(await f.request(), [{ startLine: 0, endLine: 1 }]);
      assert.deepStrictEqual(f.errors, []);
    } finally { source.dispose(); f.dispose(); }
  });

  for (const action of ['update', 'close'] as const) {
    test(`rejects a stale folding request on ${action}`, async () => {
      const f = fixture();
      const collect = f.workspace.getFoldingRangesSteps.bind(f.workspace);
      let started!: () => void;
      const entered = new Promise<void>(resolve => { started = resolve; });
      f.workspace.getFoldingRangesSteps = function* (input) {
        const steps = collect(input);
        try {
          let step = steps.next();
          // DocumentAnalyzer yields before parsing; collector then yields with a real root in scope.
          if (!step.done) { step = steps.next(); }
          started();
          while (!step.done) { yield step.value; step = steps.next(); }
          return step.value;
        } finally { steps.return([]); }
      };
      try {
        const request = f.request();
        const rejected = assert.rejects(request, error => error instanceof ResponseError
          && error.code === LSPErrorCodes.ContentModified);
        await entered;
        f[action]();
        await rejected;
        assert.deepStrictEqual(f.errors, []);
      } finally { f.dispose(); }
    });
  }
});
