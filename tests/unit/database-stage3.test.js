'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { Store, MIGRATIONS, databaseError, validateDatabaseFile } = require('../../src/main/db');
const { makeBackup, restoreBackup } = require('../../src/main/database-backup');
const { BookmarksService } = require('../../src/main/bookmarks');
const { DownloadsService } = require('../../src/main/downloads');

function fixture(t) {
  const root = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'stage3-'));
  const store = new Store({ file: path.join(dir, 'profile', 'bobo.db') });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store };
}

function seed(store, title) {
  store.open().prepare('INSERT INTO history (url, title, visited_at) VALUES (?, ?, ?)')
    .run('https://fixture.test/', title, 1);
}

function titles(store) {
  return store.open().prepare('SELECT title FROM history ORDER BY id').all().map((row) => row.title);
}

test('bookmark preview counts invalid and duplicate entries without writing', (t) => {
  const { store } = fixture(t);
  const service = new BookmarksService({ store });
  const html = '<DL><H3>Favorites bar</H3><DL><H3>Work</H3><DL>' +
    '<A HREF="https://fixture.test/">Work</A><A HREF="https://fixture.test/">Duplicate</A>' +
    '<A HREF="javascript:alert(1)">Bad</A><script><A HREF="https://script.test/">Ignore</A></script></DL></DL></DL>';
  assert.deepEqual(service.previewImport(html), { bookmarks: 2, folders: 2, invalid: 1, duplicates: 1 });
  assert.equal(service.list().bookmarks.length, 0);
  assert.deepEqual(service.importHtml({ html }), { ok: true, added: 1, skipped: 1, folders: 1 });
  assert.equal(service.list().bookmarks.length, 1);
});

test('matching import order restores a mixed bookmark and folder sequence without duplicating records', (t) => {
  const { store } = fixture(t);
  const service = new BookmarksService({ store });
  const folder = service.addFolder({ name: 'Work' });
  const first = service.add({ url: 'https://fixture.test/first', title: 'First' });
  const last = service.add({ url: 'https://fixture.test/last', title: 'Last' });
  const html = '<DL><H3>Bookmarks bar</H3><DL><A HREF="https://fixture.test/first">First</A>' +
    '<H3>Work</H3><DL></DL><A HREF="https://fixture.test/last">Last</A></DL></DL>';
  assert.deepEqual(service.importHtml({ html, matchOrder: true }), { ok: true, added: 0, skipped: 2, folders: 0 });
  const list = service.list();
  const sequence = [...list.folders.filter((entry) => entry.parentId === 1), ...list.bookmarks]
    .sort((a, b) => a.position - b.position);
  assert.deepEqual(sequence.map((entry) => entry.id), [first.id, folder.id, last.id]);
});

function legacy(file, version) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  for (const step of MIGRATIONS) if (step.version <= version) db.exec(step.sql);
  db.exec(`PRAGMA user_version = ${version}`);
  return db;
}

test('new, existing v3, invalid path, future schema and corrupt file are handled without replacement', (t) => {
  const { dir, store } = fixture(t);
  seed(store, 'persisted');
  store.close();
  assert.deepEqual(titles(store), ['persisted']);
  assert.equal(store.open().prepare('PRAGMA user_version').get().user_version, 3);
  const bad = path.join(dir, 'bad.sqlite');
  fs.writeFileSync(bad, 'fixture damaged file');
  assert.throws(() => new Store({ file: bad }).open(), { code: 'BOBO_DB_CORRUPT' });
  assert.equal(fs.readFileSync(bad, 'utf8'), 'fixture damaged file');
  assert.throws(() => new Store({ file: dir }).open(), { code: 'BOBO_DB_PATH' });
  const future = path.join(dir, 'future.sqlite');
  legacy(future, 4).close();
  const bytes = fs.readFileSync(future);
  assert.throws(() => new Store({ file: future }).open(), { code: 'BOBO_NEWER_DB' });
  assert.deepEqual(fs.readFileSync(future), bytes);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes('.corrupt-')), false);
  const missing = path.join(dir, 'previous.sqlite');
  fs.writeFileSync(missing + '.corrupt-old', 'older recovery file');
  assert.throws(() => new Store({ file: missing }).open(), { code: 'BOBO_DB_RESTORE' });
  assert.equal(fs.existsSync(missing), false);
});

