import * as fs from 'fs';
import type { CancellationToken } from 'vscode-languageserver/node';
import { cancellationCheckpoint, throwIfCancelled } from './cancellation';

export interface AnalysisOperation {
  sync(): void;
  async(): Promise<void>;
}
export type AnalysisStep = void | AnalysisOperation;

/** The same pipeline serves synchronous tools and cooperative LSP requests. */
export function runAnalysisSteps<T>(steps: Generator<AnalysisStep, T, void>): T {
  let next = steps.next();
  try {
    while (!next.done) {
      try { next.value?.sync(); }
      catch (error) { next = steps.throw(error); continue; }
      next = steps.next();
    }
    return next.value;
  } finally { steps.return(undefined as T); }
}

export async function runAnalysisStepsAsync<T>(steps: Generator<AnalysisStep, T, void>, token: CancellationToken,
  validate: () => void = () => undefined,
  scope: <R>(work: () => R) => R = work => work()): Promise<T> {
  const check = () => { throwIfCancelled(token); validate(); };
  try {
    check();
    let next = scope(() => steps.next());
    while (!next.done) {
      await cancellationCheckpoint(token);
      check();
      try { await next.value?.async(); }
      catch (error) { check(); next = scope(() => steps.throw(error)); continue; }
      check();
      next = scope(() => steps.next());
    }
    check();
    return next.value;
  } finally { scope(() => steps.return(undefined as T)); }
}

export function* readAnalysisFile(filePath: string): Generator<AnalysisStep, string, void> {
  let value = '';
  yield { sync() { value = fs.readFileSync(filePath, 'utf8'); },
    async async() { value = await fs.promises.readFile(filePath, 'utf8'); } };
  return value;
}

export function* statAnalysisFile(filePath: string): Generator<AnalysisStep, fs.Stats, void> {
  let value!: fs.Stats;
  yield { sync() { value = fs.statSync(filePath); }, async async() { value = await fs.promises.stat(filePath); } };
  return value;
}

/** Restore shared synchronous context before yielding to any other operation. */
export function* scopedAnalysisSteps<T>(steps: Generator<AnalysisStep, T, void>,
  scope: <R>(work: () => R) => R): Generator<AnalysisStep, T, void> {
  try {
    let next = scope(() => steps.next());
    while (!next.done) {
      try { yield next.value; }
      catch (error) { next = scope(() => steps.throw(error)); continue; }
      next = scope(() => steps.next());
    }
    return next.value;
  } finally { scope(() => steps.return(undefined as T)); }
}
