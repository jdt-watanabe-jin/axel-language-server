/** Run a cooperative analysis to completion for synchronous callers. */
export function runAnalysisSteps<T>(steps: Generator<void, T, void>): T {
  while (true) {
    const next = steps.next();
    if (next.done) { return next.value; }
  }
}
