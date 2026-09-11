import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AnalysisDiagnostic, AnalysisRange } from '../../types/analysis';

export interface RuntimeCase {
  id: string;
  source: string;
  expectedError: boolean | null;
  category?: string;
  compilerCodes: string[];
  evidenceId: string;
  expectedRange?: AnalysisRange;
}

export const typeCheckingFixtureRoot = path.resolve(__dirname, '../../../src/test/integration/fixtures/type-checking');

// The fixtures are independent of the extension checkout and of an installed AXEL runtime.
export function loadTypeCheckingCases(root = typeCheckingFixtureRoot): RuntimeCase[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.cases), 'Corpus manifest must contain cases');
  const ids = new Set<string>();
  return manifest.cases.map((entry: Record<string, unknown>) => {
    assert.ok(typeof entry.id === 'string' && /^(initial|round2)\/[a-z0-9_]+$/.test(entry.id), 'Invalid case ID');
    assert.ok(!ids.has(entry.id), `Duplicate case ID: ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.expectedError === true || entry.expectedError === false || entry.expectedError === null, `Invalid expectation: ${entry.id}`);
    assert.strictEqual(entry.sourceFile, `${entry.id}.axl`, `Invalid source path: ${entry.id}`);
    assert.ok(Array.isArray(entry.compilerCodes) && entry.compilerCodes.every(code => typeof code === 'string' && /^C\d+$/.test(code)), `Invalid compiler codes: ${entry.id}`);
    assert.ok(typeof entry.evidenceId === 'string' && entry.evidenceId.length > 0, `Missing evidence: ${entry.id}`);
    const bytes = fs.readFileSync(path.join(root, entry.sourceFile as string));
    assert.strictEqual(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Source hash mismatch: ${entry.id}`);
    const source = bytes.toString('utf8');
    if (entry.expectedError === true) {
      assert.ok(typeof entry.category === 'string' && entry.category.length > 0, `Missing primary category: ${entry.id}`);
      assert.ok(entry.compilerCodes.length > 0, `Missing compiler error: ${entry.id}`);
      const range = entry.expectedRange as AnalysisRange;
      const lines = source.split(/\r?\n/);
      assert.ok(range && Number.isInteger(range.start.line) && range.start.line >= 0 && range.end.line === range.start.line && range.start.line < lines.length, `Invalid error range: ${entry.id}`);
      assert.ok(range.start.character >= 0 && range.end.character > range.start.character && range.end.character <= lines[range.start.line].length, `Invalid error columns: ${entry.id}`);
      const observed = entry.observedErrors as { line: number; code: string }[];
      assert.ok(Array.isArray(observed) && observed.length > 0 && observed[0].line === range.start.line && entry.compilerCodes.includes(observed[0].code), `Missing primary error evidence: ${entry.id}`);
    } else {
      assert.deepStrictEqual(entry.compilerCodes, [], `Unexpected compiler error: ${entry.id}`);
      assert.strictEqual(entry.category, undefined, `Unexpected primary category: ${entry.id}`);
      assert.strictEqual(entry.expectedRange, undefined, `Unexpected error range: ${entry.id}`);
      assert.strictEqual(entry.observation, entry.expectedError === null ? 'compiler_crash' : 'accepted', `Invalid observation: ${entry.id}`);
    }
    return { id: entry.id, source, expectedError: entry.expectedError, category: entry.category as string | undefined,
      compilerCodes: entry.compilerCodes as string[], evidenceId: entry.evidenceId,
      expectedRange: entry.expectedRange as AnalysisRange | undefined };
  });
}


// Observed compiler evidence remains in the manifest even when another LS test
// covers the same condition more strongly. Values name the retained coverage.
const coveredElsewhere: Readonly<Record<string, string>> = {
  'initial/const_assign_value': 'initial/const_assign',
  'round2/return_void_expr': 'round2/return_void_value',
  'round2/nat_mul_control': 'initial/unused_function_error',
  'initial/natural_mul_natural': 'initial/unused_function_error',
  'round2/nat_int_control': 'initial/int_mul_natural',
  'round2/invalid_control': 'initial/invalid_control',
  'round2/baseline': 'initial/baseline',
  'initial/pointer_const_remove': 'initial/pointer_const_control',
  'round2/const_pointer_remove': 'round2/const_pointer_binding',
  'round2/user_conversion': 'round2/user_conversion_member',
  'round2/user_assignment_arg': 'round2/user_assign_member_arg',
  'round2/different_prototypes': 'round2/prototype_definition',
  'round2/prototype_newlines': 'round2/prototype_definition',
  'round2/nat_shadow': 'round2/natural_shadow_field + round2/natural_shadow_mul',
  'initial/natural_not': 'round2/type_nat_not',
  'round2/int_div_nat': 'round2/type_int_div_nat',
  'round2/nat_mod_float': 'round2/type_nat_mod_float',
  'initial/natural_ge': 'round2/type_nat_ge + natural comparison condition test',
  'initial/natural_add_int': 'typeCheckingOverloads: n+1 result',
  'initial/natural_mul_double': 'typeCheckingOverloads: n*2.0 result',
  'round2/nat_add_double': 'typeCheckingOverloads: n+2.0 result'
};

export function selectTypeCheckingConformanceCases(cases: readonly RuntimeCase[]): RuntimeCase[] {
  for (const id of Object.keys(coveredElsewhere)) {
    assert.ok(cases.some(c => c.id === id), `Unknown corpus selection: ${id}`);
  }
  return cases.filter(c => c.expectedError !== null && !Object.hasOwn(coveredElsewhere, c.id));
}

const resultTypeCases = new Set([
  'round2/type_nat_not', 'round2/type_int_div_nat',
  'round2/type_nat_mod_float', 'round2/type_nat_ge'
]);

/** Match causes and compiler-reported source lines, never merely the existence of an error. */
export function assertCaseDiagnostics(runtimeCase: RuntimeCase, diagnostics: readonly AnalysisDiagnostic[]): void {
  assert.notStrictEqual(runtimeCase.expectedError, null, 'Compiler crashes require separate tracking');
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  if (resultTypeCases.has(runtimeCase.id)) {
    assert.ok(!errors.some(d => d.code === 'axel.type.binary_operator' || d.code === 'axel.type.unary_operator'),
      `${runtimeCase.id}: the operation must succeed before its result is checked`);
  }
  const describe = () => JSON.stringify(errors.map(diagnostic => ({
    code: (diagnostic as AnalysisDiagnostic & { code?: string }).code,
    key: diagnostic.messageDescriptor?.key, range: diagnostic.range, message: diagnostic.message
  })), null, 2);
  if (!runtimeCase.expectedError) {
    assert.strictEqual(errors.length, 0, `${runtimeCase.id}: unexpected errors ${describe()}`);
    return;
  }
  assert.ok(errors.some(diagnostic => {
    const code = (diagnostic as AnalysisDiagnostic & { code?: string }).code;
    const category = code?.replace(/^axel\.(type|declaration)\./, '');
    const syntax = diagnostic.messageDescriptor?.key === 'Syntax error.' || diagnostic.messageDescriptor?.key === 'Missing {0}.';
    const range = runtimeCase.expectedRange!;
    return (category === runtimeCase.category || (runtimeCase.category === 'syntax' && syntax))
      && diagnostic.range.start.line === range.start.line
      && diagnostic.range.start.character >= range.start.character
      && diagnostic.range.start.character <= range.end.character;
  }), `${runtimeCase.id}: expected ${runtimeCase.category} on source line ${runtimeCase.expectedRange!.start.line + 1}, got ${describe()}`);
}
