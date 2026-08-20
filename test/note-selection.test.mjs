import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const source = await fs.readFile(path.resolve(import.meta.dirname, '..', 'src', 'noteSelection.ts'), 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  fileName: 'noteSelection.ts',
  reportDiagnostics: true,
});
assert.deepEqual(transpiled.diagnostics, []);
const { selectAvailableNotePath } = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

test('startup selection skips a deleted configured starter and stale tabs', () => {
  const notes = [{ path: 'Projects/Current.md' }, { path: 'Ideas Renamed.md' }];
  assert.equal(
    selectAvailableNotePath(notes, ['Welcome.md', 'Ideas.md', 'Ideas Renamed.md']),
    'Ideas Renamed.md',
  );
});

test('note selection falls back to the first existing note or an explicit empty state', () => {
  assert.equal(selectAvailableNotePath([{ path: 'Only.md' }], ['Welcome.md']), 'Only.md');
  assert.equal(selectAvailableNotePath([], ['Welcome.md']), '');
});