test('error categories are redacted and an invalid legacy schema is preserved', (t) => {
  const { store } = fixture(t);
  for (const [input, code] of [
    [{ errcode: 8 }, 'BOBO_DB_PERMISSION'], [{ code: 'ENOSPC' }, 'BOBO_DB_FULL'],
    [{ errcode: 266 }, 'BOBO_DB_IO'], [{ errcode: 5 }, 'BOBO_DB_LOCKED'],
  ]) {
    const result = databaseError({ ...input, message: 'sensitive data' });
    assert.equal(result.code, code);
    assert.doesNotMatch(result.message, /sensitive data/);
  }
  const db = legacy(store.file, 1);
  db.exec('CREATE TABLE sqliteExtra (value TEXT)');
  db.close();
  const original = fs.readFileSync(store.file);
  assert.throws(() => store.open(), { code: 'BOBO_DB_SCHEMA' });
  assert.deepEqual(fs.readFileSync(store.file), original);
});

test('legacy migration keeps IDs, creates one validated backup, and never reruns', (t) => {
  const { store } = fixture(t);
  const db = legacy(store.file, 1);
  db.prepare('INSERT INTO history(id, url, title, visited_at) VALUES (?, ?, ?, ?)')
    .run(42, 'https://fixture.test/', 'legacy', 1);
  db.close();
  assert.equal(store.open().prepare('SELECT id FROM history').get().id, 42);
  store.close();
  assert.equal(store.open().prepare('PRAGMA user_version').get().user_version, 3);
  const dirs = fs.readdirSync(path.dirname(store.file)).filter((name) => name.startsWith('migration-backup-'));
  assert.equal(dirs.length, 1);
  validateDatabaseFile(path.join(path.dirname(store.file), dirs[0], 'bobo.db'), 1);
});

test('failed migration rolls back the entire schema update', (t) => {
  const { store } = fixture(t);
  const db = legacy(store.file, 1);
  db.exec("INSERT INTO history VALUES (42, 'https://fixture.test/', 'legacy', 1)");
  db.close();
  const step = MIGRATIONS[2];
  const sql = step.sql;
  try {
    step.sql += '\nINSERT INTO missing_fixture_table VALUES (1);';
    assert.throws(() => store.open(), { code: 'BOBO_DB_MIGRATION' });
  } finally { step.sql = sql; }
  const reopened = new DatabaseSync(store.file, { readOnly: true });
  try {
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(reopened.prepare('SELECT id FROM history').get().id, 42);
    assert.equal(reopened.prepare("SELECT name FROM sqlite_schema WHERE name = 'bills_jobs'").get(), undefined);
  } finally { reopened.close(); }
});

