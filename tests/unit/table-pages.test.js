'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectTablePages } = require('../../src/main/tools/table-pages');
const url = 'https://fixture.test/table';
const contents = { isDestroyed: () => false, getURL: () => url };
const page = { detected: true, columns: ['Connection No.'], rows: [['99010001']], rowCount: 1,
  totalRecords: 1, totalPages: 1, rangeStart: null, rangeEnd: null };
const options = { scope: 'all', url, columns: page.columns };

test('an unreadable existing paginator never becomes a successful one-page all export', async () => {
  await assert.rejects(() => collectTablePages(contents, async () => ({ ...page, paginationDetected: true }), options), /page counter could not be read/);
});
test('a genuinely unpaginated table exports once', async () => {
  const result = await collectTablePages(contents, async () => page, options);
  assert.equal(result.pagesCollected, 1);
  assert.deepEqual(result.rows, page.rows);
});
test('a range beyond an unpaginated table is rejected', async () => {
  await assert.rejects(() => collectTablePages(contents, async () => page, { ...options, scope: 'range', from: 1, to: 5 }), /Only one page/);
});
test('changed source URLs and malformed ranges are rejected', async () => {
  await assert.rejects(() => collectTablePages(contents, async () => page, { ...options, url: 'https://other.test' }), /navigated/);
  await assert.rejects(() => collectTablePages(contents, async () => page, { ...options, from: 5, to: 1 }), /invalid export options/);
});
