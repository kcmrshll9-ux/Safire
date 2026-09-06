import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertContainedPath } from './note-mutations.mjs';
import { readBoundedIndexNote } from './graph-policy.mjs';
import { genericIndexContent, withoutFencedContent, publicNoteMetadata, parseEvidenceReceipts, publicEvidenceContent } from './note-projection.mjs';

export const CATALOG_LIMITS = Object.freeze({ notes: 100_000, entries: 250_000, depth: 64, indexedBytes: 256 * 1024 * 1024, page: 500 });
const slash = value => value.replace(/\\/g, '/');
const escapeLike = value => value.replace(/[\\%_]/g, match => `\\${match}`);

// Markdown remains authoritative. This private database can always be rebuilt.
// The catalog has its own bounded, incremental scan; legacy response and graph
// limits are intentionally independent of searchable vault size.
export async function createVaultCatalog(vault) {
  const directory = path.join(vault, '.safire', 'catalog');
  await assertContainedPath(vault, directory, { allowMissing: true });
  await fs.mkdir(directory, { recursive: true });
  await assertContainedPath(vault, directory);
  const filename = path.join(directory, 'notes-v1.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) await assertContainedPath(vault, filename + suffix, { allowMissing: true });
  let db;
  let cacheWarning = '';
  const initialize = database => database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS notes(path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL, metadata TEXT NOT NULL, seen INTEGER NOT NULL);`);
  try { db = new DatabaseSync(filename); initialize(db); }
  catch (error) {
    try { db?.close(); } catch { /* An unopened database has nothing to close. */ }
    if (![11, 26].includes(error.errcode)) throw error;
    // A damaged disposable index must never make the user's Markdown unavailable.
    db = new DatabaseSync(':memory:'); initialize(db);
    cacheWarning = 'The disk index is damaged. Search has been rebuilt in memory for this session.';
  }
  const find = db.prepare('SELECT fingerprint FROM notes WHERE path = ?');
  const touch = db.prepare('UPDATE notes SET seen = ? WHERE path = ?');
  const upsert = db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint,body=excluded.body,metadata=excluded.metadata,seen=excluded.seen');
  let scanning = null;
  let lastScan = 0;
  let state = { complete: false, omittedContent: 0, observedNotes: 0, reason: 'Indexing your vault' };
  let closed = false;

  async function scanContents() {
    const seen = db.prepare('SELECT coalesce(max(seen), 0) + 1 AS next FROM notes').get().next;
    let count = 0, entries = 0, bytes = 0, omitted = 0;
    let complete = true;
    const directories = [{ absolute: vault, depth: 0 }];
    scanLoop: while (directories.length) {
      const { absolute, depth } = directories.pop();
      let handle;
      try { await assertContainedPath(vault, absolute); handle = await fs.opendir(absolute); }
      catch { complete = false; continue; }
      for await (const entry of handle) {
        if (closed) return;
        if (++entries > CATALOG_LIMITS.entries) { complete = false; break scanLoop; }
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const file = path.join(absolute, entry.name);
        const relative = slash(path.relative(vault, file));
        if (relative.length > 1024) { complete = false; continue; }
        if (entry.isDirectory()) {
          if (depth >= CATALOG_LIMITS.depth) { complete = false; continue; }
          directories.push({ absolute: file, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
        if (++count > CATALOG_LIMITS.notes) { complete = false; break scanLoop; }
        try {
          await assertContainedPath(vault, file);
          const stat = await fs.stat(file);
          bytes += Math.min(stat.size, 1024 * 1024);
          const contentAllowed = stat.size <= 1024 * 1024 && bytes <= CATALOG_LIMITS.indexedBytes;
          if (!contentAllowed) omitted++;
          const fingerprint = `projection-3:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${contentAllowed}`;
          if (find.get(relative)?.fingerprint === fingerprint) touch.run(seen, relative);
          else {
            const indexed = contentAllowed ? await readBoundedIndexNote(fs, file) : null;
            const content = indexed?.content || '';
            const metadata = publicNoteMetadata(content);
            const body = genericIndexContent(content);
            const receipts = parseEvidenceReceipts(publicEvidenceContent(content), relative, { limit: 65, includePrivate: false });
            const summary = body.split(/\n\s*\n/).find(paragraph=>paragraph.trim() && !/^\s*#/.test(paragraph)) || body;
            const prose = withoutFencedContent(content).split(/\r?\n/).filter(line => !/^\s{0,3}#{1,6}(?:\s|$)/.test(line)).join('\n');
            const reportSummary = prose.split(/\n\s*\n/).find(paragraph => paragraph.trim() && !/^\s*#/.test(paragraph)) || '';
            const record = { path: relative, title: path.basename(relative, '.md'), folder: slash(path.dirname(relative)) === '.' ? '' : slash(path.dirname(relative)),
              size: stat.size, mtime: stat.mtimeMs, tags: metadata.tags.slice(0,32).map(value=>value.slice(0,1024)), links: metadata.links.slice(0,128).map(value=>value.slice(0,1024)),
              reportExcerpt: reportSummary.replace(/\s+/g, ' ').slice(0, 220),
              excerpt: summary.replace(/\s+/g,' ').slice(0,220), contentOmitted: !contentAllowed || !!indexed?.contentOmitted,
              evidence: receipts.slice(0,64).map(r => Object.fromEntries(Object.entries({ id: r.id, claim: r.claim, source: r.source, sourceType: r.sourceType, status: r.status, observedAt: r.observedAt, freshness: r.freshness, expired: r.expired }).map(([key,value])=>[key, typeof value === 'string' ? value.slice(0,1024) : value]))) };
            upsert.run(relative, fingerprint, body, JSON.stringify(record), seen);
          }
        } catch (error) {
          if (error.code === 'ENOENT') db.prepare('DELETE FROM notes WHERE path = ?').run(relative);
          else { complete = false; omitted++; }
        }
        if (count % 64 === 0) await new Promise(resolve => setImmediate(resolve));
      }
    }
    // Unseen records must never linger as apparently current search results.
    // A bounded partial scan deliberately exposes only this observed snapshot.
    db.prepare('DELETE FROM notes WHERE seen <> ?').run(seen);
    state = { complete, omittedContent: omitted, observedNotes: Math.min(count, CATALOG_LIMITS.notes),
      reason: [cacheWarning, !complete ? 'The catalog reached a scan limit or an unreadable folder. Some files are not indexed.' : omitted ? 'Some large or unreadable note bodies were omitted. Their filenames remain searchable.' : ''].filter(Boolean).join(' ') };
    lastScan = Date.now();
  }

  async function scan() {
    // One SQLite transaction makes a refresh atomic for other app processes
    // and avoids a disk commit for every discovered file.
    db.exec('BEGIN IMMEDIATE');
    try { await scanContents(); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  async function refresh(force = false) {
    if (closed) throw new Error('Catalog is closed');
    if (!scanning && (force || Date.now() - lastScan > 3000)) {
      scanning = scan().finally(() => { scanning = null; });
    }
    if (scanning) await scanning;
    return state;
  }

  return {
    refresh,
    invalidate() { lastScan = 0; },
    async page({ query = '', project = '', offset = 0, limit = 200, evidenceOnly = false } = {}) {
      await refresh();
      query = String(query).trim().slice(0,500);
      project = String(project).replace(/\/$/,'');
      offset = Math.trunc(Math.max(0, Math.min(CATALOG_LIMITS.notes, Number(offset) || 0)));
      limit = Math.trunc(Math.max(1,Math.min(CATALOG_LIMITS.page,Number(limit)||200)));
      const terms = [];
      const filters = [];
      for (const term of query.split(/\s+/).filter(Boolean)) {
        const match = term.match(/^(status|source|state|after|before|from|to|expired):(.*)$/i);
        if (match) filters.push([match[1].toLowerCase(),match[2].toLowerCase()]);
        else if (term === 'expired') filters.push(['expired','true']);
        else terms.push(term);
      }
      const clauses = [];
      const args = [];
      if (project) { clauses.push("path LIKE ? ESCAPE '\\'"); args.push(escapeLike(project) + '/%'); }
      for (const term of terms) { clauses.push("(path LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')"); args.push('%'+escapeLike(term)+'%','%'+escapeLike(term)+'%'); }
      if (evidenceOnly) clauses.push("json_array_length(metadata, '$.evidence') > 0");
      const receiptClauses = [];
      for (const [key,value] of filters) {
        if (key === 'expired') {
          if (!['true','false'].includes(value)) throw new Error('Use expired:true or expired:false');
          receiptClauses.push(`coalesce(julianday(json_extract(value, '$.freshness')) <= julianday('now'), 0) = ${value === 'true' ? 1 : 0}`);
          continue;
        }
        if (['after','before','from','to'].includes(key)) {
          if (!Number.isFinite(Date.parse(value))) throw new Error('Use an ISO date in date filters');
          const operator = key === 'after' || key === 'from' ? '>=' : '<=';
          receiptClauses.push(`julianday(json_extract(value, '$.observedAt')) ${operator} julianday(?)`);
          args.push(value); continue;
        }
        const field = key === 'source' ? 'sourceType' : key === 'state' ? 'status' : key;
        receiptClauses.push(`lower(CAST(json_extract(value, '$.${field}') AS TEXT)) = ?`);
        args.push(key === 'expired' ? '1' : value);
      }
      if (receiptClauses.length) clauses.push(`EXISTS (SELECT 1 FROM json_each(notes.metadata, '$.evidence') WHERE ${receiptClauses.join(' AND ')})`);
      const where = clauses.length ? 'WHERE '+clauses.join(' AND ') : '';
      const total = db.prepare(`SELECT count(*) AS n FROM notes ${where}`).get(...args).n;
      const rows = db.prepare(`SELECT metadata FROM notes ${where} ORDER BY path COLLATE NOCASE LIMIT ? OFFSET ?`).all(...args,limit,offset);
      const notes = []; let responseBytes = 0;
      for (const row of rows) {
        const size = Buffer.byteLength(row.metadata);
        if (responseBytes + size > 1_500_000) break;
        const note = JSON.parse(row.metadata);
        for (const receipt of note.evidence) receipt.expired = Number.isFinite(Date.parse(receipt.freshness)) && Date.parse(receipt.freshness) <= Date.now();
        notes.push(note); responseBytes += size;
      }
      return { notes, total, offset, nextOffset: offset + notes.length < total ? offset + notes.length : null, ...state };
    },
    async paths() { await refresh(true); return { paths: db.prepare('SELECT path FROM notes ORDER BY path').all().map(r=>r.path), ...state }; },
    async close() { if (closed) return; if (scanning) await scanning.catch(()=>{}); closed = true; db.close(); },
  };
}
