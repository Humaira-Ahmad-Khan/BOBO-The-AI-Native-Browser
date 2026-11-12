'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { HistoryService, historyUrl, RANGES } = require('../../src/main/history');

test('history strips known secrets while preserving ordinary navigation metadata', () => {
  assert.equal(historyUrl('https://example.test/?q=a%20b&access_token=secret&code=123#access_token=secret'),
    'https://example.test/?q=a+b');
  assert.equal(historyUrl('https://example.test/?q=a%20b#section'), 'https://example.test/?q=a%20b#section');
  assert.throws(() => historyUrl('javascript:alert(1)'), /invalid url/);
});

test('history clearing rejects missing and inherited range names before opening the database', () => {
  const service = new HistoryService({ store: { open() { assert.fail('opened database'); } } });
  for (const range of [undefined, 'constructor', '__proto__', 'bogus']) {
    assert.throws(() => service.clear({ range }), /unknown history range/);
  }
  assert.equal(RANGES.month / RANGES.day, 28);
});
