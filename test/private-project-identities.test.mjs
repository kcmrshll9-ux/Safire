import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.codex', '.git', 'dist', 'node_modules', 'release']);
const textExtensions = new Set([
  '.cjs', '.cmd', '.css', '.html', '.js', '.json', '.md', '.mjs', '.sh', '.svg',
  '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);
const privateIdentities = [
  ['har', 'ry'].join(''),
  ['molt', 'book'].join(''),
];
const retiredProductPhrases = [
  ['local', 'first'].join('-'),
];

async function sourceTextFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceTextFiles(absolutePath));
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) files.push(absolutePath);
  }
  return files;
}

test('private project identities are absent from shipped source, documentation, examples, and tests', async () => {
  const violations = [];
  for (const absolutePath of await sourceTextFiles(projectRoot)) {
    const relativePath = path.relative(projectRoot, absolutePath).replaceAll(path.sep, '/');
    const content = await fs.readFile(absolutePath, 'utf8');
    for (const identity of privateIdentities) {
      if (relativePath.toLowerCase().includes(identity) || content.toLowerCase().includes(identity)) {
        violations.push(relativePath);
      }
    }
  }
  assert.deepEqual([...new Set(violations)].sort(), []);
});

test('retired product phrases are absent from shipped source, documentation, examples, and tests', async () => {
  const violations = [];
  for (const absolutePath of await sourceTextFiles(projectRoot)) {
    const relativePath = path.relative(projectRoot, absolutePath).replaceAll(path.sep, '/');
    const content = await fs.readFile(absolutePath, 'utf8');
    for (const phrase of retiredProductPhrases) {
      if (relativePath.toLowerCase().includes(phrase) || content.toLowerCase().includes(phrase)) {
        violations.push(relativePath);
      }
    }
  }
  assert.deepEqual([...new Set(violations)].sort(), []);
});
