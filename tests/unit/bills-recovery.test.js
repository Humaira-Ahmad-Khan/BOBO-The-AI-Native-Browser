'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../../src/main/db');
const { BillsExtractionService, normalizeConnectionNumber, cleanConnectionNumber } = require('../../src/main/tools/bills');
const { formatCsv, parseCsvLine } = require('../../src/main/tools/export');

test('Spreadsheet IDs retain every digit and reject expressions', () => {
  for (const input of ['09010199', '=09010199', '="09010199"', "'09010199", ' "09010199" ']) {
    assert.equal(normalizeConnectionNumber(input), '09010199');
  }
  for (const input of ['=1+2', '=HYPERLINK("bad")', '-123', 'foo', '=']) {
    assert.throws(() => normalizeConnectionNumber(input));
  }
  assert.deepEqual(parseCsvLine(formatCsv(['Connection'], [['09010199']]).split('\r\n')[1]), ['09010199']);
});

test('Import cleans quotes, commas and portal annotations without losing digits', () => {
  const cases = [
    ['="03659"', '03659'],
    ['"03659"', '03659'],
    ["'03659", '03659'],
    ['"99,010,334"', '99010334'],
    ['99,010,334', '99010334'],
    ['99010334 B', '99010334'],
    ['98010010-A', '98010010'],
    ['82010169.', '82010169'],
    ['04010524 -', '04010524'],
    ['11020107A', '11020107'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeConnectionNumber(cleanConnectionNumber(input)), expected);
  }
  for (const input of ['foo', '=1+2', '-123', '12 34 56']) {
    assert.throws(() => normalizeConnectionNumber(cleanConnectionNumber(input)));
  }
});

