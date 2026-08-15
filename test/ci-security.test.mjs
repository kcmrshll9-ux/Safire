import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseWorkflowYaml, recursivelyCollectKey, recursivelyCollectMappingsWithKey } from './helpers/workflow-yaml.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDirectory = path.join(repositoryRoot, '.github', 'workflows');

function assertSafeActionReference(action) {
  assert.equal(typeof action, 'string');
  if (action.startsWith('./')) {
    assert.doesNotMatch(action, /\\/);
    assert.match(action, /^\.\/\.github\/actions\/[A-Za-z0-9._/-]+$/);
    assert.ok(!action.endsWith('/'));
    const localSegments = action.slice('./.github/actions/'.length).split('/');
    assert.ok(localSegments.every(segment => segment && segment !== '..' && segment !== '.'));
    return;
  }
  assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/, `${action} must use an immutable commit SHA`);
}

test('CI uses immutable action revisions without persisting checkout credentials', async () => {
  const workflowNames = (await fs.readdir(workflowDirectory)).filter(name => /\.ya?ml$/i.test(name)).sort();
  assert.ok(workflowNames.length > 0, 'expected at least one workflow');
  const workflows = await Promise.all(workflowNames.map(async name => ({
    name,
    parsed: parseWorkflowYaml(await fs.readFile(path.join(workflowDirectory, name), 'utf8')),
  })));
  const actionUses = workflows.flatMap(workflow => recursivelyCollectKey(workflow.parsed, 'uses'));

  assert.ok(actionUses.length > 0, 'expected at least one GitHub Action dependency');
  for (const action of actionUses) assertSafeActionReference(action);
  assert.ok(actionUses.includes('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'));
  assert.ok(actionUses.includes('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'));

  const checkoutSteps = workflows.flatMap(workflow => recursivelyCollectMappingsWithKey(workflow.parsed, 'uses'))
    .filter(step => String(step.uses || '').startsWith('actions/checkout@'));
  assert.ok(checkoutSteps.length > 0);
  for (const checkout of checkoutSteps) assert.equal(checkout.with?.['persist-credentials'], false);
});

test('structural workflow scan finds inline sequence uses keys and nested action references', () => {
  const parsed = parseWorkflowYaml(`
jobs:
  verify:
    steps:
      - name: pinned
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - uses: actions/upload-artifact@v4
      - name: nested
        with:
          metadata:
            uses: example/nested@main
`);

  const actionUses = recursivelyCollectKey(parsed, 'uses');
  assert.deepEqual(actionUses, [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/upload-artifact@v4',
    'example/nested@main',
  ]);
  assert.throws(() => actionUses.forEach(assertSafeActionReference), /immutable commit SHA/);
});

test('local action references are confined to explicit repository action paths', () => {
  assert.doesNotThrow(() => assertSafeActionReference('./.github/actions/synthetic-check'));
  for (const unsafe of [
    './action',
    './../outside',
    './.github/actions/../outside',
    './.github/actions/',
    '.\\.github\\actions\\synthetic-check',
  ]) {
    assert.throws(() => assertSafeActionReference(unsafe), undefined, unsafe);
  }
});
