export type GraphPoint3D = { x: number; y: number; z: number };

export type GraphOrbit = { yaw: number; pitch: number };

export type GraphProjectedPoint = {
  x: number;
  y: number;
  depth: number;
  scale: number;
  cameraZ: number;
};

export const DEFAULT_GRAPH_ORBIT: GraphOrbit = Object.freeze({
  yaw: -Math.PI / 7,
  pitch: Math.PI / 10,
});

const DEFAULT_ORBIT_SENSITIVITY = .006;
const MAX_ORBIT_PITCH = Math.PI / 2 - .08;
const MAX_INPUT_MAGNITUDE = 1_000_000_000;
const MIN_CAMERA_DISTANCE = 64;
const MAX_CAMERA_DISTANCE = 10_000_000;
const MIN_PERSPECTIVE_SCALE = .25;
const MAX_PERSPECTIVE_SCALE = 4;
const MIN_GRAPH_CAMERA_DISTANCE = 420;
const GRAPH_CAMERA_RADIUS_MULTIPLIER = 1.8;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteBounded(value: number, fallback = 0, limit = MAX_INPUT_MAGNITUDE) {
  return Number.isFinite(value) ? clamp(value, -limit, limit) : fallback;
}

function normalizeAngle(value: number) {
  if (!Number.isFinite(value)) return 0;
  const turn = Math.PI * 2;
  const normalized = (value + Math.PI) % turn;
  return (normalized < 0 ? normalized + turn : normalized) - Math.PI;
}

function safeOrbit(orbit: GraphOrbit) {
  return {
    yaw: normalizeAngle(finiteBounded(orbit?.yaw)),
    pitch: clamp(finiteBounded(orbit?.pitch), -MAX_ORBIT_PITCH, MAX_ORBIT_PITCH),
  };
}

/**
 * Keeps the entire bounded graph volume in front of the camera at any orbit,
 * including very wide full-screen stages.
 */
export function graphCameraDistance(width: number, height: number, depthExtent: number) {
  const safeWidth = Math.abs(finiteBounded(width));
  const safeHeight = Math.abs(finiteBounded(height));
  const safeDepth = Math.abs(finiteBounded(depthExtent));
  const radius = Math.hypot(safeWidth / 2, safeHeight / 2, safeDepth);
  return Math.max(MIN_GRAPH_CAMERA_DISTANCE, radius * GRAPH_CAMERA_RADIUS_MULTIPLIER);
}

/**
 * Assigns a stable, case-sensitive depth without depending on input order.
 * The returned value is always finite and contained by the requested extent.
 */
export function stableGraphDepth(id: string, extent: number) {
  const safeExtent = Number.isFinite(extent) ? Math.abs(extent) : 0;
  if (safeExtent === 0) return 0;
  const value = String(id);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Final avalanche keeps similar paths from collecting on the same plane.
  hash = (hash ^ (hash >>> 16)) >>> 0;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash = (hash ^ (hash >>> 15)) >>> 0;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  const normalized = hash / 0xffffffff * 2 - 1;
  const depth = normalized * safeExtent;
  return Number.isFinite(depth) ? clamp(depth, -safeExtent, safeExtent) : 0;
}

/** Updates a mouse-controlled orbit. Yaw wraps; pitch stops short of gimbal lock. */
export function updateGraphOrbit(
  origin: GraphOrbit,
  deltaX: number,
  deltaY: number,
  sensitivity = DEFAULT_ORBIT_SENSITIVITY,
): GraphOrbit {
  const current = safeOrbit(origin);
  const safeSensitivity = finiteBounded(sensitivity, DEFAULT_ORBIT_SENSITIVITY, 1);
  const horizontal = finiteBounded(deltaX, 0, 1_000_000) * safeSensitivity;
  const vertical = finiteBounded(deltaY, 0, 1_000_000) * safeSensitivity;
  return {
    yaw: normalizeAngle(current.yaw + horizontal),
    pitch: clamp(current.pitch + vertical, -MAX_ORBIT_PITCH, MAX_ORBIT_PITCH),
  };
}

