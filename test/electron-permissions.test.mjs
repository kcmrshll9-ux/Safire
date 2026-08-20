import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { allowsSafireDesktopPermission } = require('../electron/permission-policy.cjs');

const appOrigin = 'http://127.0.0.1:5277';
const mainWebContents = Object.freeze({ id: 'main-web-contents' });

function permissionOptions(overrides = {}) {
  return {
    appOrigin,
    mainWebContents,
    webContents: mainWebContents,
    permission: 'fullscreen',
    requestingUrl: `${appOrigin}/projects/Graph%20UX%20Demo?view=full#graph`,
    isMainFrame: true,
    ...overrides,
  };
}

test('desktop permission policy allows fullscreen only for the main Safire page', () => {
  assert.equal(allowsSafireDesktopPermission(permissionOptions()), true);

  for (const permission of ['clipboard-read', 'geolocation', 'media', 'notifications', 'pointerLock', 'FULLSCREEN', '', undefined]) {
    assert.equal(
      allowsSafireDesktopPermission(permissionOptions({ permission })),
      false,
      `${String(permission)} must remain denied`,
    );
  }

  for (const webContents of [{ id: 'main-web-contents' }, Object.create(mainWebContents), null, undefined]) {
    assert.equal(
      allowsSafireDesktopPermission(permissionOptions({ webContents })),
      false,
      'permission must require exact main webContents identity',
    );
  }
  assert.equal(
    allowsSafireDesktopPermission(permissionOptions({ mainWebContents: null, webContents: null })),
    false,
    'missing webContents identities must not compare as trusted',
  );

  for (const isMainFrame of [false, null, undefined, 0, 1]) {
    assert.equal(
      allowsSafireDesktopPermission(permissionOptions({ isMainFrame })),
      false,
      'permission must require an explicit main-frame request',
    );
  }
});

test('desktop permission policy requires the exact configured loopback origin', () => {
  for (const requestingUrl of [
    'http://localhost:5277/projects/Graph%20UX%20Demo',
    'http://127.0.0.1:5278/projects/Graph%20UX%20Demo',
    'https://127.0.0.1:5277/projects/Graph%20UX%20Demo',
    'https://example.com/',
    'not a URL',
    'http://[',
    '',
    null,
    undefined,
  ]) {
    assert.equal(
      allowsSafireDesktopPermission(permissionOptions({ requestingUrl })),
      false,
      `${String(requestingUrl)} must remain denied`,
    );
  }

  for (const [untrustedOrigin, requestingUrl] of [
    ['https://example.com', 'https://example.com/graph'],
    ['http://localhost:5277', 'http://localhost:5277/graph'],
    ['http://127.0.0.1', 'http://127.0.0.1/graph'],
    ['file:///C:/Safire/index.html', 'file:///C:/Safire/index.html'],
    ['not an origin', 'https://example.com/'],
    ['', 'https://example.com/'],
    [null, 'https://example.com/'],
    [undefined, 'https://example.com/'],
  ]) {
    assert.equal(
      allowsSafireDesktopPermission(permissionOptions({ appOrigin: untrustedOrigin, requestingUrl })),
      false,
      `${String(untrustedOrigin)} must not become an allowed application origin`,
    );
  }
});

test('Electron delegates both permission handlers to the narrow desktop policy', async () => {
  const source = await fs.readFile(path.join(projectRoot, 'electron', 'main.cjs'), 'utf8');
  const contextStart = source.indexOf('const permissionContext');
  const checkStart = source.indexOf('setPermissionCheckHandler');
  const requestStart = source.indexOf('setPermissionRequestHandler');
  const handlersEnd = source.indexOf('const revealMainWindow', requestStart);

  assert.ok(contextStart >= 0, 'the trusted permission context must be configured');
  assert.ok(checkStart >= 0, 'permission check handler must be installed');
  assert.ok(checkStart > contextStart, 'permission handlers must follow the trusted context');
  assert.ok(requestStart > checkStart, 'permission request handler must follow the check handler');
  assert.ok(handlersEnd > requestStart, 'permission handler block must be bounded before window reveal wiring');

  const permissionContext = source.slice(contextStart, checkStart);
  const checkHandler = source.slice(checkStart, requestStart);
  const requestHandler = source.slice(requestStart, handlersEnd);
  assert.match(source, /require\(['"]\.\/permission-policy\.cjs['"]\)/);
  assert.match(permissionContext, /appOrigin:\s*new URL\(url\)\.origin/);
  assert.match(permissionContext, /mainWebContents:\s*mainWindow\.webContents/);
  assert.match(checkHandler, /allowsSafireDesktopPermission\(\{/);
  assert.match(checkHandler, /\.\.\.permissionContext/);
  assert.match(checkHandler, /\bwebContents\b/);
  assert.match(checkHandler, /\bpermission\b/);
  assert.match(checkHandler, /requestingOrigin/);
  assert.match(checkHandler, /details\?\.isMainFrame === true/);
  assert.match(requestHandler, /callback\(allowsSafireDesktopPermission\(\{/);
  assert.match(requestHandler, /\.\.\.permissionContext/);
  assert.match(requestHandler, /\bwebContents\b/);
  assert.match(requestHandler, /\bpermission\b/);
  assert.match(requestHandler, /details\?\.requestingUrl/);
  assert.match(requestHandler, /details\?\.isMainFrame === true/);
  assert.equal(source.match(/setPermissionCheckHandler/g)?.length, 1);
  assert.equal(source.match(/setPermissionRequestHandler/g)?.length, 1);
  assert.doesNotMatch(checkHandler, /=>\s*false/);
  assert.doesNotMatch(requestHandler, /callback\s*\(\s*false\s*\)/);
});
