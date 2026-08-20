import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadGraphOrganization() {
  const source = await fs.readFile(path.join(projectRoot, 'src', 'graphOrganization.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

test('project folder groups are relative to the selected project', async () => {
  const { projectFolderGroup } = await loadGraphOrganization();
  assert.equal(projectFolderGroup('Atlas', 'Atlas'), 'Project root');
  assert.equal(projectFolderGroup('Atlas/Research', 'Atlas'), 'Research');
  assert.equal(projectFolderGroup('Atlas/Research/Interviews', 'Atlas'), 'Research');
  assert.equal(projectFolderGroup('Beta/Notes', 'Beta'), 'Notes');
  assert.equal(projectFolderGroup('', 'Atlas'), 'Project root');
});

test('project root stays central while project folders receive stable cluster anchors', async () => {
  const { graphGroupAnchors, graphLayoutBounds } = await loadGraphOrganization();
  const groups = ['Meetings', 'Plan', 'Project root', 'Research'];
  const anchors = graphGroupAnchors(groups, 800, 600);
  assert.deepEqual(anchors.get('Project root'), { x: 400, y: 300 });
  assert.deepEqual([...anchors], [...graphGroupAnchors(groups, 800, 600)]);
  assert.equal(new Set([...anchors.values()].map(point => `${point.x}:${point.y}`)).size, groups.length);

  const bounds = graphLayoutBounds(800, 600);
  for (const point of anchors.values()) {
    assert.ok(point.x >= bounds.minimumX && point.x <= bounds.maximumX);
    assert.ok(point.y >= bounds.minimumY && point.y <= bounds.maximumY);
  }
});