/**
 * Rotates a graph point around the supplied center and applies guarded
 * perspective. Positive depth is closer to the camera.
 */
export function projectGraphPoint(
  point: GraphPoint3D,
  center: { x: number; y: number },
  orbit: GraphOrbit,
  cameraDistance: number,
): GraphProjectedPoint {
  const safeCameraDistance = clamp(
    Math.abs(finiteBounded(cameraDistance, MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE)),
    MIN_CAMERA_DISTANCE,
    MAX_CAMERA_DISTANCE,
  );
  const pivotX = finiteBounded(center?.x);
  const pivotY = finiteBounded(center?.y);
  const relativeX = finiteBounded(point?.x) - pivotX;
  const relativeY = finiteBounded(point?.y) - pivotY;
  const relativeZ = finiteBounded(point?.z);
  const safe = safeOrbit(orbit);
  const cosineYaw = Math.cos(safe.yaw);
  const sineYaw = Math.sin(safe.yaw);
  const cosinePitch = Math.cos(safe.pitch);
  const sinePitch = Math.sin(safe.pitch);

  const yawX = relativeX * cosineYaw + relativeZ * sineYaw;
  const yawZ = -relativeX * sineYaw + relativeZ * cosineYaw;
  const pitchY = relativeY * cosinePitch - yawZ * sinePitch;
  const rotatedZ = relativeY * sinePitch + yawZ * cosinePitch;
  const depth = finiteBounded(rotatedZ);
  const minimumCameraZ = safeCameraDistance / MAX_PERSPECTIVE_SCALE;
  const maximumCameraZ = safeCameraDistance / MIN_PERSPECTIVE_SCALE;
  const cameraZ = clamp(safeCameraDistance - depth, minimumCameraZ, maximumCameraZ);
  const scale = clamp(safeCameraDistance / cameraZ, MIN_PERSPECTIVE_SCALE, MAX_PERSPECTIVE_SCALE);
  const projectedX = pivotX + yawX * scale;
  const projectedY = pivotY + pitchY * scale;

  return {
    x: finiteBounded(projectedX, pivotX, MAX_INPUT_MAGNITUDE * MAX_PERSPECTIVE_SCALE),
    y: finiteBounded(projectedY, pivotY, MAX_INPUT_MAGNITUDE * MAX_PERSPECTIVE_SCALE),
    depth,
    scale,
    cameraZ,
  };
}

/**
 * Converts a screen-space drag into the world-space camera plane. Applying the
 * current orbit to this vector yields `(deltaX / scale, deltaY / scale, 0)`.
 */
export function graphCameraPlaneDelta(
  deltaX: number,
  deltaY: number,
  orbit: GraphOrbit,
  perspectiveScale = 1,
): GraphPoint3D {
  const safeScale = clamp(Math.abs(finiteBounded(perspectiveScale, 1, 100)), .05, 100);
  const cameraX = finiteBounded(deltaX) / safeScale;
  const cameraY = finiteBounded(deltaY) / safeScale;
  const safe = safeOrbit(orbit);
  const cosineYaw = Math.cos(safe.yaw);
  const sineYaw = Math.sin(safe.yaw);
  const cosinePitch = Math.cos(safe.pitch);
  const sinePitch = Math.sin(safe.pitch);

  // Inverse pitch followed by inverse yaw returns camera-plane movement to
  // the graph's world coordinates.
  const inversePitchY = cameraY * cosinePitch;
  const inversePitchZ = -cameraY * sinePitch;
  return {
    x: finiteBounded(cameraX * cosineYaw - inversePitchZ * sineYaw),
    y: finiteBounded(inversePitchY),
    z: finiteBounded(cameraX * sineYaw + inversePitchZ * cosineYaw),
  };
}