test('One unusable row does not discard the rest of the import', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp', 'bills-partial-'));
  const store = new Store({ file: path.join(dir, 'test.db') });
  try {
    const service = new BillsExtractionService({ store });
    const job = service.createJob({
      connectionNumbers: ['03659', '99010334 B', 'foo', '98010010-A', '03659', '"99,010,334"'],
    });
    assert.equal(job.total, 3);
    assert.equal(job.invalidCount, 1);
    assert.deepEqual(job.invalidSamples, ['foo']);
    assert.deepEqual(service.getQueue(job.id).map((row) => row.connectionNo),
      ['03659', '99010334', '98010010']);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Exports a reusable connection list without empty results', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp', 'bills-export-'));
  const store = new Store({ file: path.join(dir, 'test.db') });
  try {
    const service = new BillsExtractionService({ store });
    const job = service.createJob({ connectionNumbers: ['001', '002', '003', '004'] });
    const [done, empty, failed] = service.getQueue(job.id);
    const db = store.open();
    db.prepare("UPDATE bills_queue SET status='completed' WHERE id=?").run(done.id);
    db.prepare("UPDATE bills_queue SET status='empty' WHERE id=?").run(empty.id);
    db.prepare("UPDATE bills_queue SET status='failed' WHERE id=?").run(failed.id);

    const nonEmpty = service.exportConnectionListCsv(job.id, 'non-empty');
    assert.equal(nonEmpty.count, 3);
    assert.match(nonEmpty.csv, /Connection No/);
    assert.match(nonEmpty.csv, /001/);
    assert.match(nonEmpty.csv, /003/);
    assert.match(nonEmpty.csv, /004/);
    assert.doesNotMatch(nonEmpty.csv, /002/);

    const emptyOnly = service.exportConnectionListCsv(job.id, 'empty');
    assert.equal(emptyOnly.count, 1);
    assert.match(emptyOnly.csv, /002/);
    assert.doesNotMatch(emptyOnly.csv, /001|003|004/);

    const failedOnly = service.exportConnectionListCsv(job.id, 'failed');
    assert.equal(failedOnly.count, 1);
    assert.match(failedOnly.csv, /003/);
    assert.doesNotMatch(failedOnly.csv, /001|002|004/);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Repair preserves 9,619 completed results, retries only affected misses and survives reopening', () => {
  const parent = path.join(__dirname, '.tmp');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'bills-repair-'));
  const file = path.join(dir, 'test.db');
  let store = new Store({ file });
  try {
    let service = new BillsExtractionService({ store });
    const job = service.createJob({ connectionNumbers: ['000001'] });
    const db = store.open();
    db.prepare('DELETE FROM bills_queue WHERE job_id = ?').run(job.id);
    store.transaction((db) => {
      const insert = db.prepare('INSERT INTO bills_queue (job_id, connection_no, status, consumer_info, bills_data, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (let i = 0; i < 17892; i++) {
        const done = i < 9619;
        const empty = i >= 11290;
        const number = String(i).padStart(8, '0');
        insert.run(job.id, !done && i % 2 === 0 ? '=' + number : number,
          done ? 'completed' : empty ? 'empty' : 'pending', done ? '{"sector":"Saved"}' : '', done ? '[["saved-bill"]]' : '', i);
      }
    });
    const completedBefore = db.prepare("SELECT * FROM bills_queue WHERE status = 'completed'").all();
    const result = service.repairSpreadsheetIds(job.id);
    assert.equal(result.requeued, 3301);
    assert.equal(result.job.completed, 9619);
    assert.equal(result.job.pending, 1671 + 3301);
    assert.deepEqual(db.prepare("SELECT * FROM bills_queue WHERE status = 'completed'").all(), completedBefore);
    assert.equal(service.getQueue(job.id, true).length, 10);
    assert.equal(service.repairSpreadsheetIds(job.id).repaired, 0);
    service.setRunning(job.id, true, 1);
    assert.throws(() => service.clearJob(job.id), /Stop this queue/);
    assert.throws(() => service.clearAllJobs(), /Stop this queue/);
    assert.throws(() => service.setRunning(job.id, false, 2), /another window/);
    service.setRunning(job.id, false, 1);
    store.close();
    store = new Store({ file });
    service = new BillsExtractionService({ store });
    assert.equal(service.getJob(job.id).pending, 4972);
    assert.equal(service.getJob(job.id).completed, 9619);
    service.clearAllJobs();
    assert.equal(service.listJobs().length, 0);
    assert.equal(store.open().prepare('SELECT COUNT(*) AS n FROM bills_queue').get().n, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Repair does not redo a connection already completed under its canonical ID', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp', 'bills-duplicate-'));
  const store = new Store({ file: path.join(dir, 'test.db') });
  try {
    const service = new BillsExtractionService({ store });
    const job = service.createJob({ connectionNumbers: ['001', '002', '003'] });
    const queue = service.getQueue(job.id);
    store.open().prepare("UPDATE bills_queue SET status='completed', bills_data='[[1]]' WHERE id=?").run(queue[0].id);
    store.open().prepare("UPDATE bills_queue SET connection_no='=001', status='empty' WHERE id=?").run(queue[1].id);
    store.open().prepare("UPDATE bills_queue SET connection_no='=003', status='failed' WHERE id=?").run(queue[2].id);
    const result = service.repairSpreadsheetIds(job.id);
    assert.equal(result.alreadyCompleted, 1);
    assert.equal(result.requeued, 1);
    assert.equal(service.getQueue(job.id)[1].status, 'skipped');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Export numbers every file, writes a per-sector summary and re-checks empties', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp', 'bills-summary-'));
  const store = new Store({ file: path.join(dir, 'test.db') });
  try {
    const service = new BillsExtractionService({ store });
    const job = service.createJob({ connectionNumbers: ['001', '002', '003', '2900776-A', '2900776'] });
    assert.equal(job.duplicateCount, 1);
    assert.equal(job.strippedCount, 1);
    const queue = service.getQueue(job.id);
    const db = store.open();
    const info = JSON.stringify({ sector: 'Mahboob Colony (SHARQI)' });
    db.prepare("UPDATE bills_queue SET status='completed', consumer_info=?, bills_data='[[1,2,3]]' WHERE id IN (?, ?)").run(info, queue[0].id, queue[2].id);
    db.prepare("UPDATE bills_queue SET status='empty' WHERE id=?").run(queue[1].id);
    const out = await service.exportHistoryFolder(job.id, dir, new Date(2026, 10, 8));
    const folder = path.join(out.directory, 'Mahboob Colony (SHARQI)');
    assert.deepEqual(fs.readdirSync(folder).sort(), ['001 - 001.csv', '003 - 003.csv']);
    assert.deepEqual(out.summary, { given: 4, completed: 2, empty: 1, failed: 0, pending: 1, skipped: 0 });
    const text = fs.readFileSync(path.join(out.directory, '_Export Summary.txt'), 'utf8');
    assert.match(text, /Mahboob Colony \(SHARQI\)\s+2\s+2/);
    assert.match(text, /still need a retry/);
    const second = service.createJob({ connectionNumbers: ['777'] });
    store.open().prepare("UPDATE bills_queue SET status='completed', consumer_info=?, bills_data='[[1]]' WHERE job_id=?").run(info, second.id);
    const both = await service.exportHistoryFolder([job.id, second.id], dir, new Date(2026, 10, 9));
    assert.deepEqual(both.summary.given, 5);
    assert.ok(fs.readdirSync(path.join(both.directory, 'Mahboob Colony (SHARQI)')).includes('005 - 777.csv'));
    assert.equal(service.retryEmpty(job.id).requeued, 1);
    assert.equal(service.getQueue(job.id)[1].status, 'pending');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
