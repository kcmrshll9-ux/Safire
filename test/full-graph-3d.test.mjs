import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadGraphProjection() {
  const source = await fs.readFile(path.join(projectRoot, 'src', 'graphProjection.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

test('stable graph depth is deterministic, case-sensitive, bounded, and finite', async () => {
  const { stableGraphDepth } = await loadGraphProjection();
  const ids = ['Project/Overview.md', 'Project/Reports/Status.md', 'Project/reports/Status.md'];
  const forward = new Map(ids.map(id => [id, stableGraphDepth(id, 140)]));
  const reversed = new Map([...ids].reverse().map(id => [id, stableGraphDepth(id, 140)]));

  assert.deepEqual(forward, reversed);
  assert.notEqual(forward.get(ids[1]), forward.get(ids[2]));
  for (const depth of forward.values()) {
    assert.equal(Number.isFinite(depth), true);
    assert.ok(depth >= -140 && depth <= 140);
  }
  assert.equal(stableGraphDepth('Project/Overview.md', 0), 0);
  assert.equal(stableGraphDepth('Project/Overview.md', Number.POSITIVE_INFINITY), 0);
});

test('zero and known graph rotations project around the supplied center', async () => {
  const { projectGraphPoint } = await loadGraphProjection();
  const center = { x: 100, y: 50 };
  const point = { x: 110, y: 80, z: 20 };
  const projected = projectGraphPoint(point, center, { yaw: 0, pitch: 0 }, 200);

  closeTo(projected.depth, 20);
  closeTo(projected.cameraZ, 180);
  closeTo(projected.scale, 200 / 180);
  closeTo(projected.x, 100 + 10 * projected.scale);
  closeTo(projected.y, 50 + 30 * projected.scale);

  const yawed = projectGraphPoint({ x: 110, y: 50, z: 0 }, center, { yaw: Math.PI / 2, pitch: 0 }, 200);
  closeTo(yawed.x, center.x);
  closeTo(yawed.y, center.y);
  closeTo(yawed.depth, -10);
  closeTo(yawed.cameraZ, 210);

  const pitched = projectGraphPoint({ x: 100, y: 60, z: 0 }, center, { yaw: 0, pitch: Math.PI / 4 }, 200);
  closeTo(pitched.depth, Math.sqrt(50));
  closeTo((pitched.y - center.y) / pitched.scale, Math.sqrt(50));
});

test('perspective projection is non-mutating, depth-aware, and finite for hostile numbers', async () => {
  const { projectGraphPoint } = await loadGraphProjection();
  const point = Object.freeze({ x: 30, y: -12, z: 75 });
  const center = Object.freeze({ x: 5, y: 7 });
  const orbit = Object.freeze({ yaw: .32, pitch: -.18 });
  const snapshots = { point: { ...point }, center: { ...center }, orbit: { ...orbit } };
  const near = projectGraphPoint(point, center, orbit, 400);
  const far = projectGraphPoint({ ...point, z: -75 }, center, orbit, 400);

  assert.deepEqual(point, snapshots.point);
  assert.deepEqual(center, snapshots.center);
  assert.deepEqual(orbit, snapshots.orbit);
  assert.ok(near.scale > far.scale);
  for (const value of Object.values(near)) assert.equal(Number.isFinite(value), true);

  const hostile = projectGraphPoint(
    { x: Number.POSITIVE_INFINITY, y: Number.NaN, z: Number.NEGATIVE_INFINITY },
    { x: Number.NaN, y: Number.POSITIVE_INFINITY },
    { yaw: Number.POSITIVE_INFINITY, pitch: Number.NaN },
    0,
  );
  for (const value of Object.values(hostile)) assert.equal(Number.isFinite(value), true);
  assert.ok(hostile.scale >= .25 && hostile.scale <= 4);
  assert.ok(hostile.cameraZ > 0);
});

test('camera distance keeps wide full-screen graph bounds in front of every orbit', async () => {
  const { graphCameraDistance, projectGraphPoint } = await loadGraphProjection();
  const width = 4_000;
  const height = 300;
  const depthExtent = 110;
  const center = { x: width / 2, y: height / 2 };
  const cameraDistance = graphCameraDistance(width, height, depthExtent);
  const radius = Math.hypot(width / 2, height / 2, depthExtent);
  assert.ok(cameraDistance >= radius * 1.79);

  for (const yaw of [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
    for (const pitch of [-1.2, 0, 1.2]) {
      for (const x of [0, width]) {
        for (const y of [0, height]) {
          for (const z of [-depthExtent, depthExtent]) {
            const projected = projectGraphPoint({ x, y, z }, center, { yaw, pitch }, cameraDistance);
            assert.ok(projected.cameraZ > 0);
            assert.ok(projected.scale <= 2.3, `${projected.scale} crossed the guarded near plane`);
          }
        }
      }
    }
  }
  assert.equal(Number.isFinite(graphCameraDistance(Number.POSITIVE_INFINITY, Number.NaN, -50)), true);
});

test('mouse orbit updates yaw, clamps pitch, wraps safely, and does not mutate its origin', async () => {
  const { DEFAULT_GRAPH_ORBIT, updateGraphOrbit } = await loadGraphProjection();
  const origin = Object.freeze({ yaw: 0, pitch: 0 });
  const moved = updateGraphOrbit(origin, 100, -50, .01);

  assert.deepEqual(origin, { yaw: 0, pitch: 0 });
  closeTo(moved.yaw, 1);
  closeTo(moved.pitch, -.5);
  const upper = updateGraphOrbit(origin, 0, Number.MAX_VALUE, 1);
  const lower = updateGraphOrbit(origin, 0, -Number.MAX_VALUE, 1);
  assert.ok(upper.pitch < Math.PI / 2 && upper.pitch > 0);
  assert.ok(lower.pitch > -Math.PI / 2 && lower.pitch < 0);
  assert.equal(Number.isFinite(updateGraphOrbit(origin, Number.MAX_VALUE, 0, 1).yaw), true);
  assert.equal(Number.isFinite(DEFAULT_GRAPH_ORBIT.yaw), true);
  assert.equal(Number.isFinite(DEFAULT_GRAPH_ORBIT.pitch), true);
});

test('camera-plane drag deltas invert orbit, respect perspective, and remain finite', async () => {
  const { graphCameraPlaneDelta } = await loadGraphProjection();
  assert.deepEqual(graphCameraPlaneDelta(12, -6, { yaw: 0, pitch: 0 }), { x: 12, y: -6, z: 0 });
  assert.deepEqual(graphCameraPlaneDelta(12, -6, { yaw: 0, pitch: 0 }, 2), { x: 6, y: -3, z: 0 });

  const yawed = graphCameraPlaneDelta(10, 0, { yaw: Math.PI / 2, pitch: 0 });
  closeTo(yawed.x, 0);
  closeTo(yawed.y, 0);
  closeTo(yawed.z, 10);

  const pitched = graphCameraPlaneDelta(0, 10, { yaw: 0, pitch: Math.PI / 4 });
  closeTo(pitched.x, 0);
  closeTo(pitched.y, Math.sqrt(50));
  closeTo(pitched.z, -Math.sqrt(50));

  const hostile = graphCameraPlaneDelta(
    Number.POSITIVE_INFINITY,
    Number.NaN,
    { yaw: Number.NaN, pitch: Number.POSITIVE_INFINITY },
    0,
  );
  for (const value of Object.values(hostile)) assert.equal(Number.isFinite(value), true);
});
