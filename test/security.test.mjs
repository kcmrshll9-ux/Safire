import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { assertPublicWebUrl, startSafireServer } from '../server.mjs';

function requestStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { headers }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
  });
}

async function withTemporaryVault(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-security-test-'));
  const vault = path.join(root, 'vault');
  const backend = await startSafireServer({ vaultDir: vault, host: '127.0.0.1', port: 0, log: () => {} });
  try {
    return await run({ root, vault, backend });
  } finally {
    await new Promise(resolve => backend.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('Safire always binds its HTTP service to loopback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-loopback-test-'));
  const backend = await startSafireServer({ vaultDir: path.join(root, 'vault'), host: '0.0.0.0', port: 0, log: () => {} });
  try {
    assert.equal(backend.host, '127.0.0.1');
  } finally {
    await new Promise(resolve => backend.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Safire accepts only loopback same-origin API browser requests', async () => {
  await withTemporaryVault(async ({ backend }) => {
    const accepted = await fetch(`${backend.url}/api/health`, {
      headers: { Origin: backend.url, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    assert.equal(accepted.headers.get('pragma'), 'no-cache');
    const contentSecurityPolicy = accepted.headers.get('content-security-policy') || '';
    assert.match(contentSecurityPolicy, /(?:^|;)\s*img-src\s+'self'\s*(?:;|$)/);
    assert.doesNotMatch(contentSecurityPolicy, /img\.youtube\.com/i);

    assert.equal(await requestStatus(`${backend.url}/api/health`, { Host: 'notes.example' }), 403);

    const hostileOrigin = await fetch(`${backend.url}/api/health`, { headers: { Origin: 'https://notes.example' } });
    assert.equal(hostileOrigin.status, 403);

    const crossSite = await fetch(`${backend.url}/api/health`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
  });
});

test('route-equivalent API paths enforce origin, metadata, cache and attachment policies', async () => {
  await withTemporaryVault(async ({ vault, backend }) => {
    for (const endpoint of ['/API/daily', '/aPi/library/refresh']) {
      for (const headers of [{ Origin: 'https://hostile.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        const response = await fetch(`${backend.url}${endpoint}`, { method: 'POST', headers });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
    }
    assert.equal((await fs.readdir(path.join(vault, 'Daily Notes')).catch(() => [])).length, 0);
    const accepted = await fetch(`${backend.url}/aPi/daily`, { method: 'POST', headers: { Origin: backend.url, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    const note = await accepted.json();
    assert.match(await fs.readFile(path.join(vault, note.path), 'utf8'), /## Notes/);
    const raw = await fetch(`${backend.url}/API/ATTACHMENT?path=Attachments/missing.pdf&raw=1`);
    assert.equal(raw.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(raw.headers.get('cache-control'), 'no-store');
  });
});

test('configuration API rejects linked leaves without reading or changing outside files', async t => {
  await withTemporaryVault(async ({ root, vault, backend }) => {
    const cases = [
      ['settings.json', '/api/settings', 'PUT', { theme: 'light' }],
      ['workspace.json', '/api/workspace', 'POST', { name: 'Example', query: 'notes' }, '/api/workspace/search'],
      ['web-clip-templates.json', '/api/web-clip/templates', 'POST', { id: 'example', name: 'Example', folder: 'Research', description: 'Example', body: '{{content}}' }],
    ];
    for (const [name, endpoint, method, body, writeEndpoint] of cases) {
      const leaf = path.join(vault, '.safire', name);
      const outside = path.join(root, `outside-${name}`);
      await fs.writeFile(outside, 'outside non-JSON sentinel');
      await fs.rm(leaf, { force: true });
      try { await fs.symlink(outside, leaf, 'file'); }
      catch (error) {
        if (['EPERM', 'ENOSYS'].includes(error.code)) { t.skip(`File symlinks unavailable: ${error.code}`); return; }
        throw error;
      }
      const read = await fetch(`${backend.url}${endpoint}`);
      assert.equal(read.status, 400);
      const write = await fetch(`${backend.url}${writeEndpoint || endpoint}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(write.status, 400);
      assert.equal(await fs.readFile(outside, 'utf8'), 'outside non-JSON sentinel');
      await fs.unlink(leaf);
    }
  });
});

test('Safire API responses do not disclose absolute vault paths', async () => {
  await withTemporaryVault(async ({ root, vault, backend }) => {
    for (const endpoint of ['/api/health', '/api/tree', '/api/notes']) {
      const response = await fetch(`${backend.url}${endpoint}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.vault, path.basename(vault));
      assert.equal(JSON.stringify(body).includes(path.resolve(root)), false);
    }

    const missing = await fetch(`${backend.url}/api/note?path=Missing.md`);
    assert.equal(missing.status, 400);
    const error = await missing.json();
    assert.equal(error.error, 'The requested item was not found');
    assert.equal(JSON.stringify(error).includes(path.resolve(root)), false);
  });
});

test('large existing custom template collections work and oversized collections preserve built-in clipping', async () => {
  await withTemporaryVault(async ({ vault, backend }) => {
    const custom = Array.from({ length: 12 }, (_, index) => ({ id: `custom-${index}`, name: `Template ${index}`, folder: 'Research', body: '界'.repeat(30000) }));
    const filename = path.join(vault, '.safire', 'web-clip-templates.json');
    await fs.writeFile(filename, JSON.stringify({ custom }));
    const ordinary = await fetch(`${backend.url}/api/web-clip/templates`).then(r => r.json());
    assert.ok(ordinary.templates.some(template => template.id === 'custom-11'));
    const oversized = JSON.stringify({ custom: Array.from({ length: 100 }, (_, index) => ({ ...custom[0], id: `large-${index}` })) });
    await fs.writeFile(filename, oversized);
    const limited = await fetch(`${backend.url}/api/web-clip/templates`).then(r => r.json());
    assert.match(limited.warning, /preserved/);
    assert.ok(limited.templates.some(template => template.id === 'article'));
    const clipped = await fetch(`${backend.url}/api/web-clip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/article', html: '<html><title>Local fixture</title><article>Useful text.</article></html>', templateId: 'article' }) });
    assert.equal(clipped.status, 201);
    const write = await fetch(`${backend.url}/api/web-clip/templates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...custom[0], id: 'new-template' }) });
    assert.equal(write.status, 400);
    assert.equal(await fs.readFile(filename, 'utf8'), oversized);
  });
});

test('Safire sandboxes document attachment previews', async () => {
  await withTemporaryVault(async ({ backend }) => {
    const uploaded = await fetch(`${backend.url}/api/attachment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'sample.pdf', data: Buffer.from('%PDF test').toString('base64') }),
    });
    assert.equal(uploaded.status, 201);
    const { path: attachmentPath } = await uploaded.json();
    const endpoint = `${backend.url}/api/attachment?path=${encodeURIComponent(attachmentPath)}`;

    const preview = await fetch(endpoint, { headers: { Accept: 'text/html' } });
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /<iframe[^>]+sandbox(?:\s|>)/i);

    const raw = await fetch(`${endpoint}&raw=1`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(raw.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
    assert.equal(raw.headers.get('cache-control'), 'no-store');
  });
});

test('Safire rejects note paths that traverse an NTFS junction', async (t) => {
  await withTemporaryVault(async ({ root, vault, backend }) => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'outside.md'), 'outside fixture', 'utf8');
    try {
      await fs.symlink(outside, path.join(vault, 'linked'), 'junction');
    } catch (error) {
      t.skip(`Windows junctions are unavailable in this environment: ${error.message}`);
      return;
    }
    const response = await fetch(`${backend.url}/api/note?path=linked/outside.md`);
    assert.equal(response.status, 400);
  });
});

test('vault health rejects an NTFS junction at the backup root without traversing it', async (t) => {
  await withTemporaryVault(async ({ root, vault, backend }) => {
    const outside = path.join(root, 'outside-backups');
    const sentinel = path.join(outside, 'outside-sentinel.bak');
    await fs.mkdir(outside);
    await fs.writeFile(sentinel, 'outside backup sentinel', 'utf8');
    try {
      await fs.symlink(outside, path.join(vault, '.safire-backups'), 'junction');
    } catch (error) {
      t.skip(`Windows junctions are unavailable in this environment: ${error.message}`);
      return;
    }

    const response = await fetch(`${backend.url}/api/vault-health`);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, 'Vault paths cannot use symlinks or junctions');
    assert.doesNotMatch(JSON.stringify(body), /backupCount|noteCount|outside-sentinel/i);
    assert.equal(JSON.stringify(body).includes(path.resolve(root)), false);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside backup sentinel');
  });
});

test('all HTTP backup traversal entry points reject an NTFS junction root', async (t) => {
  await withTemporaryVault(async ({ root, vault, backend }) => {
    const outside = path.join(root, 'outside-backup-api');
    const sentinel = path.join(outside, 'outside-sentinel.bak');
    await fs.mkdir(outside);
    await fs.writeFile(sentinel, 'outside backup sentinel', 'utf8');
    try {
      await fs.symlink(outside, path.join(vault, '.safire-backups'), 'junction');
    } catch (error) {
      t.skip(`Windows junctions are unavailable in this environment: ${error.message}`);
      return;
    }

    const attempts = [
      fetch(`${backend.url}/api/backups`),
      fetch(`${backend.url}/api/backup?id=${encodeURIComponent('outside-sentinel.bak')}`),
      fetch(`${backend.url}/api/backup/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'outside-sentinel.bak', path: 'Restored.md' }),
      }),
    ];
    for (const response of await Promise.all(attempts)) {
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error, 'Vault paths cannot use symlinks or junctions');
      assert.doesNotMatch(JSON.stringify(body), /outside-sentinel|backupCount|noteCount/i);
      assert.equal(JSON.stringify(body).includes(path.resolve(root)), false);
    }
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside backup sentinel');
    await assert.rejects(() => fs.access(path.join(vault, 'Restored.md')), { code: 'ENOENT' });
  });
});

test('Safire rejects link-local and loopback web-clip addresses before fetching', async () => {
  await assert.rejects(() => assertPublicWebUrl(new URL('http://169.254.169.254/latest/meta-data')));
  await assert.rejects(() => assertPublicWebUrl(new URL('http://[::1]/')));
  await assert.rejects(() => assertPublicWebUrl(new URL('http://127.0.0.1/')));
});