test('cross-process write lock fails without replacing database and rolls back a failed transaction', async (t) => {
  const { store } = fixture(t);
  seed(store, 'existing');
  const child = spawn(process.execPath, ['-e', `
    const db = new (require('node:sqlite').DatabaseSync)(process.argv[1]);
    db.exec('BEGIN IMMEDIATE'); console.log('locked'); process.stdin.resume();
  `, store.file], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  const started = performance.now();
  assert.throws(() => store.transaction(() => {}), { code: 'BOBO_DB_LOCKED' });
  t.diagnostic(`Lock contention blocked a synchronous write for ${Math.round(performance.now() - started)} ms`);
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.throws(() => store.transaction((db) => {
    db.exec("INSERT INTO history VALUES (99, 'https://fixture.test/', 'rolled back', 1)");
    throw new Error('fixture failure');
  }), /fixture failure/);
  assert.deepEqual(titles(store), ['existing']);
});

test('native backup captures WAL writes, and restore confirms and preserves the previous database', async (t) => {
  const { dir, store } = fixture(t);
  const empty = await makeBackup(store, dir);
  validateDatabaseFile(empty.file);
  seed(store, 'at backup');
  assert.ok(fs.statSync(store.file + '-wal').size > 0);
  const snapshot = await makeBackup(store, dir);
  seed(store, 'after backup');
  assert.deepEqual(await restoreBackup(store, snapshot.file, async () => false), { canceled: true });
  assert.deepEqual(titles(store), ['at backup', 'after backup']);
  const result = await restoreBackup(store, snapshot.file, async (metadata) => metadata.version === 3);
  assert.throws(() => store.open(), { code: 'BOBO_DB_RESTORE' });
  const restarted = new Store({ file: store.file });
  try { assert.deepEqual(titles(restarted), ['at backup']); }
  finally { restarted.close(); }
  const before = new DatabaseSync(result.rollback, { readOnly: true });
  try { assert.equal(before.prepare('SELECT count(*) AS n FROM history').get().n, 2); }
  finally { before.close(); }
});

test('invalid destinations and cancellation leave the original database intact', async (t) => {
  const { dir, store } = fixture(t);
  seed(store, 'existing');
  await assert.rejects(makeBackup(store, path.join(dir, 'missing')), { code: 'BOBO_DB_PATH' });
  await assert.rejects(makeBackup(store, dir, { signal: AbortSignal.abort() }), { code: 'BOBO_DB_CANCELLED' });
  const fsp = require('node:fs/promises');
  const copy = fsp.copyFile;
  fsp.copyFile = async () => { throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' }); };
  try { await assert.rejects(makeBackup(store, dir), { code: 'BOBO_DB_FULL' }); }
  finally { fsp.copyFile = copy; }
  assert.deepEqual(titles(store), ['existing']);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.sqlite')), false);
});

test('read-only validation never writes and SQLite rejects writes on a read-only connection', (t) => {
  const { store } = fixture(t);
  seed(store, 'existing');
  store.close();
  const before = fs.readFileSync(store.file);
  validateDatabaseFile(store.file);
  const db = new DatabaseSync(store.file, { readOnly: true });
  try {
    assert.throws(() => db.exec('DELETE FROM history'), (error) =>
      databaseError(error).code === 'BOBO_DB_PERMISSION');
  } finally { db.close(); }
  assert.deepEqual(fs.readFileSync(store.file), before);
});

test('bookmark and completed download IDs survive closing and reopening the store', (t) => {
  const { store } = fixture(t);
  const bookmarks = new BookmarksService({ store });
  const downloads = new DownloadsService({ store });
  const bookmark = bookmarks.add({ url: 'https://fixture.test/bookmark', title: 'Fixture bookmark' });
  const download = downloads.start({ url: 'https://fixture.test/file.pdf', filename: 'file.pdf', totalBytes: 10 });
  downloads.finish(download.id, { state: 'completed', received: 10 });
  store.close();
  assert.equal(bookmarks.findByUrl('https://fixture.test/bookmark').id, bookmark.id);
  assert.equal(downloads.get(download.id).state, 'completed');
});

test('interrupted legacy transaction rolls back before migration', (t) => {
  const { store } = fixture(t);
  legacy(store.file, 1).close();
  const { spawnSync } = require('node:child_process');
  const interrupted = spawnSync(process.execPath, ['-e', `
    const db = new (require('node:sqlite').DatabaseSync)(process.argv[1]);
    db.exec("BEGIN IMMEDIATE; CREATE TABLE interrupted_fixture (value TEXT); INSERT INTO history VALUES(11, 'https://fixture.test', 'uncommitted', 1)");
    process.exit(27);
  `, store.file], { windowsHide: true });
  assert.equal(interrupted.status, 27);
  assert.deepEqual(titles(store), []);
  assert.equal(store.open().prepare('PRAGMA user_version').get().user_version, 3);
});

test('measures reads and transactions on a large disposable profile', (t) => {
  const { store } = fixture(t);
  const db = store.open();
  const start = performance.now();
  store.transaction(() => {
    const history = db.prepare('INSERT INTO history (url, title, visited_at) VALUES (?, ?, ?)');
    const bookmark = db.prepare('INSERT INTO bookmarks (folder_id, url, title, created_at, updated_at) VALUES (1, ?, ?, ?, ?)');
    const bill = db.prepare("INSERT INTO bills_queue (job_id, connection_no, updated_at) VALUES (1, ?, ?)");
    db.exec("INSERT INTO bills_jobs (id, name, created_at) VALUES (1, 'synthetic job', 1)");
    for (let i = 0; i < 30000; i++) history.run(`https://fixture.test/${i}`, 'fixture', i);
    for (let i = 0; i < 5000; i++) bookmark.run(`https://fixture.test/${i}`, 'fixture', i, i);
    for (let i = 0; i < 15000; i++) bill.run(String(i), i);
  });
  const writeMs = performance.now() - start;
  const beginReads = performance.now();
  const page = db.prepare('SELECT id FROM history ORDER BY visited_at DESC LIMIT 100');
  const counts = db.prepare('SELECT count(*) AS n FROM bills_queue WHERE job_id = 1');
  for (let i = 0; i < 50; i++) {
    assert.equal(page.all().length, 100);
    assert.equal(counts.get().n, 15000);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM bookmarks').get().n, 5000);
  t.diagnostic(`50,000 inserts in one transaction: ${Math.round(writeMs)} ms; 50 bounded history reads plus bill counts: ${Math.round(performance.now() - beginReads)} ms`);
});

test('restore rejects forged, incompatible and invalid backups before confirmation', async (t) => {
  const { dir, store } = fixture(t);
  seed(store, 'existing');
  const snapshot = await makeBackup(store, dir);
  const manifest = JSON.parse(fs.readFileSync(snapshot.manifestPath, 'utf8'));
  const confirm = async () => { assert.fail('invalid backup reached confirmation'); };
  fs.appendFileSync(snapshot.file, 'modified');
  await assert.rejects(restoreBackup(store, snapshot.file, confirm), { code: 'BOBO_DB_MANIFEST' });
  fs.writeFileSync(snapshot.manifestPath, JSON.stringify({ ...manifest, version: 99 }));
  await assert.rejects(restoreBackup(store, snapshot.file, confirm), { code: 'BOBO_DB_MANIFEST' });
  const invalid = path.join(dir, 'invalid.sqlite');
  const seal = () => fs.writeFileSync(invalid + '.json', JSON.stringify({
    ...manifest, sha256: createHash('sha256').update(fs.readFileSync(invalid)).digest('hex'),
  }));
  fs.writeFileSync(invalid, 'not SQLite');
  seal();
  await assert.rejects(restoreBackup(store, invalid, confirm), { code: 'BOBO_DB_CORRUPT' });
  fs.unlinkSync(invalid);
  let db = legacy(invalid, 3);
  db.exec('DROP TABLE sectors');
  db.close();
  seal();
  await assert.rejects(restoreBackup(store, invalid, confirm), { code: 'BOBO_DB_SCHEMA' });
  fs.unlinkSync(invalid);
  db = legacy(invalid, 3);
  db.exec("PRAGMA foreign_keys = OFF; INSERT INTO saved_group_tabs VALUES (1, 999, 'https://fixture.test', '', 0)");
  db.close();
  seal();
  await assert.rejects(restoreBackup(store, invalid, confirm), { code: 'BOBO_DB_INTEGRITY' });
  assert.deepEqual(titles(store), ['existing']);
});

test('failed replacement rolls back, and an interrupted restore blocks automatic creation', async (t) => {
  const { dir, store } = fixture(t);
  seed(store, 'existing');
  const snapshot = await makeBackup(store, dir);
  seed(store, 'keep this');
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === store.file && source.includes('restore-stage-')) {
      throw Object.assign(new Error('fixture replacement denied'), { code: 'EPERM' });
    }
    return rename(source, target);
  };
  try {
    await assert.rejects(restoreBackup(store, snapshot.file, async () => true), { code: 'BOBO_DB_PERMISSION' });
  } finally { fs.renameSync = rename; }
  assert.deepEqual(titles(store), ['existing', 'keep this']);
  const missing = path.join(dir, 'interrupted.sqlite');
  fs.writeFileSync(missing + '.restore-in-progress', 'fixture interruption');
  assert.throws(() => new Store({ file: missing }).open(), { code: 'BOBO_DB_RESTORE' });
  assert.equal(fs.existsSync(missing), false);
});
