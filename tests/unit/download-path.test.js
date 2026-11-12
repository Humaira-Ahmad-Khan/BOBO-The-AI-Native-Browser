'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { reserveDownloadPath } = require('../../src/main/downloads');

test('automatic download destinations preserve files and reserve distinct safe names', (t) => {
  const directory = fs.mkdtempSync(path.join(__dirname, 'download-path-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const existing = path.join(directory, 'document.pdf');
  fs.writeFileSync(existing, 'original');
  assert.equal(path.basename(reserveDownloadPath(directory, 'document.pdf')), 'document (1).pdf');
  assert.equal(path.basename(reserveDownloadPath(directory, 'document.pdf')), 'document (2).pdf');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'original');
  assert.equal(path.basename(reserveDownloadPath(directory, 'COM1.pdf')), '_COM1.pdf');
  assert.equal(path.dirname(reserveDownloadPath(directory, '../outside.pdf')), fs.realpathSync(directory));
  assert.throws(() => reserveDownloadPath('.', 'document.pdf'), /invalid download directory/);
});
