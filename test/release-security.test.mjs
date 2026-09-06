import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync, createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { createVaultJsonStore } from '../lib/vault-json-store.mjs';
import { createVaultCatalog } from '../lib/vault-catalog.mjs';
import { MAX_CLIP_CHARACTERS, readClippableHtml } from '../lib/web-response.mjs';

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-release-security-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const htmlResponse = body => new Response(body, { headers: { 'Content-Type': 'text/html' } });

test('vault JSON preserves damaged files and supports bounded ordinary settings writes', async t => {
  const root = await temporaryRoot(t);
  const store = createVaultJsonStore(root);
  assert.deepEqual(await store.read('settings.json', { theme: 'dark' }, { initialize: true }), { theme: 'dark' });
  const file = path.join(root, '.safire', 'settings.json');
  await fs.writeFile(file, 'damaged but preserved');
  assert.deepEqual(await store.read('settings.json', { theme: 'dark' }, { initialize: true }), { theme: 'dark' });
  assert.equal(await fs.readFile(file, 'utf8'), 'damaged but preserved');
  await store.write('settings.json', { theme: 'light' });
  assert.deepEqual(await store.read('settings.json', {}), { theme: 'light' });
  await assert.rejects(store.write('settings.json', { huge: 'x'.repeat(1024 * 1024) }), /too large/);
  assert.deepEqual(await store.read('settings.json', {}), { theme: 'light' });
  await assert.rejects(store.read('../outside.json', {}), /Unknown/);
});

test('all configuration leaves reject existing, malformed and dangling outside symlinks', async t => {
  const root = await temporaryRoot(t);
  const vault = path.join(root, 'vault');
  await fs.mkdir(path.join(vault, '.safire'), { recursive: true });
  const store = createVaultJsonStore(vault);
  for (const name of ['settings.json', 'workspace.json', 'web-clip-templates.json']) {
    for (const content of ['{"outside":"sentinel"}', 'not JSON', null]) {
      const outside = path.join(root, 'outside.json');
      const leaf = path.join(vault, '.safire', name);
      if (content !== null) await fs.writeFile(outside, content);
      else await fs.rm(outside, { force: true });
      try { await fs.symlink(outside, leaf, 'file'); }
      catch (error) {
        if (['EPERM', 'ENOSYS'].includes(error.code)) { t.skip(`File symlinks unavailable: ${error.code}`); return; }
        throw error;
      }
      await assert.rejects(store.read(name, {}, { initialize: true }), /symlinks|junctions/);
      await assert.rejects(store.write(name, { changed: true }), /symlinks|junctions/);
      if (content !== null) assert.equal(await fs.readFile(outside, 'utf8'), content);
      else await assert.rejects(fs.stat(outside), { code: 'ENOENT' });
      await fs.unlink(leaf);
    }
  }
});

test('configuration operations recheck a replaced parent directory', async t => {
  const root = await temporaryRoot(t);
  const vault = path.join(root, 'vault');
  await fs.mkdir(vault);
  const store = createVaultJsonStore(vault);
  await store.read('settings.json', {}, { initialize: true });
  const control = path.join(vault, '.safire');
  await fs.rename(control, path.join(vault, '.safire-original'));
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'settings.json'), 'outside sentinel');
  await fs.symlink(outside, control, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.read('settings.json', {}, { initialize: true }), /symlinks|junctions/);
  await assert.rejects(store.write('settings.json', {}), /symlinks|junctions/);
  assert.equal(await fs.readFile(path.join(outside, 'settings.json'), 'utf8'), 'outside sentinel');
});

test('clip reader accepts multilingual HTML at the existing character limit across split bytes', async () => {
  const text = '界'.repeat(MAX_CLIP_CHARACTERS);
  const bytes = Buffer.from(text);
  let offset = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, offset + 16385);
    controller.enqueue(bytes.subarray(offset, end)); offset = end;
  } });
  assert.equal(await readClippableHtml(htmlResponse(stream)), text);
});

test('clip reader cancels chunked overflow without trusting Content-Length', async () => {
  let pulls = 0, canceled = false;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(Buffer.alloc(65536, 65)); }, cancel() { canceled = true; } });
  const response = htmlResponse(stream);
  response.headers.set('Content-Length', '12');
  await assert.rejects(readClippableHtml(response), /too large/);
  assert.equal(canceled, true);
  assert.ok(pulls < 35);
});

