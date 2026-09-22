import * as assert from 'assert';
import { CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { runAnalysisStepsAsync, type AnalysisStep } from '../../util/analysisSteps';

suite('Analysis I/O cancellation', () => {
  for (const lateFailure of [false, true]) {
    test('releases the pipeline before a pending I/O settles (' + lateFailure + ')', async () => {
      const source = new CancellationTokenSource();
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      let finish!: () => void, fail!: (error: Error) => void;
      const io = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      let closed = false, published = false;
      function* steps(): Generator<AnalysisStep, void, void> {
        try {
          yield {sync() {}, async() { started(); return io; }};
          published = true;
        } finally { closed = true; }
      }
      const result = runAnalysisStepsAsync(steps(), source.token);
      const rejected = assert.rejects(result, {code: LSPErrorCodes.RequestCancelled});
      await ready;
      source.cancel();
      // No wall-clock threshold: cancellation must settle while I/O is unresolved.
      let settled = false;
      void result.then(() => { settled = true; }, () => { settled = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      try {
        assert.ok(settled, 'The cancelled I/O must not hold the serialized analysis queue');
        assert.ok(closed);
        assert.strictEqual(published, false);
      } finally {
        if (lateFailure) { fail(new Error('late read failure')); } else { finish(); }
        await rejected;
        source.dispose();
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.strictEqual(published, false);
    });
  }
});
