'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { browserUserAgent } = require('../../src/main/browser-user-agent');

test('browsing identity keeps the installed Chromium version and removes application tokens', () => {
  const chromium = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36';
  assert.equal(browserUserAgent(chromium + ' bobo/0.1.1 Electron/45.2.1', 'bobo'), chromium);
  assert.equal(browserUserAgent(chromium + ' My.Browser/1 Electron/45', 'My.Browser'), chromium);
  assert.equal(browserUserAgent(chromium, 'bobo'), chromium);
});