test('clip reader bounds decompressed content and cancels rejected response bodies', async () => {
  const compressed = gzipSync(Buffer.alloc(MAX_CLIP_CHARACTERS + 100, 65));
  const decoded = Readable.toWeb(Readable.from([compressed]).pipe(createGunzip()));
  await assert.rejects(readClippableHtml(htmlResponse(decoded)), /too large/);
  let canceled = false;
  const response = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'Content-Type': 'application/octet-stream' } });
  await assert.rejects(readClippableHtml(response), /did not return HTML/);
  assert.equal(canceled, true);
});

test('research exports omit receipt source paths in both formats, including migrated catalog rows', async t => {
  const root = await temporaryRoot(t);
  const source = await fs.readFile(new URL('../src/researchReport.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { buildResearchReport } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const receipt = (field, value) => `\`\`\`safire-evidence\nid: "sample"\nclaim: "Public claim"\nsource_type: "local_file"\n${field}: "${value}"\nstatus: "verified"\nprivate_notes: "private-canary"\n\`\`\``;
  for (const [index, field] of ['source', 'source_url', 'source_url_or_path'].entries()) {
    await fs.writeFile(path.join(root, `Evidence${index}.md`), `# Evidence\n\n${receipt(field, 'C:/PrivateFolder/LocalSentinel.pdf')}\n\nUseful ordinary prose.`);
  }
  await fs.writeFile(path.join(root, 'Public.md'), '# Public\n\n' + receipt('source', 'https://example.com/research'));
  await fs.writeFile(path.join(root, 'Compact.md'), '# Heading\nProse without blank separators.\n' + receipt('source', 'C:/PrivateFolder/Compact.pdf'));
  await fs.writeFile(path.join(root, 'Quoted.md'), '# Heading\n\n' + receipt('source', 'C:/PrivateFolder/Quoted.pdf').split('\n').map(line => `> ${line}`).join('\n') + '\n\nQuoted receipt prose.');
  await fs.writeFile(path.join(root, 'Unclosed.md'), '# Heading\n\n```safire-evidence\nsource: "C:/PrivateFolder/Unclosed.pdf"');
  let catalog = await createVaultCatalog(root);
  await catalog.page();
  await catalog.close();
  const db = new DatabaseSync(path.join(root, '.safire', 'catalog', 'notes-v1.sqlite'));
  for (const row of db.prepare('SELECT path, fingerprint, metadata FROM notes').all()) {
    const metadata = JSON.parse(row.metadata);
    delete metadata.reportExcerpt;
    metadata.excerpt = 'C:/PrivateFolder/OldCacheSentinel.pdf';
    db.prepare('UPDATE notes SET fingerprint=?, metadata=? WHERE path=?').run(row.fingerprint.replace('projection-3:', 'projection-2:'), JSON.stringify(metadata), row.path);
  }
  db.close();
  catalog = await createVaultCatalog(root);
  try {
    const notes = (await catalog.page()).notes;
    const report = buildResearchReport(notes, '<Review>', 'Our conclusion.', 'September 6, 2026');
    for (const output of [report.markdown, report.html]) {
      assert.doesNotMatch(output, /PrivateFolder|LocalSentinel|OldCacheSentinel|private-canary/);
      assert.match(output, /Useful ordinary prose/);
      assert.match(output, /Prose without blank separators/);
      assert.match(output, /Quoted receipt prose/);
      assert.match(output, /Public claim/);
      assert.match(output, /https:\/\/example.com\/research/);
    }
    assert.match(report.html, /&lt;Review&gt;/);
    assert.equal((await catalog.page({ query: 'LocalSentinel' })).total, 3, 'Local source search remains available in the private app');
    const missingSafeExcerpt = buildResearchReport([{ ...notes[0], reportExcerpt: undefined, excerpt: 'unsafe fallback' }], 'Brief', '', 'Today');
    assert.doesNotMatch(missingSafeExcerpt.markdown, /unsafe fallback/);
  } finally { await catalog.close(); }
});
