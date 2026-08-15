import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'ci.yml');

test('CI uses immutable action revisions without persisting checkout credentials', async () => {
  const workflow = await fs.readFile(workflowPath, 'utf8');
  const actionUses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gm)].map((match) => match[1]);

  assert.ok(actionUses.length > 0, 'expected at least one GitHub Action dependency');
  for (const action of actionUses) {
    assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/, `${action} must use an immutable commit SHA`);
  }

  assert.match(
    workflow,
    /uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n\s*with:\s*\n\s*persist-credentials:\s*false\b/,
  );
});
